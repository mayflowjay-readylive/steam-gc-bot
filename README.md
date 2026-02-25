# Steam GC Bot — CS2 Demo URL Resolver

A lightweight Node.js service that connects to Steam's Game Coordinator via a bot account to resolve CS2 match share codes into demo download URLs.

## How It Works

1. Bot logs into Steam → connects to CS2 Game Coordinator
2. Your edge function sends a share code to `POST /resolve`
3. Bot decodes the share code, asks the GC for match info
4. GC returns the demo CDN URL (e.g., `http://replay123.valve.net/...`)
5. Bot returns the URL to your edge function

## Files

```
steam-gc-bot/
├── index.js        # Main service (Steam login + GC + HTTP server)
├── package.json    # Dependencies (steam-user, globaloffensive)
├── Dockerfile      # Railway deployment
└── README.md       # This file
```

## Railway Deployment (Step by Step)

### 1. Create a GitHub repo

```bash
# Create new repo called "steam-gc-bot" on GitHub, then:
git init
git add .
git commit -m "Steam GC bot for CS2 demo resolution"
git remote add origin https://github.com/YOUR_USER/steam-gc-bot.git
git push -u origin main
```

### 2. Add service to Railway

- Open your existing Railway project (where the Go parser lives)
- Click **"+ New"** → **"GitHub Repo"**
- Select the `steam-gc-bot` repo
- Railway will auto-detect the Dockerfile

### 3. Set environment variables

In the Railway service settings, add these **Variables**:

| Variable | Value | Required |
|---|---|---|
| `STEAM_USERNAME` | Your bot account username | ✅ |
| `STEAM_PASSWORD` | Your bot account password | ✅ |
| `RESOLVE_SECRET` | A random secret string (e.g., `gc-bot-s3cr3t-xyz`) | ✅ |
| `STEAM_GUARD_CODE` | Email code from Steam (see below) | First boot only |
| `STEAM_REFRESH_TOKEN` | Printed in logs after first login | After first boot |
| `PORT` | (Railway sets this automatically) | Auto |

### 4. First Boot — Steam Guard Flow

On first deploy, check the **Railway logs**. You'll see one of:

**Scenario A — Login succeeds immediately:**
```
[Steam] Logged in successfully
[Steam] ═══════════════════════════════════════════
[Steam] REFRESH TOKEN (save as STEAM_REFRESH_TOKEN env var):
eyJhbGciOiJFZERTQSIsInR5cC...
[Steam] ═══════════════════════════════════════════
[CS2 GC] Connected to Game Coordinator
```
→ Copy the refresh token, set it as `STEAM_REFRESH_TOKEN` env var.

**Scenario B — Steam Guard code required:**
```
[Steam] ═══════════════════════════════════════════
[Steam] STEAM GUARD CODE REQUIRED (email ending in j***@g***.com)
[Steam] Set STEAM_GUARD_CODE env var and restart
[Steam] ═══════════════════════════════════════════
```
→ Check the bot's email inbox for the code
→ Set `STEAM_GUARD_CODE=ABC123` in Railway env vars
→ Railway auto-redeploys, bot uses the code to log in
→ Copy the refresh token from logs, set `STEAM_REFRESH_TOKEN`
→ Remove `STEAM_GUARD_CODE` (no longer needed)

### 5. Verify it's running

Hit the health endpoint:
```bash
curl https://YOUR-BOT-URL.railway.app/health
```

Response:
```json
{
  "ok": true,
  "steamLoggedIn": true,
  "gcReady": true,
  "uptime": 123.45
}
```

### 6. Generate public URL

In Railway service settings → **Settings** → **Networking**:
- Click **"Generate Domain"** to get a public URL
- Or use Railway's **internal networking** if the edge function calls it via private URL

## API Reference

### `GET /health`
Status check. No auth required.

**Response:**
```json
{
  "ok": true,
  "steamLoggedIn": true,
  "gcReady": true,
  "uptime": 456.78
}
```

### `POST /resolve`
Resolve a single share code to a demo URL.

**Headers:**
```
Authorization: Bearer YOUR_RESOLVE_SECRET
Content-Type: application/json
```

**Body (share code):**
```json
{
  "shareCode": "CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
}
```

