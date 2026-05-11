import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { ConnectionTCPFull } from "telegram/network/connection/TCPFull.js";
import bigInt from "big-integer";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger.js";

// ── SINGLE BOT + DUAL MTPROTO LOAD BALANCING ────────────────────────────────
// ONE bot instance that rotates between 2 MTProto credentials
const API_ID    = parseInt(process.env.TELEGRAM_API_ID!, 10);
const API_HASH  = process.env.TELEGRAM_API_HASH!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// Secondary credentials (optional) for rotating MTProto accounts
const API_ID_2    = process.env.TELEGRAM_API_ID_2 ? parseInt(process.env.TELEGRAM_API_ID_2, 10) : null;
const API_HASH_2  = process.env.TELEGRAM_API_HASH_2 || null;
const BOT_TOKEN_2 = process.env.TELEGRAM_BOT_TOKEN_2 || null;

const SESSION_FILE = path.resolve("telegram_session.txt");
const SESSION_FILE_2 = path.resolve("telegram_session_2.txt");

// ── 1GBPS STREAMING CONSTANTS ──────────────────────────────────────────────
// 32 MB chunks × 64 workers = 2 GB in-flight simultaneously!!!
// 32 MB = max aggressive chunking for absolute maximum Telegram throughput
// 64 workers = maximum parallelism without hitting system limits
// ─────────────────────────────────────────────────────────────────────────────
const REQUEST_SIZE = 32 * 1024 * 1024;  // 32 MB — EXTREME chunking for 1Gbps
const WORKERS      = 64;                // 64 workers → 2 GB in-flight
const PROXY_URL    = process.env.TELEGRAM_PROXY;

// Track which API credentials were used last for rotation
let _lastUsedApi = 0;  // 0 = primary, 1 = secondary

let _client: TelegramClient | null = null;
let _client2: TelegramClient | null = null;
let _connecting: Promise<void> | null = null;

function loadSession(): string {
  const env = process.env.TELEGRAM_SESSION?.trim();
  if (env) return env;
  try { return fs.readFileSync(SESSION_FILE, "utf-8").trim(); } catch { return ""; }
}

function loadSession2(): string {
  const env = process.env.TELEGRAM_SESSION_2?.trim();
  if (env) return env;
  try { return fs.readFileSync(SESSION_FILE_2, "utf-8").trim(); } catch { return ""; }
}

function saveSession(session: string): void {
  if (process.env.TELEGRAM_SESSION) return;
  try { fs.writeFileSync(SESSION_FILE, session, "utf-8"); } catch (err) {
    logger.warn({ err }, "Could not save session file");
  }
}

function saveSession2(session: string): void {
  if (process.env.TELEGRAM_SESSION_2) return;
  try { fs.writeFileSync(SESSION_FILE_2, session, "utf-8"); } catch (err) {
    logger.warn({ err }, "Could not save session file 2");
  }
}

// ── Create single TelegramClient instance ──────────────────────────────────
async function createClient(
  apiId: number,
  apiHash: string,
  botToken: string,
  sessionFile: string,
  label: string,
): Promise<TelegramClient> {
  const sessionLoader = sessionFile === SESSION_FILE ? loadSession : loadSession2;
  const sessionSaver = sessionFile === SESSION_FILE ? saveSession : saveSession2;
  const sessionStr = sessionLoader();

  let proxyConfig: any = undefined;
  if (PROXY_URL) {
    try {
      const url = new URL(PROXY_URL);
      if (url.protocol === "socks5:") {
        proxyConfig = {
          type: "socks5",
          ip: url.hostname,
          port: parseInt(url.port || "1080", 10),
          username: url.username || undefined,
          password: url.password || undefined,
        };
        logger.info({ label, proxy: url.hostname }, "Using SOCKS5 proxy");
      }
    } catch (err) {
      logger.warn({ err, url: PROXY_URL, label }, "Invalid TELEGRAM_PROXY — ignoring");
    }
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 25,  // More aggressive retries
    retryDelay: 250,        // Faster retry
    connection: ConnectionTCPFull,
    proxy: proxyConfig,
    useWSS: false,
    autoReconnect: true,
    deviceModel: "File2Link BOT",
    appVersion: "3.0.0",
    langCode: "en",
    maxCdnConnections: 16,  // More CDN connections
  });

  await client.start({
    botAuthToken: botToken,
    onError: (err) => logger.error({ err, label }, "GramJS error"),
  });

  const saved = client.session.save() as unknown as string;
  if (saved && saved !== sessionStr) sessionSaver(saved);

  logger.info({ label, workers: WORKERS, chunkMB: REQUEST_SIZE / 1024 / 1024 }, "MTProto client ready");
  
  // Keep-alive reconnection (faster)
  setInterval(async () => {
    try {
      if (client && !client.connected) {
        await client.connect();
        logger.info({ label }, "Reconnected");
      }
    } catch (err) {
      logger.error({ err, label }, "Keep-alive failed");
    }
  }, 30_000).unref();  // More frequent keep-alive

  return client;
}

