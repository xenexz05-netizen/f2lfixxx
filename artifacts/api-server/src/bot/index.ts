import { Telegraf, Markup } from "telegraf";
import { db, filesTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { isStreamable, isAudio, generateFileId } from "../lib/fileUtils.js";
import { logger } from "../lib/logger.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID!;
const REQUIRED_CHANNEL_ID = -1003792781847;
const CHANNEL_USERNAME = "PrimeAutoBotz";
const BOT_USERNAME = "filetolink_05bot";

export const bot = new Telegraf(BOT_TOKEN);

/** Track every user so the Update Bot can broadcast to them */
async function upsertUser(ctx: any): Promise<void> {
  try {
    const userId = ctx.from?.id;
    if (!userId) return;
    const chatId    = ctx.chat?.id ?? userId;
    const username  = ctx.from?.username || null;
    const firstName = ctx.from?.first_name || null;
    const now       = new Date();
    const existing  = await db.select().from(usersTable).where(eq(usersTable.chatId, chatId)).limit(1);
    if (existing.length > 0) {
      await db.update(usersTable).set({ username, firstName, lastSeen: now, isActive: true }).where(eq(usersTable.chatId, chatId));
    } else {
      const { generateFileId } = await import("../lib/fileUtils.js");
      await db.insert(usersTable).values({ id: generateFileId(), chatId, username, firstName, isActive: true, createdAt: now, lastSeen: now });
    }
  } catch (err) {
    logger.warn({ err }, "upsertUser failed");
  }
}

function getBaseUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  return `http://localhost:${process.env.PORT || 8080}`;
}

/**
 * Check if user is a member of the required channel
 */
async function isUserChannelMember(userId: number): Promise<boolean> {
  try {
    const member = await bot.telegram.getChatMember(REQUIRED_CHANNEL_ID, userId);
    // Check if user is member, administrator, creator, or restricted (but still in channel)
    return ["member", "administrator", "creator", "restricted"].includes(member.status);
  } catch (err: any) {
    logger.error({ err: err?.message || err, userId }, "Error checking channel membership");
    return false;
  }
}

/**
 * Send force join message with buttons
 */
async function sendForceJoinMessage(ctx: any) {
  const joinButton = Markup.inlineKeyboard([
    [Markup.button.url("🚀 Join Channel", `https://t.me/${CHANNEL_USERNAME}`)],
    [Markup.button.callback("✅ Check Join", "check_join")],
  ]);

  await ctx.replyWithHTML(
    `🔒 <b>Join Channel</b>\n\n` +
    `You must join <b>${CHANNEL_USERNAME}</b> to use this bot.\n\n` +
    `👇 Click the button below to join ${CHANNEL_USERNAME} community and get started! 🌐`,
    joinButton,
  );
}

/**
 * Middleware to check channel membership for private messages
 */
bot.use(async (ctx, next) => {
  // Only check for private messages
  if (ctx.chat?.type !== "private") return next();

  const userId = ctx.from?.id;
  if (!userId) return next();

  // Check if user is member of required channel
  const isMember = await isUserChannelMember(userId);
  if (!isMember) {
    // Send force join message and don't proceed
    try {
      await sendForceJoinMessage(ctx);
    } catch (err: any) {
      // Handle gracefully if bot is blocked by user or other message send errors
      if (err?.response?.error_code === 403) {
        logger.warn({ userId, errorCode: 403 }, "Bot blocked by user, cannot send force join message");
      } else {
        logger.error({ err: err?.message || err, userId }, "Failed to send force join message");
      }
    }
    return;
  }

  // User is member, proceed
  return next();
});

/**
 * Handle "Check Join" button callback
 */
bot.action("check_join", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) {
    try {
      await ctx.answerCbQuery("❌ Error: Could not identify user", { show_alert: true });
    } catch (err) {
      logger.warn({ err }, "Failed to answer callback query");
    }
    return;
  }

  try {
    const isMember = await isUserChannelMember(userId);
    
    if (isMember) {
      // Delete the force join message
      try {
        await ctx.deleteMessage();
      } catch (err) {
        logger.warn({ err }, "Could not delete force join message");
      }
      
      // Show success alert and welcome message
      await ctx.answerCbQuery("✅ Welcome! You can now use the bot 🎉", { show_alert: true });
      await ctx.reply(
        `🎉 <b>Welcome to ${BOT_USERNAME}!</b>\n\n` +
        `You have successfully joined and can now use all bot features.\n\n` +
        `📤 Forward any file to me and I'll generate:\n` +
        `⬇️ A direct <b>download link</b>\n` +
        `▶️ A <b>stream link</b> for videos and audio\n\n` +
        `📤 <i>Just forward or send any file to get started!</i>`,
        { parse_mode: "HTML" }
      );
    } else {
      // Still not a member
      await ctx.answerCbQuery(
        "❌ You haven't joined the channel yet. Please join first by clicking the button above.",
        { show_alert: true }
      );
    }
  } catch (err: any) {
    // Handle gracefully if bot is blocked or other errors occur
    if (err?.response?.error_code === 403) {
      logger.warn({ userId, errorCode: 403 }, "Bot blocked by user, cannot process callback");
    } else {
      logger.error({ err: err?.message || err, userId }, "Error in check_join callback");
    }
  }
});