**Body (alternative — pre-decoded):**
```json
{
  "matchId": "3702302892816662685",
  "outcomeId": "3702302892816924832",
  "token": 27538
}
```

**Success Response:**
```json
{
  "matchId": "3702302892816662685",
  "matchTime": 1708900000,
  "demoUrl": "http://replay123.valve.net/730/003702302892816662685_1234567890.dem.bz2",
  "matchDuration": 2340,
  "rawMatch": {
    "matchtime": 1708900000,
    "matchDuration": 2340,
    "serverIp": "xxx.xxx.xxx.xxx",
    "roundCount": 24
  }
}
```

**Notes:**
- `matchTime` is a Unix timestamp (seconds) — this is the **real match date**
- `demoUrl` is a Valve CDN link to a `.dem.bz2` file (bzip2 compressed)
- Demo URLs expire after ~7-14 days from the match date
- If `demoUrl` is `null`, the demo may have expired

### `POST /resolve-batch`
Resolve up to 10 share codes at once. 2-second delay between each to avoid GC rate limits.

**Headers:**
```
Authorization: Bearer YOUR_RESOLVE_SECRET
Content-Type: application/json
```

**Body:**
```json
{
  "shareCodes": [
    "CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
    "CSGO-YYYYY-YYYYY-YYYYY-YYYYY-YYYYY"
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "shareCode": "CSGO-XXXXX-...",
      "matchId": "...",
      "matchTime": 1708900000,
      "demoUrl": "http://replay...",
      "error": null
    },
    {
      "shareCode": "CSGO-YYYYY-...",
      "demoUrl": null,
      "error": "Demo expired or not available"
    }
  ]
}
```

## Edge Function Integration

Update your Supabase edge function that handles auto-sync to call this service:

```typescript
// In your sync-matches or request-demo-download edge function:

const GC_BOT_URL = Deno.env.get("GC_BOT_URL"); // e.g., https://steam-gc-bot-production.up.railway.app
const RESOLVE_SECRET = Deno.env.get("RESOLVE_SECRET");

async function resolveDemoUrl(shareCode: string) {
  const res = await fetch(`${GC_BOT_URL}/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${RESOLVE_SECRET}`,
    },
    body: JSON.stringify({ shareCode }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || `GC bot returned ${res.status}`);
  }

  const data = await res.json();
  return {
    demoUrl: data.demoUrl,               // Valve CDN URL (.dem.bz2)
    matchDate: data.matchTime             // Unix timestamp — real match date!
      ? new Date(data.matchTime * 1000).toISOString()
      : null,
    matchDuration: data.matchDuration,
  };
}
```

**Important:** The `matchTime` field from the GC response IS the real match date
(Unix timestamp). This solves the match date problem we discussed earlier — no
need to extract it from the demo file. Pass it to the Go parser as the
`matchDate` field in the request body.

## Supabase Secrets to Add

| Secret | Value |
|---|---|
| `GC_BOT_URL` | Railway service URL (e.g., `https://steam-gc-bot-xxx.railway.app`) |
| `RESOLVE_SECRET` | Same value as the bot's `RESOLVE_SECRET` env var |

## Cost

- Tiny always-on Node.js process: ~30-50MB RAM idle
- Estimated Railway cost: **$0.50-1.00/month** — well within the $5 Hobby credit
- Combined with the Go parser, total Railway cost stays under $5/month

## Rate Limits & Best Practices

- Don't spam the GC — add 2+ second delays between requests
- The batch endpoint already does this (2s between each code)
- Valve may temporarily block accounts that send too many requests
- Demo URLs expire ~7-14 days after the match — resolve promptly
- If the bot gets disconnected, it auto-reconnects after 30 seconds

## Troubleshooting

| Issue | Fix |
|---|---|
| `gcReady: false` | Wait 30-60 seconds after deploy for GC connection |
| `STEAM GUARD CODE REQUIRED` | Set `STEAM_GUARD_CODE` env var, redeploy |
| `GC request timed out` | GC may be overloaded, retry after a few seconds |
| `No match data returned` | Share code may be invalid or demo expired |
| Frequent disconnects | Valve may be rate-limiting — reduce request frequency |
| `InvalidPassword` | Check `STEAM_USERNAME`/`STEAM_PASSWORD` env vars |
