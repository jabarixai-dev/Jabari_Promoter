require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new TelegramBot(token, {
  polling: true
});

const ownerId = String(process.env.BOT_OWNER_ID || "");
const mode = process.env.MODE || "dry-run";

function isOwner(msg) {
  return ownerId && String(msg.from.id) === ownerId;
}

bot.onText(/\/start/, async (msg) => {
  if (!isOwner(msg)) {
    return bot.sendMessage(msg.chat.id, "Access denied.");
  }

  await bot.sendMessage(
    msg.chat.id,
    `🤖 Jabari Promoter is online.

Mode: ${mode}

Commands:
/status — Check bot status
/blog — View blog
/test — Test campaign
/help — Show commands`
  );
});

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    `✅ Bot is online.

Mode: ${mode}
Sending: ${
      mode === "dry-run"
        ? "Disabled (test mode)"
        : "Enabled"
    }`
  );
});

bot.onText(/\/help/, async (msg) => {
  if (!isOwner(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    `Jabari Promoter commands:

/start
/status
/blog
/test
/help`
  );
});

bot.onText(/\/blog/, async (msg) => {
  if (!isOwner(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    `Current blog:

Title: ${process.env.BLOG_TITLE || "Not set"}
URL: ${process.env.BLOG_URL || "Not set"}
Description: ${
      process.env.BLOG_DESCRIPTION || "Not set"
    }`
  );
});

bot.onText(/\/test/, async (msg) => {
  if (!isOwner(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    `🧪 Test campaign started.

Blog:
${process.env.BLOG_URL || "No blog URL configured"}

Mode: ${mode}

No emails will actually be sent while MODE=dry-run.`
  );
});

console.log("Jabari Promoter is running...");