/**
 * Forward the file to the log channel and send a details message.
 * Returns the forwarded message's chatId and messageId so we can update
 * the DB — gramjs always has access to the log channel.
 */
async function logToChannel(
  fromChatId: number,
  fromMessageId: number,
  logText: string,
): Promise<{ logChatId: number; logMessageId: number } | null> {
  if (!LOG_CHANNEL_ID) {
    logger.warn("LOG_CHANNEL_ID is not set — skipping log channel forward");
    return null;
  }
  try {
    const forwarded = await bot.telegram.forwardMessage(
      LOG_CHANNEL_ID,
      fromChatId,
      fromMessageId,
    );
    await bot.telegram.sendMessage(LOG_CHANNEL_ID, logText, { parse_mode: "HTML" });
    logger.info({ logChatId: forwarded.chat.id, logMessageId: forwarded.message_id }, "Forwarded to log channel");
    return { logChatId: forwarded.chat.id, logMessageId: forwarded.message_id };
  } catch (err: any) {
    logger.error({ err: err?.message || err }, "Failed to forward to log channel — check that the bot is an admin in the channel and LOG_CHANNEL_ID is correct");
    return null;
  }
}

bot.start(async (ctx) => {
  await upsertUser(ctx);
  const startParam = ctx.startPayload;
  if (startParam) {
    try {
      const rows = await db.select().from(filesTable).where(eq(filesTable.id, startParam)).limit(1);
      if (rows.length > 0) {
        const file = rows[0]!;
        await db.update(filesTable).set({ accessCount: (file.accessCount || 0) + 1 }).where(eq(filesTable.id, startParam));
        const baseUrl = getBaseUrl();
        const streamable = file.isStreamable || isStreamable(file.mimeType);
        const audioFile = file.isAudio || isAudio(file.mimeType);
        const fileLabel = file.fileName || "File";

        let msg = `${getTypeEmoji(file.fileType || "document")} <b>${fileLabel}</b>\n`;
        if (file.mimeType) msg += `🗂 Type: <code>${file.mimeType}</code>\n`;
        if (file.fileSize) msg += `📦 Size: ${formatSize(file.fileSize)}\n`;

        const buttons = buildButtons(baseUrl, file.id, streamable || audioFile);
        await ctx.replyWithHTML(msg, buttons);
        return;
      }
    } catch (err) {
      logger.error({ err }, "Error looking up file from start param");
    }
  }

  await ctx.replyWithHTML(
    `🌐 <b>Welcome to File2Link BOT</b>\n\n` +
    `Forward any file to me and I'll generate:\n` +
    `⬇️ A direct <b>download link</b>\n` +
    `▶️ A <b>stream link</b> for videos and audio\n\n` +
    `📤 <i>Just forward or send any file to get started!</i>`,
  );
});

