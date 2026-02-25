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
  dataDirectory: "/tmp/steam-data", // Persist sentry files on Railway
  autoRelogin: true,
});
const csgo = new GlobalOffensive(client);

let isReady = false; // GC connected and ready
let isLoggedIn = false;

// ─── Share Code Decoder ───
// Decodes CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX into { matchId, outcomeId, token }
function decodeShareCode(shareCode) {
  const DICTIONARY = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

  // Strip "CSGO-" prefix and dashes
  const code = shareCode.replace(/^CSGO-/, "").replace(/-/g, "");

  // Decode from custom base-57 to big integer (as array of bytes)
  let big = BigInt(0);
  for (let i = code.length - 1; i >= 0; i--) {
    const charIndex = DICTIONARY.indexOf(code[i]);
    if (charIndex === -1) throw new Error(`Invalid character in share code: ${code[i]}`);
    big = big * BigInt(DICTIONARY.length) + BigInt(charIndex);
  }

  // Convert to 18-byte buffer (big-endian)
  const bytes = [];
  for (let i = 0; i < 18; i++) {
    bytes.push(Number(big & BigInt(0xff)));
    big = big >> BigInt(8);
  }
  bytes.reverse();

  // First byte is a checksum/version, skip it
  // Remaining 17 bytes: matchId (8 bytes) + outcomeId (8 bytes) + token (2 bytes) — but with XOR swizzle

  // Undo the XOR swizzle
  // The encoding XORs each byte with the share code's hash
  // Actually the standard decoding is simpler - read as little-endian uint64s from the unswizzled bytes

  // Re-derive from the raw big integer approach
  // The 144-bit number (18 bytes) is laid out as:
  // byte[0] = version/flags
  // bytes[1..] = encoded fields

  // Simpler: use the known bit layout
  // After base57 decode, the 144-bit value contains:
  // - matchId: bits
  // - outcomeId: bits  
  // - tokenId: bits

  // Let me use the proven byte-level approach
  const buf = Buffer.alloc(18);
  let n = BigInt(0);
  const cleanCode = shareCode.replace(/^CSGO-/, "").replace(/-/g, "");
  for (let i = cleanCode.length - 1; i >= 0; i--) {
    n = n * BigInt(57) + BigInt(DICTIONARY.indexOf(cleanCode[i]));
  }
  for (let i = 0; i < 18; i++) {
    buf[17 - i] = Number(n & BigInt(0xff));
    n = n >> BigInt(8);
  }

  // Byte layout after decoding:
  // buf[0]    = 0 (padding/version)
  // buf[1..8] = matchId (LE uint64)  
  // buf[9..16] = outcomeId (LE uint64)
  // buf[17]    = token (uint16 spread across remaining bits)

  // Actually the layout from Valve's implementation:
  // The 18 bytes encode: matchId (uint64 LE), outcomeId (uint64 LE), token (uint16 LE)
  // with the first byte being a checksum

  // Swap byte order for each field (the encoding reverses bytes within each field)
  const matchIdBytes = Buffer.from([buf[2], buf[1], buf[4], buf[3], buf[6], buf[5], buf[8], buf[7]]);
  const outcomeIdBytes = Buffer.from([buf[10], buf[9], buf[12], buf[11], buf[14], buf[13], buf[16], buf[15]]);
  const tokenByte = buf[17] | (buf[0] & 0x0f) << 8; // Remaining bits for token

  // Read as uint64
  const matchId = matchIdBytes.readBigUInt64BE(0);
  const outcomeId = outcomeIdBytes.readBigUInt64BE(0);

  return {
    matchId: matchId.toString(),
    outcomeId: outcomeId.toString(),
    token: tokenByte,
  };
}

