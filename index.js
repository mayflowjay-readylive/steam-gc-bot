const http = require("http");
const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");

// ─── Config ───
const PORT = process.env.PORT || 3000;
const STEAM_USERNAME = process.env.STEAM_USERNAME;
const STEAM_PASSWORD = process.env.STEAM_PASSWORD;
const STEAM_GUARD_CODE = process.env.STEAM_GUARD_CODE || "";
const RESOLVE_SECRET = process.env.RESOLVE_SECRET || "";
const REFRESH_TOKEN = process.env.STEAM_REFRESH_TOKEN || "";

if (!STEAM_USERNAME || !STEAM_PASSWORD) {
  console.error("STEAM_USERNAME and STEAM_PASSWORD env vars are required");
  process.exit(1);
}

// ─── Steam Client Setup ───
const client = new SteamUser({
  autoRelogin: false, // We handle reconnection ourselves with exponential backoff
});
const csgo = new GlobalOffensive(client);

let isReady = false;
let isLoggedIn = false;
let isLoggingIn = false;
let manualReconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 120000; // 2 minutes max

// ─── Reconnection Logic ───
function scheduleReconnect(reason) {
  if (manualReconnectTimer) {
    return; // already scheduled
  }

  reconnectAttempts++;
  // Exponential backoff: 5s, 10s, 20s, 40s, 80s, 120s max
  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  console.log(`[Steam] Scheduling reconnect in ${delay / 1000}s (attempt ${reconnectAttempts}, reason: ${reason})`);

  manualReconnectTimer = setTimeout(() => {
    manualReconnectTimer = null;
    if (!isLoggedIn && !isLoggingIn) {
      console.log(`[Steam] Reconnecting (attempt ${reconnectAttempts})...`);
      loginToSteam();
    }
  }, delay);
}

function resetReconnectState() {
  reconnectAttempts = 0;
  if (manualReconnectTimer) {
    clearTimeout(manualReconnectTimer);
    manualReconnectTimer = null;
  }
}

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
function requestMatchInfo(shareCodeOrDetails) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      csgo.removeListener("matchList", onMatch);
      reject(new Error("GC request timed out after 30 seconds"));
    }, 30000);

    function onMatch(data) {
      clearTimeout(timeout);
      csgo.removeListener("matchList", onMatch);

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

    // API accepts either a share code string or { matchId, outcomeId, token }
    console.log(`[GC DEBUG] Calling csgo.requestGame with:`, shareCodeOrDetails);
    csgo.requestGame(shareCodeOrDetails);
  });
}

// ─── Steam Login ───
function loginToSteam() {
  if (isLoggedIn || isLoggingIn) {
    console.log("[Steam] Already logged in or login in progress, skipping");
    return;
  }

  isLoggingIn = true;
  console.log(`[Steam] Logging in as ${STEAM_USERNAME}...`);

  let loginOptions;

  if (REFRESH_TOKEN) {
    console.log("[Steam] Using refresh token for login");
    loginOptions = {
      refreshToken: REFRESH_TOKEN,
    };
  } else {
    console.log("[Steam] Using username/password for login");
    loginOptions = {
      accountName: STEAM_USERNAME,
      password: STEAM_PASSWORD,
    };
  }

  try {
    client.logOn(loginOptions);
  } catch (err) {
    console.error("[Steam] Login call failed:", err.message);
    isLoggingIn = false;
    scheduleReconnect("login exception");
  }
}

// ─── Steam Event Handlers ───

client.on("loggedOn", () => {
  console.log("[Steam] Logged in successfully");
  isLoggedIn = true;
  isLoggingIn = false;
  resetReconnectState(); // success — reset backoff

  client.setPersona(SteamUser.EPersonaState.Online);
  client.gamesPlayed([730]);
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
    console.log(`[Steam] Providing Steam Guard code from env var: ${STEAM_GUARD_CODE}`);
    callback(STEAM_GUARD_CODE);
  } else {
    const source = domain ? `email ending in ${domain}` : "mobile authenticator";
    console.error(`[Steam] ═══════════════════════════════════════════`);
    console.error(`[Steam] STEAM GUARD CODE REQUIRED (${source})`);
    console.error(`[Steam] Set STEAM_GUARD_CODE env var and restart`);
    console.error(`[Steam] ═══════════════════════════════════════════`);
  }
});

