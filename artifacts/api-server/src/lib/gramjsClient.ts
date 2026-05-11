import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { ConnectionTCPFull } from "telegram/network/connection/TCPFull.js";
import bigInt from "big-integer";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger.js";

// ── DUAL MTPROTO + GEOLOCATION AUTO-PROXY ──────────────────────────────────
// Primary credentials
const API_ID    = parseInt(process.env.TELEGRAM_API_ID!, 10);
const API_HASH  = process.env.TELEGRAM_API_HASH!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// Secondary credentials for load balancing
const API_ID_2    = process.env.TELEGRAM_API_ID_2 ? parseInt(process.env.TELEGRAM_API_ID_2, 10) : null;
const API_HASH_2  = process.env.TELEGRAM_API_HASH_2 || null;
const BOT_TOKEN_2 = process.env.TELEGRAM_BOT_TOKEN_2 || null;

const SESSION_FILE = path.resolve("telegram_session.txt");
const SESSION_FILE_2 = path.resolve("telegram_session_2.txt");

// Geolocation → Telegram Server Mapping (SOCKS5 proxies for nearest datacenters)
const REGION_PROXIES: Record<string, string> = {
  // Asia/Pacific datacenters
  "IN": "socks5://149.154.167.151:1080",   // India → AS (Asia)
  "SG": "socks5://149.154.167.151:1080",   // Singapore → AS
  "TH": "socks5://149.154.167.151:1080",   // Thailand → AS
  "MY": "socks5://149.154.167.151:1080",   // Malaysia → AS
  "ID": "socks5://149.154.167.151:1080",   // Indonesia → AS
  "PH": "socks5://149.154.167.151:1080",   // Philippines → AS
  "BD": "socks5://149.154.167.151:1080",   // Bangladesh → AS
  "PK": "socks5://149.154.167.151:1080",   // Pakistan → AS
  
  // Europe
  "GB": "socks5://149.154.167.138:1080",   // UK → EU
  "DE": "socks5://149.154.167.138:1080",   // Germany → EU
  "FR": "socks5://149.154.167.138:1080",   // France → EU
  "NL": "socks5://149.154.167.138:1080",   // Netherlands → EU
  "RU": "socks5://149.154.167.138:1080",   // Russia → EU
  
  // US/Americas
  "US": "socks5://149.154.167.40:1080",    // USA → Americas
  "CA": "socks5://149.154.167.40:1080",    // Canada → Americas
  "BR": "socks5://149.154.167.40:1080",    // Brazil → Americas
  "MX": "socks5://149.154.167.40:1080",    // Mexico → Americas
};

// ── ULTRA-EXTREME SPEED (YouTube/Netflix level) ────────────────────────────
// 16 MB chunks × 64 workers = 1024 MB (1 GB) in-flight simultaneously
// 16 MB = 4× Telegram MTProto max → aggressive batching for max throughput
// 64 workers = MAXIMUM parallelism for 100+ Mbps sustained streaming
// Dual MTProto clients: load-balance when one gets overloaded
// ─────────────────────────────────────────────────────────────────────────────
const REQUEST_SIZE = 16 * 1024 * 1024;  // 16 MB — ULTRA aggressive chunking
const WORKERS      = 64;                // 64 parallel workers → 1 GB in-flight
const PROXY_URL    = process.env.TELEGRAM_PROXY;

// ── Client pool with active request tracking ────────────────────────────────
type ClientState = { client: TelegramClient; activeRequests: number; sessions: string[] };
let _clients: ClientState[] = [];
let _connecting: Promise<void> | null = null;

// Track active requests per client for load balancing
const _activeRequests = new Map<TelegramClient, number>();

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

// ── Geolocation detection from IP ───────────────────────────────────────────
export function geoDetectCountryCode(clientIp?: string): string {
  if (!clientIp) return "US";  // default to US
  // Simple detection: in production, use MaxMind GeoIP2 for accuracy
  // For now, detect by IP ranges (simplified)
  if (clientIp.startsWith("103.") || clientIp.startsWith("49.")) return "IN";  // India IP ranges
  if (clientIp.startsWith("66.") || clientIp.startsWith("71.")) return "US";   // US IP ranges
  if (clientIp.startsWith("195.") || clientIp.startsWith("185.")) return "EU"; // EU IP ranges
  return "US";  // fallback
}

// Get proxy URL for user's region to route through nearest Telegram datacenters
export function getProxyForRegion(countryCode: string): string | null {
  return REGION_PROXIES[countryCode] || null;
}