// Alternative simpler decoder that matches the widely-used implementation
function decodeMatchShareCode(code) {
  const DICTIONARY = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
  const stripped = code.replace("CSGO-", "").replace(/-/g, "");

  let big = BigInt(0);
  for (let i = stripped.length - 1; i >= 0; i--) {
    big = big * BigInt(57) + BigInt(DICTIONARY.indexOf(stripped[i]));
  }

  // Convert to byte array (little-endian)
  const bytes = [];
  for (let i = 0; i < 18; i++) {
    bytes.push(Number(big & BigInt(0xff)));
    big = big >> BigInt(8);
  }

  // Swap pairs within each field
  // matchId: bytes 0-7, outcomeId: bytes 8-15, token: bytes 16-17
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

      if (!data || !data.matches || data.matches.length === 0) {
        reject(new Error("No match data returned from GC"));
        return;
      }

      const match = data.matches[0];
      const roundStats = match.roundstatsall || match.roundstats_legacy;

      // The demo URL is in the last roundstats entry's map field
      let demoUrl = null;
      if (roundStats && roundStats.length > 0) {
        const lastRound = roundStats[roundStats.length - 1];
        demoUrl = lastRound.map || null;
      }

      // Also check the direct reservation map field
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

    // Request match info from GC
    csgo.requestGame(matchId, outcomeId, token);
  });
}

// ─── Steam Login ───
function loginToSteam() {
  console.log(`[Steam] Logging in as ${STEAM_USERNAME}...`);

  const loginOptions = {
    accountName: STEAM_USERNAME,
    password: STEAM_PASSWORD,
  };

  // If we have a refresh token from a previous session, use it
  if (REFRESH_TOKEN) {
    console.log("[Steam] Using refresh token for login");
    loginOptions.refreshToken = REFRESH_TOKEN;
    delete loginOptions.password;
  }

  client.logOn(loginOptions);
}

// ─── Steam Event Handlers ───

client.on("loggedOn", () => {
  console.log("[Steam] Logged in successfully");
  isLoggedIn = true;

  // Set persona to online and launch CS2 (app ID 730)
  client.setPersona(SteamUser.EPersonaState.Online);
  client.gamesPlayed([730]);
});

client.on("refreshToken", (token) => {
  // Log this so you can set it as STEAM_REFRESH_TOKEN env var for future logins
  // This avoids needing password + steam guard on subsequent restarts
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
  console.error("[Steam] Client error:", err.message);
  isLoggedIn = false;
  isReady = false;

  // Auto-retry after delay
  setTimeout(() => {
    console.log("[Steam] Retrying login...");
    loginToSteam();
  }, 30000);
});

client.on("disconnected", (eresult, msg) => {
  console.warn(`[Steam] Disconnected: ${msg} (${eresult})`);
  isLoggedIn = false;
  isReady = false;
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

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  // CORS headers
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
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  // Resolve share code → demo URL
  if (req.url === "/resolve" && req.method === "POST") {
    // Auth check
    if (RESOLVE_SECRET) {
      const auth = req.headers["authorization"] || req.headers["x-resolve-secret"] || "";
      const token = auth.replace("Bearer ", "");
      if (token !== RESOLVE_SECRET) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // Read body
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
        // Decode share code
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

  // Batch resolve multiple share codes
  if (req.url === "/resolve-batch" && req.method === "POST") {
    // Auth check
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

    // Limit batch size to prevent abuse
    const codes = shareCodes.slice(0, 10);
    const results = [];

    for (const code of codes) {
      try {
        const decoded = decodeMatchShareCode(code);
        console.log(`[Batch] Resolving ${code}...`);

        const result = await requestMatchInfo(decoded.matchId, decoded.outcomeId, decoded.token);
        results.push({ shareCode: code, ...result, error: null });

        // Small delay between GC requests to avoid rate limiting
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
  console.log(`  POST /resolve        - Resolve single share code`);
  console.log(`  POST /resolve-batch  - Resolve multiple share codes`);
  loginToSteam();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Server] Shutting down...");
  client.logOff();
  server.close();
  process.exit(0);
});
