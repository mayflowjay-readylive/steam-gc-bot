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
  dataDirectory: null,
  autoRelogin: false,
});
const csgo = new GlobalOffensive(client);

// ─── State ───
let isReady = false;
let isLoggedIn = false;
let isLoggingIn = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let loginStartedAt = null;
let lastGcConnectedAt = null;
let lastSuccessfulResolve = null;
let totalReconnects = 0;
let gcRelaunching = false;

const MAX_RECONNECT_DELAY = 120000;
const LOGIN_STUCK_TIMEOUT = 60000;
const GC_WAIT_TIMEOUT = 120000;
const MAX_CONSECUTIVE_FAILURES = 15;
const WATCHDOG_INTERVAL = 30000;

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
function requestMatchInfo(shareCode) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      csgo.removeListener("matchList", onMatch);
      reject(new Error("GC request timed out after 30 seconds"));
    }, 30000);

    function onMatch(data) {
      clearTimeout(timeout);
      csgo.removeListener("matchList", onMatch);

      console.log(`[GC Raw] matchList response: ${JSON.stringify(data).slice(0, 500)}`);

      let matches;
      if (Array.isArray(data)) {
        matches = data;
      } else if (data && data.matches) {
        matches = data.matches;
      } else {
        matches = [];
      }

      if (matches.length === 0) {
        reject(new Error("No match data returned from GC"));
        return;
      }

      const match = matches[0];
      const roundStats = match.roundstatsall || match.roundstats_legacy;

      let demoUrl = null;
      if (roundStats && roundStats.length > 0) {
        const lastRound = roundStats[roundStats.length - 1];
        demoUrl = lastRound.map || null;
      }

      if (!demoUrl && match.roundstats_legacy) {
        demoUrl = match.roundstats_legacy.map || null;
      }

      lastSuccessfulResolve = Date.now();

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
    console.log(`[GC] Calling requestGame("${shareCode}")`);
    csgo.requestGame(shareCode);
  });
}