bot.on("message", async (ctx) => {
  if (ctx.chat?.type !== "private") return;
  await upsertUser(ctx);
  const msg = ctx.message as any;
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
  } else if (msg.sticker) {
    fileId = msg.sticker.file_id;
    fileUniqueId = msg.sticker.file_unique_id;
    fileName = "sticker.webp";
    mimeType = "image/webp";
    fileSize = msg.sticker.file_size || null;
    fileType = "sticker";
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
  const fromUserId = msg.from?.id || null;
  const fromUsername = msg.from?.username || msg.from?.first_name || null;
  const caption = msg.caption || null;
  const streamable = isStreamable(mimeType);
  const audioFile = isAudio(mimeType);
  const imageFile = (mimeType?.startsWith("image/") ?? false) || fileType === "photo" || fileType === "sticker";

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
        fromUserId,
        fromUsername,
        chatId,
        messageId,
        caption,
        duration,
        width,
        height,
        isStreamable: streamable,
        isAudio: audioFile,
      });
    }

    const baseUrl = getBaseUrl();
    const downloadUrl = `${baseUrl}/api/download/${recordId}`;
    const streamPageUrl = `${baseUrl}/api/stream-page/${recordId}`;
    const typeEmoji = getTypeEmoji(fileType);

    const canStreamOnline = streamable || audioFile;
    const showOnlineLink = canStreamOnline || imageFile;
    const onlineLabel = canStreamOnline ? "▶️ Stream Link" : "🖼 View Link";

    let replyText = `${typeEmoji} <b>${fileName || "File"}</b>\n`;
    if (mimeType) replyText += `🗂 Type: <code>${mimeType}</code>\n`;
    if (fileSize) replyText += `📦 Size: ${formatSize(fileSize)}\n`;
    if (duration) replyText += `⏱ Duration: ${formatDuration(duration)}\n`;
    replyText += `\n⬇️ <b>Download Link</b>\n<code>${downloadUrl}</code>\n`;
    if (showOnlineLink) {
      replyText += `\n${onlineLabel}\n<code>${streamPageUrl}</code>\n`;
    }
    replyText += `\n💡 <i>Tap a link to copy it. For the smoothest playback, open it in an <b>external browser</b> like Chrome, Safari or Firefox.</i> 🚀`;

    const buttons = buildButtons(baseUrl, recordId, canStreamOnline, imageFile);
    await ctx.replyWithHTML(replyText, {
      reply_parameters: { message_id: messageId },
      ...buttons,
    });

    const logMsg =
      `📥 <b>New File Received</b>\n` +
      `👤 From: ${fromUsername ? `@${fromUsername}` : "Unknown"} (${fromUserId})\n` +
      `${typeEmoji} File: ${fileName || "Untitled"}\n` +
      `🗂 Type: ${mimeType || fileType}\n` +
      `📦 Size: ${fileSize ? formatSize(fileSize) : "Unknown"}\n` +
      `🆔 ID: <code>${recordId}</code>\n` +
      `⬇️ <a href="${downloadUrl}">Download</a>` +
      (streamable || audioFile
        ? `\n▶️ <a href="${streamPageUrl}">Stream Online</a>`
        : imageFile
          ? `\n🖼 <a href="${streamPageUrl}">View Online</a>`
          : "");

    const logResult = await logToChannel(chatId, messageId, logMsg);
    if (logResult) {
      await db
        .update(filesTable)
        .set({ chatId: logResult.logChatId, messageId: logResult.logMessageId })
        .where(eq(filesTable.id, recordId));
    }
  } catch (err) {
    logger.error({ err }, "Error processing file message");
    await ctx.reply("❌ An error occurred while processing your file. Please try again.");
  }
});

function buildButtons(baseUrl: string, recordId: string, canStream: boolean, isImage = false) {
  const downloadUrl = `${baseUrl}/api/download/${recordId}`;
  const streamPageUrl = `${baseUrl}/api/stream-page/${recordId}`;

  if (canStream) {
    return Markup.inlineKeyboard([
      [
        Markup.button.url("⬇️ Download", downloadUrl),
        Markup.button.url("▶️ Stream Online", streamPageUrl),
      ],
    ]);
  }
  if (isImage) {
    return Markup.inlineKeyboard([
      [
        Markup.button.url("⬇️ Download", downloadUrl),
        Markup.button.url("🖼 View Online", streamPageUrl),
      ],
    ]);
  }
  return Markup.inlineKeyboard([
    [Markup.button.url("⬇️ Download", downloadUrl)],
  ]);
}

function getTypeEmoji(fileType: string): string {
  if (fileType === "video" || fileType === "animation" || fileType === "video_note") return "🎬";
  if (fileType === "audio" || fileType === "voice") return "🎵";
  if (fileType === "photo") return "🖼";
  if (fileType === "sticker") return "🎭";
  return "📄";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function startBot(): void {
  logger.info("Starting Telegram bot...");
  
  // Global error handler for unhandled errors in handlers
  bot.catch((err, ctx) => {
    const userId = ctx?.from?.id;
    const chatId = ctx?.chat?.id;
    
    if (err?.response?.error_code === 403) {
      // Bot is blocked by user - log as warning, not error
      logger.warn(
        { userId, chatId, errorCode: 403, errorMessage: err?.response?.description },
        "Bot blocked by user"
      );
    } else if (err?.code === "ETELEGRAM") {
      // Telegram API error
      logger.error(
        { userId, chatId, errorCode: err?.response?.error_code, description: err?.response?.description },
        "Telegram API error"
      );
    } else {
      // Other errors
      logger.error(
        { err, userId, chatId },
        "Error in bot handler"
      );
    }
  });
  
  bot.launch().catch((err) => logger.error({ err }, "Main bot crashed"));
  logger.info("Telegram bot started");
}
