import app from "./app.js";
import { logger } from "./lib/logger.js";
import { startBot } from "./bot/index.js";
import { startPushBot } from "./bot/pushBot.js";
import { getGramjsClient } from "./lib/gramjsClient.js";
import { startCleanupJob } from "./lib/cleanupJob.js";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

app.listen(port, (err?: Error) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }

  logger.info({ port }, "Server listening");

  startBot();
  startPushBot();
  startCleanupJob();

  // Warm up GramJS client in background — ready before first request
  getGramjsClient().catch((gramErr) => {
    logger.error({ err: gramErr }, "Failed to init MTProto client");
  });
});

process.once("SIGINT",  () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
