import { Telegraf } from "telegraf";
import { db, filesTable, broadcastsTable } from "@workspace/db";
import { eq, inArray, desc } from "drizzle-orm";
import type { BroadcastRecord } from "@workspace/db";
import { isStreamable, isAudio, generateFileId } from "../lib/fileUtils.js";
import { logger } from "../lib/logger.js";
import { broadcastSse } from "../lib/sseClients.js";

const PUSH_BOT_TOKEN = process.env.PUSH_BOT_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; // Optional

export const pushBot = PUSH_BOT_TOKEN ? new Telegraf(PUSH_BOT_TOKEN) : null;

type ClearState = { step: "awaitingSelection"; items: BroadcastRecord[] };
const clearStates = new Map<number, ClearState>();

function getBaseUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  return `http://localhost:${process.env.PORT || 8080}`;
}

async function forwardToLogChannel(
  fromChatId: number,
  fromMessageId: number,
): Promise<{ logChatId: number; logMessageId: number } | null> {
  if (!LOG_CHANNEL_ID) {
    logger.debug("Log channel not configured (LOG_CHANNEL_ID not set) — file will be stored from bot DM");
    return null;
  }
  
  if (!pushBot) return null;
  
  try {
    // Ensure channel ID is properly formatted
    const channelId = String(LOG_CHANNEL_ID).trim();
    
    logger.info({ 
      channelId,
      channelIdType: typeof LOG_CHANNEL_ID,
      fromChatId, 
      fromMessageId,
      fromChatIdType: typeof fromChatId,
      fromMessageIdType: typeof fromMessageId
    }, "Attempting forwardMessage to log channel");
    
    const forwarded = await pushBot.telegram.forwardMessage(
      channelId,
      fromChatId,
      fromMessageId,
    );
    
    logger.info({ 
      logChatId: forwarded.chat.id, 
      logMessageId: forwarded.message_id, 
      channelId
    }, "✅ Successfully forwarded to log channel");
    
    return { logChatId: forwarded.chat.id, logMessageId: forwarded.message_id };
  } catch (err: any) {
    // Extract all possible error fields
    const errorCode = err?.error_code ?? err?.response?.error_code ?? err?.statusCode ?? err?.code ?? "UNKNOWN";
    const errorDesc = err?.description ?? err?.message ?? String(err);
    const errFull = {
      message: err?.message,
      description: err?.description,
      error_code: err?.error_code,
      code: err?.code,
      statusCode: err?.statusCode,
      response: err?.response,
      stack: err?.stack?.split('\n')[0]
    };
    
    logger.error({ 
      errorCode, 
      errorDesc,
      errFull,
      LOG_CHANNEL_ID, 
      fromChatId, 
      messageId: fromMessageId 
    }, "❌ forwardMessage failed to log channel");
    
    return null;
  }
}