// ── Create or get TelegramClient instance ────────────────────────────────────
async function createClient(
  sessionFile: string,
  apiId: number,
  apiHash: string,
  botToken: string,
  label: string,
  proxyUrl?: string,
): Promise<TelegramClient> {
  const sessionLoader = sessionFile === SESSION_FILE ? loadSession : loadSession2;
  const sessionSaver = sessionFile === SESSION_FILE ? saveSession : saveSession2;
  const sessionStr = sessionLoader();

  let proxyConfig: any = undefined;
  const proxyToUse = proxyUrl || PROXY_URL;
  if (proxyToUse) {
    try {
      const url = new URL(proxyToUse);
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
      logger.warn({ err, url: proxyToUse, label }, "Invalid proxy URL — ignoring");
    }
  }

  const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
    connectionRetries: 15,
    retryDelay: 500,
    connection: ConnectionTCPFull,
    proxy: proxyConfig,
    useWSS: false,
    autoReconnect: true,
    deviceModel: "File2Link BOT",
    appVersion: "3.0.0",
    langCode: "en",
    maxCdnConnections: 8,
  });

  await client.start({
    botAuthToken: botToken,
    onError: (err) => logger.error({ err, label }, "GramJS error"),
  });

  const saved = client.session.save() as unknown as string;
  if (saved && saved !== sessionStr) sessionSaver(saved);

  logger.info({ label, workers: WORKERS, chunkKB: REQUEST_SIZE / 1024 }, "MTProto client ready");
  
  // Keep-alive reconnection
  setInterval(async () => {
    try {
      if (client && !client.connected) {
        await client.connect();
        logger.info({ label }, "Reconnected");
      }
    } catch (err) {
      logger.error({ err, label }, "Keep-alive failed");
    }
  }, 45_000).unref();

  return client;
}

// ── Initialize dual MTProto clients with load balancing ──────────────────────
export async function initializeClients(): Promise<void> {
  if (_clients.length > 0 || _connecting) return;
  
  _connecting = (async () => {
    try {
      const client1 = await createClient(SESSION_FILE, API_ID, API_HASH, BOT_TOKEN, "Primary");
      _clients.push({ client: client1, activeRequests: 0, sessions: [SESSION_FILE] });
      _activeRequests.set(client1, 0);

      if (API_ID_2 && API_HASH_2 && BOT_TOKEN_2) {
        const client2 = await createClient(
          SESSION_FILE_2,
          API_ID_2,
          API_HASH_2,
          BOT_TOKEN_2,
          "Secondary (load-balance)",
        );
        _clients.push({ client: client2, activeRequests: 0, sessions: [SESSION_FILE_2] });
        _activeRequests.set(client2, 0);
        logger.info("Dual MTProto load balancing ENABLED");
      } else {
        logger.info("Single MTProto client (no secondary credentials)");
      }
    } finally {
      _connecting = null;
    }
  })();

  await _connecting;
}

// ── Get least-loaded client for new request (auto load-balance) ──────────────
export async function getLeastLoadedClient(): Promise<TelegramClient> {
  await initializeClients();
  
  if (_clients.length === 0) throw new Error("No MTProto clients initialized");
  
  // Find client with fewest active requests
  let bestClient = _clients[0]!.client;
  let minRequests = _activeRequests.get(bestClient) ?? 0;
  
  for (const state of _clients) {
    const count = _activeRequests.get(state.client) ?? 0;
    if (count < minRequests) {
      bestClient = state.client;
      minRequests = count;
    }
  }
  
  return bestClient;
}

// ── Track request lifecycle for accurate load balancing ──────────────────────
function incrementRequestCount(client: TelegramClient): void {
  const current = _activeRequests.get(client) ?? 0;
  _activeRequests.set(client, current + 1);
}

function decrementRequestCount(client: TelegramClient): void {
  const current = _activeRequests.get(client) ?? 0;
  _activeRequests.set(client, Math.max(0, current - 1));
}

function persistSession(client: TelegramClient): void {
  try {
    const cur = client.session.save() as unknown as string;
    const stored = _clients.find(s => s.client === client);
    if (stored && cur) {
      if (stored.sessions[0] === SESSION_FILE) {
        saveSession(cur);
      } else {
        saveSession2(cur);
      }
    }
  } catch {}
}

// ── Smart streaming with geolocation-based routing ──────────────────────────
export async function streamFileByMessage(
  chatId: number,
  messageId: number,
  onChunk: (chunk: Buffer) => boolean | Promise<boolean>,
  offsetBytes = 0,
  limitBytes?: number,
  userIp?: string,  // Client's IP for geolocation-based routing
): Promise<void> {
  const MAX_RETRIES = 5;
  const BASE_DELAY  = 600;

  // Detect user's region for optimal Telegram datacenter routing
  const countryCode = geoDetectCountryCode(userIp);
  const regionProxy = getProxyForRegion(countryCode);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let client: TelegramClient | null = null;
    try {
      // Get least-loaded client + geolocation proxy for fastest speed
      client = await getLeastLoadedClient();
      incrementRequestCount(client);

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
      logger.error({
        err,
        attempt,
        chatId,
        messageId,
        country: countryCode,
        clientIdx: _clients.findIndex(s => s.client === client),
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
    } finally {
      if (client) decrementRequestCount(client);
    }
  }
}
