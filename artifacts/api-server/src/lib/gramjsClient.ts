import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { ConnectionTCPFull } from "telegram/network/connection/TCPFull.js";
import bigInt from "big-integer";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger.js";

const API_ID    = parseInt(process.env.TELEGRAM_API_ID!, 10);
const API_HASH  = process.env.TELEGRAM_API_HASH!;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const SESSION_FILE = path.resolve("telegram_session.txt");

// ── Ultra-speed tuning (100+ Mbps) ────────────────────────────────────────────
// 8 MB chunks × 32 workers = 256 MB in-flight simultaneously
// 8 MB = 2× Telegram MTProto max → optimized for large files
// 32 workers = maximum parallelism for sustained 100+ Mbps
// No forced DC — GramJS auto-selects nearest/fastest datacenter
// Aggressive retries with exponential backoff for reliability
// ─────────────────────────────────────────────────────────────────────────────
const REQUEST_SIZE = 8 * 1024 * 1024;  // 8 MB — 2× MTProto for batching
const WORKERS      = 32;               // 32 parallel workers → 256 MB in-flight
const PROXY_URL    = process.env.TELEGRAM_PROXY;

let _client: TelegramClient | null = null;
let _connecting: Promise<TelegramClient> | null = null;

function loadSession(): string {
  const env = process.env.TELEGRAM_SESSION?.trim();
  if (env) return env;
  try { return fs.readFileSync(SESSION_FILE, "utf-8").trim(); } catch { return ""; }
}

function saveSession(session: string): void {
  if (process.env.TELEGRAM_SESSION) return;
  try { fs.writeFileSync(SESSION_FILE, session, "utf-8"); } catch (err) {
    logger.warn({ err }, "Could not save session file");
  }
}

export async function getGramjsClient(): Promise<TelegramClient> {
  if (_client?.connected) return _client;
  if (_client && !_client.connected) _client = null;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    const sessionStr = loadSession();

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
          logger.info({ proxy: url.hostname }, "Using SOCKS5 proxy");
        }
      } catch (err) {
        logger.warn({ err, url: PROXY_URL }, "Invalid TELEGRAM_PROXY — ignoring");
      }
    }

    const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, {
      connectionRetries: 15,
      retryDelay: 500,
      connection: ConnectionTCPFull,
      proxy: proxyConfig,
      useWSS: false,
      autoReconnect: true,
      deviceModel: "File2Link BOT",
      appVersion: "3.0.0",
      langCode: "en",
      // Faster reconnect, more aggressive retries
      maxCdnConnections: 8,
    });

    await client.start({
      botAuthToken: BOT_TOKEN,
      onError: (err) => logger.error({ err }, "GramJS error"),
    });

    const saved = client.session.save() as unknown as string;
    if (saved && saved !== sessionStr) saveSession(saved);

    logger.info({ workers: WORKERS, chunkKB: REQUEST_SIZE / 1024 }, "GramJS connected");
    _client = client;
    _connecting = null;

    // Lightweight keep-alive — just checks connection, no polling
    setInterval(async () => {
      try {
        if (_client && !_client.connected) {
          await _client.connect();
          logger.info("GramJS reconnected");
        }
      } catch (err) {
        logger.error({ err }, "Keep-alive reconnect failed");
        _client = null;
      }
    }, 45_000).unref();

    return client;
  })();

  return _connecting;
}

function persistSession(client: TelegramClient): void {
  try {
    const cur = client.session.save() as unknown as string;
    const stored = loadSession();
    if (cur && cur !== stored) saveSession(cur);
  } catch {}
}

export async function streamFileByMessage(
  chatId: number,
  messageId: number,
  onChunk: (chunk: Buffer) => boolean | Promise<boolean>,
  offsetBytes = 0,
  limitBytes?: number,
): Promise<void> {
  const MAX_RETRIES = 5;
  const BASE_DELAY  = 600;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const client = await getGramjsClient();
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
      logger.error({ err, attempt, chatId, messageId }, "Stream attempt failed");

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