client.on("error", (err) => {
  console.error(`[Steam] Client error: ${err.message}`);
  isLoggedIn = false;
  isLoggingIn = false;
  isReady = false;

  // Don't call loginToSteam directly — autoRelogin may handle it.
  // Schedule a fallback reconnect in case autoRelogin doesn't kick in.
  scheduleReconnect(`error: ${err.message}`);
});

client.on("disconnected", (eresult, msg) => {
  console.warn(`[Steam] Disconnected: ${msg} (${eresult})`);
  isLoggedIn = false;
  isLoggingIn = false;
  isReady = false;

  // autoRelogin should handle most cases, but schedule a fallback
  // in case it doesn't reconnect within a reasonable time.
  scheduleReconnect(`disconnected: ${msg}`);
});

// ─── CS2 GC Event Handlers ───

csgo.on("connectedToGC", () => {
  console.log("[CS2 GC] Connected to Game Coordinator");
  isReady = true;
  resetReconnectState(); // fully connected — reset backoff
});

csgo.on("disconnectedFromGC", (reason) => {
  console.warn(`[CS2 GC] Disconnected from GC: ${reason}`);
  isReady = false;
  // Don't reconnect here — if Steam is still connected, GC will auto-reconnect.
  // If Steam disconnected too, the Steam disconnect handler will handle it.
});

csgo.on("error", (err) => {
  console.error("[CS2 GC] Error:", err);
});

// ─── Periodic Health Monitor ───
// Every 60 seconds, check if we should be connected but aren't.
// This catches edge cases where both autoRelogin and scheduled reconnect fail.
setInterval(() => {
  if (!isLoggedIn && !isLoggingIn && !manualReconnectTimer) {
    console.log("[Monitor] Not logged in and no reconnect scheduled — forcing reconnect");
    scheduleReconnect("health monitor");
  }
  if (isLoggedIn && !isReady) {
    // Steam is connected but GC isn't — try relaunching CS2
    console.log("[Monitor] Steam connected but GC not ready — relaunching CS2");
    try {
      client.gamesPlayed([]);
      setTimeout(() => {
        client.gamesPlayed([730]);
      }, 2000);
    } catch (err) {
      console.error("[Monitor] Failed to relaunch CS2:", err.message);
    }
  }
}, 60000);

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
      ok: isReady,
      steamLoggedIn: isLoggedIn,
      gcReady: isReady,
      uptime: process.uptime(),
      reconnectAttempts: reconnectAttempts,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
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
      let gameRequest;

      if (shareCode) {
        // Pass share code directly to the GC — let the library handle decoding
        console.log(`[Resolve] Using share code directly: ${shareCode}`);
        gameRequest = shareCode;
      } else if (matchId && outcomeId && token !== undefined) {
        gameRequest = { matchId, outcomeId, token };
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
      const result = await requestMatchInfo(gameRequest);
      console.log(`[Resolve] Success: demoUrl=${result.demoUrl ? "YES" : "NO"} matchTime=${result.matchTime}`);

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
        console.log(`[Batch] Resolving ${code}...`);
        const result = await requestMatchInfo(code);
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

// ─── Start ───
server.listen(PORT, () => {
  console.log(`[Server] Steam GC Bot listening on port ${PORT}`);
  console.log(`[Server] Endpoints:`);
  console.log(`  GET  /health         - Status check`);
  console.log(`  POST /resolve        - Resolve share code to demo URL`);
  console.log(`  POST /resolve-batch  - Resolve multiple share codes`);
  loginToSteam();
});

// Graceful shutdown — only on explicit SIGTERM, don't exit on disconnect
process.on("SIGTERM", () => {
  console.log("[Server] Received SIGTERM, shutting down gracefully...");
  client.logOff();
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 5 seconds if server doesn't close cleanly
  setTimeout(() => process.exit(0), 5000);
});

// Prevent unhandled rejections from crashing the process
process.on("unhandledRejection", (reason, promise) => {
  console.error("[Process] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception:", err.message);
  // Don't exit — try to keep running
});
