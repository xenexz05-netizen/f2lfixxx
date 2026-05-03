# 🚂 Railway Deployment Guide — File2Link BOT

## Prerequisites
- Railway account at https://railway.app
- PostgreSQL database (add via Railway plugin)
- Telegram Bot Token, API ID, API Hash, Session string

## Deploy Steps

### 1. Create New Project on Railway
- Go to https://railway.app → New Project → Deploy from GitHub repo
- Connect your GitHub and push this repo

### 2. Add PostgreSQL
- In your Railway project → Add Plugin → PostgreSQL
- Railway auto-sets `DATABASE_URL` — no manual config needed

### 3. Set Environment Variables
In Railway project → Variables tab, add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `8080` |
| `BASE_URL` | `https://your-app.railway.app` |
| `DATABASE_URL` | *(auto-set by Railway PostgreSQL plugin)* |
| `TELEGRAM_BOT_TOKEN` | Your bot token |
| `TELEGRAM_API_ID` | Your API ID (number) |
| `TELEGRAM_API_HASH` | Your API hash |
| `TELEGRAM_SESSION` | Your GramJS session string |
| `PUSH_BOT_TOKEN` | Push bot token (optional) |
| `LOG_CHANNEL_ID` | Log channel ID (optional) |
| `UPDATE_BOT_TOKEN` | Update bot token (optional) |
| `UPDATE_BOT_ADMIN` | Admin user ID (optional) |

### 4. Deploy
Railway auto-deploys on every push to your main branch.

## Key Changes from Render
- `railway.toml` replaces `render.yaml`
- `nixpacks` builder (Railway native) replaces Render's build environment
- No sleep on free tier (Railway keeps service alive)
- Persistent `/tmp` volume available for HLS segments

## Performance Notes
- HLS segments cached in `/tmp/f2l-hls` (auto-cleaned every 5 min)
- 20 parallel GramJS workers for max download throughput
- Plyr video player with adaptive HLS buffering (low-latency mode)
- Pre-buffering: 30s segments ready before user hits play
