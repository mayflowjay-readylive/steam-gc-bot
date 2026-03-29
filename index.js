const http = require("http");
const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");

// ─── Config ───
const PORT = process.env.PORT || 3000;
const STEAM_USERNAME = process.env.STEAM_USERNAME;
const STEAM_PASSWORD = process.env.STEAM_PASSWORD;
const STEAM_GUARD_CODE = process.env.STEAM_GUARD_CODE || ""; // Set this if Steam asks for email code
const RESOLVE_SECRET = process.env.RESOLVE_SECRET || "";
const REFRESH_TOKEN = process.env.STEAM_REFRESH_TOKEN || "";

if (!STEAM_USERNAME || !STEAM_PASSWORD) {
  console.error("STEAM_USERNAME and STEAM_PASSWORD env vars are required");
  process.exit(1);
}

// ─── Steam Client Setup ───
const client = new SteamUser({
  dataDirectory: null, // Don't cache credentials to avoid stale login conflicts
  autoRelogin: false,  // We handle reconnection ourselves
});
const csgo = new GlobalOffensive(client);

let isReady = false;
let isLoggedIn = false;
let isLoggingIn = false; // Guard against concurrent login attempts
let reconnectTimer = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 120000; // 2 minutes max

// ─── Share Code Decoder ───
function decodeMatchShareCode(code) {
  const DICTIONARY = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
  const stripped = code.replace("CSGO-", "").replace(/-/g, "");

  let big = BigInt(0);
  for (let i = stripped.length - 1; i >= 0; i--) {
    big = big * BigInt(57) + BigInt(DICTIONARY.indexOf(stripped[i]));
  }

  const bytes = [];
  for (let i = 0; i < 18; i++) {
    bytes.push(Number(big & BigInt(0xff)));
    big = big >> BigInt(8);
  }

  const swap = (arr) => {
    for (let i = 0; i < arr.length - 1; i += 2) {
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    }
    return arr;
  };

  const matchBytes = swap(bytes.slice(0, 8));
  const outcomeBytes = swap(bytes.slice(8, 16));
  const tokenBytes = bytes.slice(16, 18);

  const matchId = Buffer.from(matchBytes).readBigUInt64LE(0);
  const outcomeId = Buffer.from(outcomeBytes).readBigUInt64LE(0);
  const token = Buffer.from([tokenBytes[0], tokenBytes[1], 0, 0]).readUInt32LE(0);

  return {
    matchId: matchId.toString(),
    outcomeId: outcomeId.toString(),
    token: token,
  };
}

// ─── GC Match Info Request ───
function requestMatchInfo(matchId, outcomeId, token) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      csgo.removeListener("matchList", onMatch);
      reject(new Error("GC request timed out after 30 seconds"));
    }, 30000);

    function onMatch(data) {
      clearTimeout(timeout);
      csgo.removeListener("matchList", onMatch);

      console.log(`[GC Raw] matchList response: ${JSON.stringify(data).slice(0, 500)}`);

      if (!data || !data.matches || data.matches.length === 0) {
        reject(new Error("No match data returned from GC"));
        return;
      }

      const match = data.matches[0];
      const roundStats = match.roundstatsall || match.roundstats_legacy;

      let demoUrl = null;
      if (roundStats && roundStats.length > 0) {
        const lastRound = roundStats[roundStats.length - 1];
        demoUrl = lastRound.map || null;
      }

      if (!demoUrl && match.roundstats_legacy) {
        demoUrl = match.roundstats_legacy.map || null;
      }

      resolve({
        matchId: match.matchid?.toString(),
        matchTime: match.matchtime,
        demoUrl: demoUrl,
        matchDuration: match.match_duration,
        rawMatch: {
          matchtime: match.matchtime,
          matchDuration: match.match_duration,
          serverIp: match.server_ip,
          roundCount: roundStats ? roundStats.length : 0,
        },
      });
    }

    csgo.on("matchList", onMatch);
    console.log(`[GC] Calling requestGame(${matchId}, ${outcomeId}, ${token})`);
    csgo.requestGame(matchId, outcomeId, token);
  });
}

// ─── Steam Login (with guard) ───
function loginToSteam() {
  // Prevent concurrent login attempts
  if (isLoggingIn) {
    console.log("[Steam] Login already in progress, skipping");
    return;
  }

  isLoggingIn = true;
  console.log(`[Steam] Logging in as ${STEAM_USERNAME}...`);

  const loginOptions = {
    accountName: STEAM_USERNAME,
    password: STEAM_PASSWORD,
  };

  if (REFRESH_TOKEN) {
    console.log("[Steam] Using refresh token for login");
    loginOptions.refreshToken = REFRESH_TOKEN;
    delete loginOptions.accountName;
    delete loginOptions.password;
  }

  try {
    client.logOn(loginOptions);
  } catch (err) {
    console.error("[Steam] logOn threw:", err.message);
    isLoggingIn = false;
    scheduleReconnect("logOn exception");
  }
}