if (pushBot) {
  // Log every incoming update FIRST so we can see what reaches the bot,
  // even when downstream handlers don't call next()
  pushBot.use(async (ctx, next) => {
    try {
      const u = ctx.from;
      const msg: any = ctx.message;
      const kind = msg
        ? (msg.text ? `text:${(msg.text as string).slice(0, 24)}` :
           msg.photo ? "photo" :
           msg.video ? "video" :
           msg.document ? `document:${msg.document?.mime_type || "?"}` :
           msg.audio ? "audio" :
           msg.voice ? "voice" :
           msg.animation ? "animation" :
           msg.video_note ? "video_note" :
           msg.sticker ? "sticker" :
           "other")
        : (ctx.updateType || "update");
      logger.info({ from: u?.username || u?.id, chat: ctx.chat?.id, kind }, "Push bot: incoming");
    } catch {}
    await next();
  });

  pushBot.catch((err: any, ctx) => {
    logger.error({ err: err?.message || err, stack: err?.stack, updateType: ctx.updateType }, "Push bot: handler crashed");
  });

  pushBot.start(async (ctx) => {
    const logChannelStatus = LOG_CHANNEL_ID 
      ? "✅ Log channel configured"
      : "⚠️ No log channel configured (LOG_CHANNEL_ID env not set) — file streaming may be limited";
    
    await ctx.reply(
      "✅ Push bot ready.\n\n" +
      "Send me any text or file to broadcast it to every stream page.\n" +
      `${logChannelStatus}\n\n` +
      "Commands:\n" +
      "/clear — choose which messages to remove\n" +
      "/cancel — cancel current operation",
    );
  });

  pushBot.command("cancel", async (ctx) => {
    const userId = ctx.from.id;
    if (clearStates.has(userId)) {
      clearStates.delete(userId);
      await ctx.reply("❌ Operation cancelled.");
    } else {
      await ctx.reply("Nothing to cancel.");
    }
  });

  pushBot.command("clear", async (ctx) => {
    const userId = ctx.from.id;
    try {
      const items = await db
        .select()
        .from(broadcastsTable)
        .orderBy(desc(broadcastsTable.createdAt))
        .limit(20);

      if (items.length === 0) {
        await ctx.reply("📭 No messages on the stream pages right now.");
        return;
      }

      clearStates.set(userId, { step: "awaitingSelection", items });

      const list = items
        .map((b, i) => {
          let label = "";
          if (b.type === "file") {
            const kind =
              b.fileType === "photo" ? "🖼 Image" :
              b.fileType === "video" || b.fileType === "animation" || b.fileType === "video_note" ? "🎬 Video" :
              b.fileType === "audio" || b.fileType === "voice" ? "🎵 Audio" :
              "📎 File";
            label = `${kind} — ${b.fileName || "untitled"}`;
          } else {
            const text = (b.content || "").replace(/\n/g, " ").trim();
            label = text.length > 60 ? `${text.slice(0, 60)}…` : (text || "(empty)");
          }
          return `${i + 1}. ${label}`;
        })
        .join("\n");

      await ctx.reply(
        `📋 Current messages on the stream pages:\n\n${list}\n\n` +
        `Reply with the number(s) to remove (e.g. 1  or  1,3  or  all)\n` +
        `or /cancel to do nothing.`,
      );
    } catch (err) {
      logger.error({ err }, "Push bot: /clear error");
      await ctx.reply("❌ Failed to fetch messages.");
    }
  });

  pushBot.on("message", async (ctx) => {
    const msg = ctx.message as any;
    const userId = ctx.from?.id;
    if (!userId) return;

    const state = clearStates.get(userId);

    if (state && msg.text) {
      clearStates.delete(userId);

      const input = msg.text.trim().toLowerCase();
      const { items } = state;
      let toRemove: BroadcastRecord[] = [];

      if (input === "all") {
        toRemove = items;
      } else {
        const nums = input.split(/[\s,]+/).map(Number).filter((n) => !isNaN(n) && n >= 1 && n <= items.length);
        if (nums.length === 0) {
          await ctx.reply("⚠️ Invalid input. Type numbers like 1 or 1,2,3 or all. Use /clear to try again.");
          return;
        }
        toRemove = nums.map((n) => items[n - 1]!);
      }

      try {
        const ids = toRemove.map((b) => b.id);
        await db.delete(broadcastsTable).where(inArray(broadcastsTable.id, ids));
        for (const b of toRemove) {
          broadcastSse({ type: "delete", id: b.id });
        }
        const names = toRemove
          .map((b, i) => {
            if (b.type === "file") {
              const kind =
                b.fileType === "photo" ? "🖼 Image" :
                b.fileType === "video" || b.fileType === "animation" || b.fileType === "video_note" ? "🎬 Video" :
                b.fileType === "audio" || b.fileType === "voice" ? "🎵 Audio" :
                "📎 File";
              return `${i + 1}. ${kind} — ${b.fileName || "untitled"}`;
            }
            const t = (b.content || "").slice(0, 50);
            return `${i + 1}. ${t}${(b.content || "").length > 50 ? "…" : ""}`;
          })
          .join("\n");
        await ctx.reply(`✅ Removed ${toRemove.length} message(s) from the stream pages:\n\n${names}`);
      } catch (err) {
        logger.error({ err }, "Push bot: delete error");
        await ctx.reply("❌ Failed to remove messages.");
      }
      return;
    }

    if (msg.text && !msg.text.startsWith("/")) {
      try {
        const id = generateFileId();
        const now = new Date();
        await db.insert(broadcastsTable).values({
          id,
          type: "text",
          content: msg.text,
          createdAt: now,
        });
        broadcastSse({ id, type: "text", content: msg.text, createdAt: now.toISOString() });
        await ctx.reply("✅ Message pushed to the site!");
      } catch (err) {
        logger.error({ err }, "Push bot: error saving text broadcast");
        await ctx.reply("❌ Failed to push message.");
      }
      return;
    }

    let fileId: string | null = null;
    let fileUniqueId: string | null = null;
    let fileName: string | null = null;
    let mimeType: string | null = null;
    let fileSize: number | null = null;
    let fileType = "document";
    let duration: number | null = null;
    let width: number | null = null;
    let height: number | null = null;

    if (msg.document) {
      fileId = msg.document.file_id;
      fileUniqueId = msg.document.file_unique_id;
      fileName = msg.document.file_name || null;
      mimeType = msg.document.mime_type || null;
      fileSize = msg.document.file_size || null;
      fileType = "document";
    } else if (msg.video) {
      fileId = msg.video.file_id;
      fileUniqueId = msg.video.file_unique_id;
      fileName = msg.video.file_name || null;
      mimeType = msg.video.mime_type || "video/mp4";
      fileSize = msg.video.file_size || null;
      fileType = "video";
      duration = msg.video.duration || null;
      width = msg.video.width || null;
      height = msg.video.height || null;
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      fileUniqueId = msg.audio.file_unique_id;
      fileName = msg.audio.file_name || msg.audio.title || null;
      mimeType = msg.audio.mime_type || "audio/mpeg";
      fileSize = msg.audio.file_size || null;
      fileType = "audio";
      duration = msg.audio.duration || null;
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      fileUniqueId = msg.voice.file_unique_id;
      fileName = "voice_message.ogg";
      mimeType = msg.voice.mime_type || "audio/ogg";
      fileSize = msg.voice.file_size || null;
      fileType = "voice";
      duration = msg.voice.duration || null;
    } else if (msg.video_note) {
      fileId = msg.video_note.file_id;
      fileUniqueId = msg.video_note.file_unique_id;
      fileName = "video_note.mp4";
      mimeType = "video/mp4";
      fileSize = msg.video_note.file_size || null;
      fileType = "video_note";
      duration = msg.video_note.duration || null;
    } else if (msg.animation) {
      fileId = msg.animation.file_id;
      fileUniqueId = msg.animation.file_unique_id;
      fileName = msg.animation.file_name || "animation.mp4";
      mimeType = msg.animation.mime_type || "video/mp4";
      fileSize = msg.animation.file_size || null;
      fileType = "animation";
      duration = msg.animation.duration || null;
    } else if (msg.photo && msg.photo.length > 0) {
      const photo = msg.photo[msg.photo.length - 1];
      fileId = photo.file_id;
      fileUniqueId = photo.file_unique_id;
      fileName = "photo.jpg";
      mimeType = "image/jpeg";
      fileSize = photo.file_size || null;
      fileType = "photo";
      width = photo.width || null;
      height = photo.height || null;
    } else {
      return;
    }

    if (!fileId || !fileUniqueId) return;

    const chatId = ctx.chat.id;
    const messageId = msg.message_id;
    const streamable = isStreamable(mimeType) || (fileType === "photo"); // Images are streamable
    const audioFile = isAudio(mimeType);

    try {
      const existing = await db.select().from(filesTable).where(eq(filesTable.fileUniqueId, fileUniqueId)).limit(1);
      let recordId: string;

      if (existing.length > 0) {
        recordId = existing[0]!.id;
        await db.update(filesTable).set({ fileId, chatId, messageId }).where(eq(filesTable.id, recordId));
      } else {
        recordId = generateFileId();
        await db.insert(filesTable).values({
          id: recordId,
          fileId,
          fileUniqueId,
          fileName,
          mimeType,
          fileSize,
          fileType,
          chatId,
          messageId,
          duration,
          width,
          height,
          isStreamable: streamable,
          isAudio: audioFile,
        });
      }

      const logResult = await forwardToLogChannel(chatId, messageId);
      if (logResult) {
        // Update file to point to log channel for streaming
        await db.update(filesTable)
          .set({ chatId: logResult.logChatId, messageId: logResult.logMessageId })
          .where(eq(filesTable.id, recordId));
        logger.info({ fileId: recordId, fileType, fileName }, "Push bot: file stored in log channel");
      } else if (LOG_CHANNEL_ID) {
        // Log channel configured but forwarding failed — still allow the push
        // but warn the user that streaming may not work
        logger.warn({ fileId: recordId, LOG_CHANNEL_ID }, "Push bot: forwarding to log channel failed, file stored from bot DM");
        await ctx.reply(
          "⚠️ File pushed to site, but **couldn't forward to log channel**.\n\n" +
          "**Streaming may not work** — Check these fixes:\n\n" +
          "1️⃣ Make sure LOG_CHANNEL_ID is set correctly in your .env\n" +
          "2️⃣ Add bot as Admin in your channel\n" +
          "3️⃣ Grant 'Post Messages' permission\n" +
          "4️⃣ Check PM2 logs: pm2 logs file2link\n\n" +
          "For now, download should still work."
        );
      } else {
        // No log channel configured — file stored from bot DM
        logger.info({ fileId: recordId, fileType, fileName }, "Push bot: file stored from bot DM (no log channel configured)");
      }

      const baseUrl = getBaseUrl();
      const broadcastId = generateFileId();
      const now = new Date();
      await db.insert(broadcastsTable).values({
        id: broadcastId,
        type: "file",
        fileId: recordId,
        fileName: fileName || "File",
        mimeType: mimeType || null,
        fileType,
        createdAt: now,
      });

      broadcastSse({
        id: broadcastId,
        type: "file",
        fileId: recordId,
        fileName: fileName || "File",
        mimeType: mimeType || null,
        fileType,
        canStream: streamable || audioFile,
        streamUrl: `${baseUrl}/api/stream-page/${recordId}`,
        downloadUrl: `${baseUrl}/api/download/${recordId}`,
        createdAt: now.toISOString(),
      });

      await ctx.reply(`✅ File pushed to the site!\n🆔 ${recordId}`);
    } catch (err) {
      logger.error({ err }, "Push bot: error saving file broadcast");
      await ctx.reply("❌ Failed to push file.");
    }
  });
}