// ─── Steam Login ───
function loginToSteam() {
  if (isLoggingIn) {
    if (loginStartedAt && Date.now() - loginStartedAt > LOGIN_STUCK_TIMEOUT) {
      console.warn(`[Steam] Login stuck for ${Math.round((Date.now() - loginStartedAt) / 1000)}s — forcing reset`);
      isLoggingIn = false;
      loginStartedAt = null;
    } else {
      console.log("[Steam] Login already in progress, skipping");
      return;
    }
  }

  isLoggingIn = true;
  loginStartedAt = Date.now();
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
    loginStartedAt = null;
    scheduleReconnect("logOn exception");
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectAttempt++;
  totalReconnects++;

  if (reconnectAttempt >= MAX_CONSECUTIVE_FAILURES) {
    console.error(`[Steam] ═══════════════════════════════════════════`);
    console.error(`[Steam] ${MAX_CONSECUTIVE_FAILURES} consecutive reconnect failures — restarting process`);
    console.error(`[Steam] Railway will auto-restart the container`);
    console.error(`[Steam] ═══════════════════════════════════════════`);
    process.exit(1);
  }

  const delay = Math.min(10000 * Math.pow(2, reconnectAttempt - 1), MAX_RECONNECT_DELAY);
  console.log(`[Steam] Scheduling reconnect in ${delay / 1000}s (attempt ${reconnectAttempt}/${MAX_CONSECUTIVE_FAILURES}, reason: ${reason})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    loginToSteam();
  }, delay);
}

function relaunchGame() {
  if (gcRelaunching) return;
  gcRelaunching = true;
  console.log("[Steam] Relaunching CS2 for fresh GC connection...");
  try {
    client.gamesPlayed([]);
    setTimeout(() => {
      try {
        client.gamesPlayed([730]);
        console.log("[Steam] CS2 relaunched");
      } catch (err) {
        console.error("[Steam] Failed to relaunch CS2:", err.message);
      }
      gcRelaunching = false;
    }, 3000);
  } catch (err) {
    console.error("[Steam] Failed to stop games:", err.message);
    gcRelaunching = false;
  }
}

// ─── Steam Event Handlers ───

client.on("loggedOn", () => {
  console.log("[Steam] Logged in successfully");
  isLoggedIn = true;
  isLoggingIn = false;
  loginStartedAt = null;
  reconnectAttempt = 0;

  // Clean GC launch
  client.gamesPlayed([]);
  setTimeout(() => {
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([730]);
    console.log("[Steam] Launched CS2 (app 730)");
  }, 2000);

  setTimeout(() => {
    if (client.refreshToken) {
      console.log("[Steam] ═══════════════════════════════════════════");
      console.log("[Steam] REFRESH TOKEN (save as STEAM_REFRESH_TOKEN env var):");
      console.log(client.refreshToken);
      console.log("[Steam] ═══════════════════════════════════════════");
    }
  }, 7000);
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
    console.log("[Steam] Providing Steam Guard code from env var");
    callback(STEAM_GUARD_CODE);
  } else {
    const source = domain ? `email ending in ${domain}` : "mobile authenticator";
    console.error(`[Steam] ═══════════════════════════════════════════`);
    console.error(`[Steam] STEAM GUARD CODE REQUIRED (${source})`);
    console.error(`[Steam] Set STEAM_GUARD_CODE env var and restart`);
    console.error(`[Steam] ═══════════════════════════════════════════`);
    isLoggingIn = false;
    loginStartedAt = null;
  }
});

client.on("error", (err) => {
  console.error("[Steam] Client error:", err.message);
  isLoggedIn = false;
  isReady = false;
  isLoggingIn = false;
  loginStartedAt = null;

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
  loginStartedAt = null;
  scheduleReconnect("disconnected");
});

// ─── CS2 GC Event Handlers ───

csgo.on("connectedToGC", () => {
  console.log("[CS2 GC] Connected to Game Coordinator");
  isReady = true;
  lastGcConnectedAt = Date.now();
});

csgo.on("disconnectedFromGC", (reason) => {
  console.warn(`[CS2 GC] Disconnected from GC: ${reason}`);
  isReady = false;

  // If still logged into Steam, try to reconnect GC by relaunching game
  if (isLoggedIn) {
    console.log("[CS2 GC] Still logged into Steam — relaunching game in 5s");
    setTimeout(() => {
      if (isLoggedIn && !isReady) {
        relaunchGame();
      }
    }, 5000);
  }
});

csgo.on("error", (err) => {
  console.error("[CS2 GC] Error:", err);
});

// ─── Watchdog: Catches ALL failure modes every 30s ───
setInterval(() => {
  const now = Date.now();

  // Case 1: Login is stuck
  if (isLoggingIn && loginStartedAt && now - loginStartedAt > LOGIN_STUCK_TIMEOUT) {
    console.warn(`[Watchdog] Login stuck for ${Math.round((now - loginStartedAt) / 1000)}s — resetting`);
    isLoggingIn = false;
    loginStartedAt = null;
    scheduleReconnect("watchdog: login stuck");
    return;
  }

  // Case 2: Not logged in and nothing happening
  if (!isLoggedIn && !isLoggingIn && !reconnectTimer) {
    console.warn("[Watchdog] Not logged in, nothing scheduled — forcing reconnect");
    scheduleReconnect("watchdog: idle");
    return;
  }

  // Case 3: Logged in but GC not connected for too long
  if (isLoggedIn && !isReady && !gcRelaunching) {
    const loggedInDuration = lastGcConnectedAt
      ? now - Math.max(lastGcConnectedAt, loginStartedAt || 0)
      : now - (loginStartedAt || now);
    if (loggedInDuration > GC_WAIT_TIMEOUT) {
      console.warn(`[Watchdog] Logged in but GC not ready for ${Math.round(loggedInDuration / 1000)}s — relaunching game`);
      relaunchGame();
    }
  }

}, WATCHDOG_INTERVAL);

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
      ok: isLoggedIn && isReady,
      steamLoggedIn: isLoggedIn,
      gcReady: isReady,
      uptime: process.uptime(),
      reconnectAttempt: reconnectAttempt,
      totalReconnects: totalReconnects,
      isLoggingIn: isLoggingIn,
      lastGcConnected: lastGcConnectedAt ? new Date(lastGcConnectedAt).toISOString() : null,
      lastSuccessfulResolve: lastSuccessfulResolve ? new Date(lastSuccessfulResolve).toISOString() : null,
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
      let resolveInput;

      if (shareCode) {
        const normalizedCode = shareCode.trim();
        console.log(`[Resolve] Passing share code directly to GC: ${normalizedCode}`);
        resolveInput = normalizedCode;
      } else if (matchId && outcomeId && token !== undefined) {
        console.log(`[Resolve] Using pre-decoded: matchId=${matchId} outcomeId=${outcomeId} token=${token}`);
        resolveInput = { matchId, outcomeId, token };
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
      const result = await requestMatchInfo(resolveInput);
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
        console.log(`[Batch] Resolving ${code}...`);

        const result = await requestMatchInfo(code.trim());
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

// ─── Catch unhandled errors ───
process.on("unhandledRejection", (err) => {
  console.error("[Process] Unhandled rejection:", err?.message || err);
});

process.on("uncaughtException", (err) => {
  console.error("[Process] Uncaught exception:", err?.message || err);
});

// ─── Start ───
const STARTUP_DELAY = 10000;

server.listen(PORT, () => {
  console.log(`[Server] Steam GC Bot v2.0 (self-healing) listening on port ${PORT}`);
  console.log(`[Server] Endpoints:`);
  console.log(`  GET  /health         - Status check`);
  console.log(`  POST /resolve        - Resolve single share code`);
  console.log(`  POST /resolve-batch  - Resolve multiple share codes`);
  console.log(`[Server] Waiting ${STARTUP_DELAY / 1000}s before login...`);
  setTimeout(() => {
    loginToSteam();
  }, STARTUP_DELAY);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Server] Shutting down...");
  if (reconnectTimer) clearTimeout(reconnectTimer);
  try { client.logOff(); } catch (e) {}
  server.close();
  process.exit(0);
});