function scheduleReconnect(reason) {
  // Clear any existing timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectAttempt++;
  // Exponential backoff: 10s, 20s, 40s, 80s, 120s cap
  const delay = Math.min(10000 * Math.pow(2, reconnectAttempt - 1), MAX_RECONNECT_DELAY);

  console.log(`[Steam] Scheduling reconnect in ${delay / 1000}s (attempt ${reconnectAttempt}, reason: ${reason})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    loginToSteam();
  }, delay);
}

// ─── Steam Event Handlers ───

client.on("loggedOn", () => {
  console.log("[Steam] Logged in successfully");
  isLoggedIn = true;
  isLoggingIn = false;
  reconnectAttempt = 0; // Reset backoff on success

  client.setPersona(SteamUser.EPersonaState.Online);
  client.gamesPlayed([730]);

  // Actively grab the refresh token from the client object after a short delay
  // (the refreshToken event doesn't always fire reliably)
  setTimeout(() => {
    if (client.refreshToken) {
      console.log("[Steam] ═══════════════════════════════════════════");
      console.log("[Steam] REFRESH TOKEN (save as STEAM_REFRESH_TOKEN env var):");
      console.log(client.refreshToken);
      console.log("[Steam] ═══════════════════════════════════════════");
    } else {
      console.log("[Steam] No refresh token available on client object");
    }
  }, 5000);
});

client.on("refreshToken", (token) => {
  console.log("[Steam] ═══════════════════════════════════════════");
  console.log("[Steam] REFRESH TOKEN (save as STEAM_REFRESH_TOKEN env var):");
  console.log(token);
  console.log("[Steam] ═══════════════════════════════════════════");
});

client.on("steamGuard", (domain, callback, lastCodeWrong) => {
  if (lastCodeWrong) {
    console.error("[Steam] Last Steam Guard code was WRONG");
  }

  if (STEAM_GUARD_CODE) {
    console.log(`[Steam] Providing Steam Guard code from env var`);
    callback(STEAM_GUARD_CODE);
  } else {
    const source = domain ? `email ending in ${domain}` : "mobile authenticator";
    console.error(`[Steam] ═══════════════════════════════════════════`);
    console.error(`[Steam] STEAM GUARD CODE REQUIRED (${source})`);
    console.error(`[Steam] Set STEAM_GUARD_CODE env var and restart`);
    console.error(`[Steam] ═══════════════════════════════════════════`);
    // Don't schedule reconnect here — user action needed
    isLoggingIn = false;
  }
});

client.on("error", (err) => {
  console.error("[Steam] Client error:", err.message);
  isLoggedIn = false;
  isReady = false;
  isLoggingIn = false;

  // If refresh token is the problem, log a helpful hint
  if (REFRESH_TOKEN && (err.message.includes("InvalidPassword") || err.message.includes("AccessDenied") || err.message.includes("Expired"))) {
    console.error("[Steam] ═══════════════════════════════════════════");
    console.error("[Steam] Refresh token may be expired!");
    console.error("[Steam] Delete STEAM_REFRESH_TOKEN env var and redeploy");
    console.error("[Steam] ═══════════════════════════════════════════");
  }

  scheduleReconnect(err.message);
});

client.on("disconnected", (eresult, msg) => {
  console.warn(`[Steam] Disconnected: ${msg} (${eresult})`);
  isLoggedIn = false;
  isReady = false;
  isLoggingIn = false;
  scheduleReconnect("disconnected");
});

// ─── CS2 GC Event Handlers ───

csgo.on("connectedToGC", () => {
  console.log("[CS2 GC] Connected to Game Coordinator");
  isReady = true;
});

csgo.on("disconnectedFromGC", (reason) => {
  console.warn(`[CS2 GC] Disconnected from GC: ${reason}`);
  isReady = false;
});

csgo.on("error", (err) => {
  console.error("[CS2 GC] Error:", err);
});

// ─── Health Monitor ───
// Single simple check every 60s — only acts if nothing else is handling reconnection
const HEALTH_CHECK_INTERVAL = 60000;

setInterval(() => {
  if (!isLoggedIn && !isLoggingIn && !reconnectTimer) {
    console.log("[Monitor] Not logged in and no reconnect scheduled — forcing reconnect");
    scheduleReconnect("health monitor");
  }
}, HEALTH_CHECK_INTERVAL);

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/health") {
    const status = {
      ok: true,
      steamLoggedIn: isLoggedIn,
      gcReady: isReady,
      uptime: process.uptime(),
      reconnectAttempt: reconnectAttempt,
      isLoggingIn: isLoggingIn,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  // Diagnostic: test GC with recent games + test share code decode
  if (req.url === "/diag" && req.method === "GET") {
    if (!isReady) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GC not ready" }));
      return;
    }

    const testCode = "CSGO-6BSaF-wqbqG-HopwS-NB8kT-b8KeB";
    const decoded = decodeMatchShareCode(testCode);

    // Test requestRecentGames to see if GC responds at all
    const recentGamesPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        csgo.removeListener("matchList", handler);
        resolve({ status: "timeout", data: null });
      }, 15000);

      function handler(data) {
        clearTimeout(timeout);
        csgo.removeListener("matchList", handler);
        resolve({ status: "ok", data: JSON.stringify(data).slice(0, 1000) });
      }

      csgo.on("matchList", handler);
      csgo.requestRecentGames();
    });

    const recentResult = await recentGamesPromise;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      shareCodeTest: {
        input: testCode,
        decoded: decoded,
        matchIdLength: decoded.matchId.length,
        outcomeIdLength: decoded.outcomeId.length,
      },
      recentGames: recentResult,
      gcReady: isReady,
      steamLoggedIn: isLoggedIn,
    }, null, 2));
    return;
  }

  // Resolve share code → demo URL
  if (req.url === "/resolve" && req.method === "POST") {
    if (RESOLVE_SECRET) {
      const auth = req.headers["authorization"] || req.headers["x-resolve-secret"] || "";
      const token = auth.replace("Bearer ", "");
      if (token !== RESOLVE_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const { shareCode, matchId, outcomeId, token } = parsed;

    if (!isReady) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "GC not ready",
          steamLoggedIn: isLoggedIn,
          gcReady: isReady,
        })
      );
      return;
    }

    try {
      let mid, oid, tok;

      if (shareCode) {
        console.log(`[Resolve] Decoding share code: ${shareCode}`);
        const decoded = decodeMatchShareCode(shareCode);
        mid = decoded.matchId;
        oid = decoded.outcomeId;
        tok = decoded.token;
        console.log(`[Resolve] Decoded → matchId=${mid} outcomeId=${oid} token=${tok}`);
      } else if (matchId && outcomeId && token !== undefined) {
        mid = matchId;
        oid = outcomeId;
        tok = token;
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Provide either 'shareCode' or 'matchId' + 'outcomeId' + 'token'",
          })
        );
        return;
      }

      console.log(`[Resolve] Requesting match info from GC...`);
      const result = await requestMatchInfo(mid, oid, tok);
      console.log(`[Resolve] Got result: demoUrl=${result.demoUrl ? "YES" : "NO"}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error(`[Resolve] Error:`, err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Batch resolve
  if (req.url === "/resolve-batch" && req.method === "POST") {
    if (RESOLVE_SECRET) {
      const auth = req.headers["authorization"] || req.headers["x-resolve-secret"] || "";
      const token = auth.replace("Bearer ", "");
      if (token !== RESOLVE_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    const { shareCodes } = parsed;
    if (!Array.isArray(shareCodes) || shareCodes.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Provide 'shareCodes' array" }));
      return;
    }

    if (!isReady) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "GC not ready" }));
      return;
    }

    const codes = shareCodes.slice(0, 10);
    const results = [];

    for (const code of codes) {
      try {
        const decoded = decodeMatchShareCode(code);
        console.log(`[Batch] Resolving ${code}...`);

        const result = await requestMatchInfo(decoded.matchId, decoded.outcomeId, decoded.token);
        results.push({ shareCode: code, ...result, error: null });

        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[Batch] Error for ${code}: ${err.message}`);
        results.push({ shareCode: code, demoUrl: null, error: err.message });
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// ─── Catch unhandled errors (prevent crashes) ───
process.on("unhandledRejection", (err) => {
  console.error("[Process] Unhandled rejection:", err?.message || err);
});

process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception:", err?.message || err);
});

// ─── Start ───
server.listen(PORT, () => {
  console.log(`[Server] Steam GC Bot listening on port ${PORT}`);
  console.log(`[Server] Endpoints:`);
  console.log(`  GET  /health         - Status check`);
  console.log(`  POST /resolve        - Resolve single share code`);
  console.log(`  POST /resolve-batch  - Resolve multiple share codes`);
  loginToSteam();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Server] Shutting down...");
  if (reconnectTimer) clearTimeout(reconnectTimer);
  client.logOff();
  server.close();
  process.exit(0);
});