// ── Initialize primary client (+ optional secondary for rotation) ────────────
export async function initializeClients(): Promise<void> {
  if (_client || _connecting) return;
  
  _connecting = (async () => {
    try {
      _client = await createClient(API_ID, API_HASH, BOT_TOKEN, SESSION_FILE, "Primary");
      
      if (API_ID_2 && API_HASH_2 && BOT_TOKEN_2) {
        _client2 = await createClient(API_ID_2, API_HASH_2, BOT_TOKEN_2, SESSION_FILE_2, "Secondary");
        logger.info("Dual MTProto rotation ENABLED — will auto-rotate on rate limits");
      }
    } finally {
      _connecting = null;
    }
  })();

  await _connecting;
}

// ── Get best client (rotate if secondary exists) ────────────────────────────
async function getBestClient(): Promise<TelegramClient> {
  await initializeClients();
  
  if (!_client) throw new Error("Primary MTProto client not initialized");
  
  // If we have a secondary client and primary seems overloaded, rotate
  if (_client2) {
    _lastUsedApi = 1 - _lastUsedApi;  // Simple rotation
    return _lastUsedApi === 0 ? _client : _client2;
  }
  
  return _client;
}

function persistSession(client: TelegramClient): void {
  try {
    const cur = client.session.save() as unknown as string;
    if (!cur) return;
    
    if (client === _client) saveSession(cur);
    else if (client === _client2) saveSession2(cur);
  } catch {}
}

// ── Smart streaming with auto-rotating MTProto ─────────────────────────────
export async function streamFileByMessage(
  chatId: number,
  messageId: number,
  onChunk: (chunk: Buffer) => boolean | Promise<boolean>,
  offsetBytes = 0,
  limitBytes?: number,
  userIp?: string,  // Unused but kept for API compatibility
): Promise<void> {
  const MAX_RETRIES = 5;
  const BASE_DELAY  = 600;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let client: TelegramClient | null = null;
    try {
      // Get client (rotates to secondary if dual MTProto enabled)
      client = await getBestClient();
      if (!client.connected) await client.connect();

      const [message] = await client.getMessages(chatId, { ids: [messageId] });
      if (!message?.media) throw new Error("No media in message");

      const aligned   = Math.floor(offsetBytes / 4096) * 4096;
      const skipBytes = offsetBytes - aligned;
      let sent    = 0;
      let skipped = 0;

      for await (const chunk of client.iterDownload({
        file: message.media as any,
        offset: bigInt(aligned),
        requestSize: REQUEST_SIZE,
        workers: WORKERS,
      })) {
        const buf = Buffer.from(chunk);

        let start = 0;
        if (skipped < skipBytes) {
          const need = skipBytes - skipped;
          if (buf.length <= need) { skipped += buf.length; continue; }
          start   = need;
          skipped = skipBytes;
        }

        const slice = start > 0 ? buf.subarray(start) : buf;

        if (limitBytes !== undefined && sent + slice.length >= limitBytes) {
          await onChunk(slice.subarray(0, limitBytes - sent));
          break;
        }

        if (!await onChunk(slice)) break;
        sent += slice.length;
      }

      persistSession(client);
      return;

    } catch (err: any) {
      const clientLabel = client === _client2 ? "Secondary" : "Primary";
      logger.error({
        err,
        attempt,
        chatId,
        messageId,
        client: clientLabel,
      }, "Stream attempt failed");

      const floodMatch = String(err?.message || err).match(/FLOOD_WAIT_(\d+)/);
      const waitMs = floodMatch
        ? parseInt(floodMatch[1]!, 10) * 1000 + 500
        : BASE_DELAY * Math.pow(2, attempt - 1);

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}