export function startPushBot(): void {
  if (!pushBot) {
    logger.warn("PUSH_BOT_TOKEN not set — push bot disabled");
    return;
  }

  logger.info("Starting push bot...");
  // Wipe any stale webhook + pending updates that would block long polling
  pushBot.telegram.deleteWebhook({ drop_pending_updates: false })
    .catch((err) => logger.warn({ err: err?.message }, "Push bot: deleteWebhook failed (likely no webhook set)"));

  // Identify which bot the user should DM and verify log channel access
  pushBot.telegram.getMe()
    .then(async (me) => {
      logger.info({ username: me.username, id: me.id }, "Push bot identity — DM this username to push content");
      
      // Test log channel access if configured
      if (LOG_CHANNEL_ID) {
        try {
          const channelIdStr = String(LOG_CHANNEL_ID).trim();
          logger.info({ channelIdStr }, "Testing channel access with getChat...");
          
          const chatInfo = await pushBot!.telegram.getChat(channelIdStr);
          logger.info({ 
            LOG_CHANNEL_ID,
            chatType: chatInfo.type,
            chatTitle: (chatInfo as any).title || chatInfo.username || "unknown",
            chatId: chatInfo.id
          }, "✅ Push bot CAN access log channel (getChat succeeded)");
        } catch (testErr: any) {
          const errorCode = testErr?.error_code ?? testErr?.response?.error_code ?? testErr?.code ?? "UNKNOWN";
          const errorDesc = testErr?.description ?? testErr?.message ?? String(testErr);
          const errFull = {
            message: testErr?.message,
            description: testErr?.description,
            error_code: testErr?.error_code,
            code: testErr?.code,
            response: testErr?.response
          };
          
          logger.error({ 
            LOG_CHANNEL_ID, 
            channelIdStr: LOG_CHANNEL_ID,
            errorCode, 
            errorDesc,
            errFull
          }, "❌ Push bot CANNOT access log channel with getChat — check LOG_CHANNEL_ID format and bot permissions");
        }
      } else {
        logger.warn("LOG_CHANNEL_ID not configured — file streaming will be limited to downloads only");
      }
    })
    .catch((err) => logger.error({ err: err?.message, stack: err?.stack }, "Push bot getMe failed — token invalid?"));

  pushBot.launch({ dropPendingUpdates: true })
    .catch((err) => logger.error({ err: err?.message || err }, "Push bot crashed"));
  logger.info("Push bot launched");
}
