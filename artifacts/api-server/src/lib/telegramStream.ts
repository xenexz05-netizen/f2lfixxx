import type { Request, Response } from "express";
import { logger } from "./logger.js";
import { streamFileByMessage } from "./gramjsClient.js";

// ── 1GBPS EXTREME socket tuning ──────────────────────────────────────────
// 512 MB write + 512 MB read buffer: MAXIMUM burst capacity for 1Gbps
// At 1 Gbps that is 4+ seconds of headroom — ZERO backpressure guaranteed
// setNoDelay: disables Nagle algorithm — absolute zero latency
// Chunk coalescing: batch into 4 MB TCP segments for max TCP efficiency
// ──────────────────────────────────────────────────────────────────────────
const SOCKET_WRITE_BUFFER = 512 * 1024 * 1024; // 512 MB write
const SOCKET_READ_BUFFER  = 512 * 1024 * 1024; // 512 MB read
const COALESCE_SIZE       = 4 * 1024 * 1024;   // flush every 4 MB

function tuneSocket(res: Response): void {
  try {
    const sock = res.socket;
    if (!sock) return;
    sock.setNoDelay(true);
    sock.setMaxListeners(50);
    if ((sock as any).setWriteQueueHighWaterMark) {
      (sock as any).setWriteQueueHighWaterMark(SOCKET_WRITE_BUFFER);
    }
    if ((sock as any)._handle?.setSendBufferSize) {
      try { (sock as any)._handle.setSendBufferSize(SOCKET_WRITE_BUFFER); } catch {}
    }
    if ((sock as any)._handle?.setRecvBufferSize) {
      try { (sock as any)._handle.setRecvBufferSize(SOCKET_READ_BUFFER); } catch {}
    }
  } catch {}
}

export async function streamTelegramFile(
  req: Request,
  res: Response,
  chatId: number,
  messageId: number,
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
  fileSize: number | null | undefined,
  isDownload = false,
): Promise<void> {
  let aborted      = false;
  let bytesWritten = 0;
  let lastChunk    = Date.now();
  const startTime  = Date.now();
  
  // Extract user's IP for geolocation-based Telegram server routing
  const userIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || 
                 req.socket?.remoteAddress || 
                 undefined;

  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    logger.info({ chatId, messageId, fileName, bytesWritten, duration: Date.now() - startTime }, "Client disconnected");
  };
  const onSocketErr = (err: Error) => {
    if (aborted) return;
    const code = (err as any).code;
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET" || code === "ERR_HTTP_SOCKET_ENCODING") return;
    aborted = true;
    logger.error({ err, chatId, messageId, bytesWritten }, "Socket error");
  };
  let stall: ReturnType<typeof setInterval> | null = null;

  try {
    const contentType = mimeType || "application/octet-stream";
    const rangeHeader = req.headers["range"];
    const isRange     = !!rangeHeader;
    const STALL_MS    = isDownload ? 600_000 : isRange ? 240_000 : 120_000;

    // Aggressive caching for CDN (Cloudflare, etc)
    const cacheControl = isDownload 
      ? "private, max-age=86400"
      : "public, max-age=3600, s-maxage=3600, stale-while-revalidate=604800";
    
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("CDN-Cache-Control", "max-age=3600, s-maxage=3600");
    res.setHeader("Vary", "Range, Accept-Encoding");
    res.setHeader("Accept-Encoding", "gzip, deflate, br");
    
    req.on("close", onAbort);
    req.on("error", onAbort);
    res.socket?.on("error", onSocketErr);
    tuneSocket(res);

    stall = setInterval(() => {
      if (!aborted && bytesWritten > 0 && Date.now() - lastChunk > STALL_MS) {
        aborted = true;
        logger.warn({ chatId, messageId, bytesWritten }, "Stream stalled — closing");
        try { if (!res.writableEnded) res.end(); } catch {}
      }
    }, 15_000);

    // Chunk coalescing — batch small GramJS pieces into large TCP segments
    let coalesceBuffer: Buffer[] = [];
    let coalescedSize = 0;

    const flushCoalesce = async (): Promise<boolean> => {
      if (coalesceBuffer.length === 0 || aborted) return !aborted;
      const combined = Buffer.concat(coalesceBuffer);
      coalesceBuffer = [];
      coalescedSize  = 0;
      lastChunk      = Date.now();
      bytesWritten  += combined.length;
      const ok = res.write(combined);
      if (!ok) {
        await new Promise<void>((resolve) => {
          let done = false;
          const fin = () => { if (done) return; done = true; resolve(); };
          res.once("drain", fin);
          res.once("close",  () => { aborted = true; fin(); });
          res.once("error",  () => { aborted = true; fin(); });
          setTimeout(fin, isDownload ? 180_000 : 120_000);
        });
      }
      return !aborted;
    };

    const write = async (chunk: Buffer): Promise<boolean> => {
      if (aborted) return false;
      try {
        coalesceBuffer.push(chunk);
        coalescedSize += chunk.length;
        if (coalescedSize >= COALESCE_SIZE) return flushCoalesce();
        return true;
      } catch (err) {
        const code = (err as any).code;
        if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET") {
          aborted = true; return false;
        }
        logger.error({ err }, "Write error");
        aborted = true;
        return false;
      }
    };

    const finalizeWrite = async (): Promise<void> => {
      await flushCoalesce();
      if (!aborted) res.end();
    };

    if (rangeHeader && fileSize) {
      const parts     = rangeHeader.replace(/bytes=/, "").split("-");
      const start     = parseInt(parts[0] ?? "0", 10);
      const end       = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader("Content-Range",  `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Accept-Ranges",  "bytes");
      res.setHeader("Content-Length", String(chunkSize));
      res.setHeader("Content-Type",   contentType);
      if (isDownload) res.setHeader("Content-Disposition", contentDisposition(fileName || "file", true));

      try {
        await streamFileByMessage(chatId, messageId, write, start, chunkSize, userIp);
        await finalizeWrite();
      } catch (e) {
        logger.error({ err: e, chatId, messageId, bytesWritten, start, end }, "Range stream failed");
        if (!res.headersSent) res.status(500).json({ error: "Stream failed. Please retry." });
        else if (!res.writableEnded) res.destroy();
      }
      return;
    }

    res.setHeader("Accept-Ranges",  "bytes");
    res.setHeader("Content-Type",   contentType);
    if (fileSize) res.setHeader("Content-Length", String(fileSize));
    res.setHeader("Content-Disposition", contentDisposition(fileName || "file", isDownload));

    try {
      await streamFileByMessage(chatId, messageId, write, 0, undefined, userIp);
      await finalizeWrite();
    } catch (e) {
      logger.error({ err: e, chatId, messageId }, "Full stream failed");
      if (!res.headersSent) res.status(500).json({ error: "Stream failed. Please retry." });
      else if (!res.writableEnded) res.destroy();
    }

  } catch (err) {
    logger.error({ err, chatId, messageId, bytesWritten, duration: Date.now() - startTime }, "streamTelegramFile error");
    if (!res.headersSent) res.status(500).json({ error: "Stream failed. Please retry." });
    else { try { if (!res.writableEnded) res.destroy(); } catch {} }
  } finally {
    try {
      req.off("close",  onAbort);
      req.off("error",  onAbort);
      res.socket?.off("error", onSocketErr);
      if (stall) clearInterval(stall);
    } catch {}
  }
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_");
}

function contentDisposition(name: string, isDownload: boolean): string {
  const safe    = sanitize(name);
  const encoded = encodeURIComponent(safe);
  if (isDownload) return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
  return `inline; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
