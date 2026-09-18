require("dotenv").config();

const http = require("http");
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

// Temporary campaign data.
// We will move this to permanent storage later.
const campaign = {
  blogUrl: process.env.BLOG_URL || "",
  blogTitle: process.env.BLOG_TITLE || "",
  blogDescription: process.env.BLOG_DESCRIPTION || ""
};

// Keeps track of what the owner is currently entering.
let waitingFor = null;

function isOwner(msg) {
  return ownerId && String(msg.from.id) === ownerId;
}

function accessDenied(msg) {
  return bot.sendMessage(msg.chat.id, "Access denied.");
}

// START
bot.onText(/\/start/, async (msg) => {
  if (!isOwner(msg)) return accessDenied(msg);

  waitingFor = null;

  await bot.sendMessage(
    msg.chat.id,
    `🤖 Jabari Promoter is online.

Mode: ${mode}

Commands:

/status — Check bot status
/blog — Add or view blog
/campaign — View campaign
/test — Test campaign
/help — Show commands`
  );
});

// STATUS
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

// HELP
bot.onText(/\/help/, async (msg) => {
  if (!isOwner(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    `🤖 Jabari Promoter

Available commands:

/start
/status
/blog
/campaign
/test
/help

Use /blog to add the article you want to promote.`
  );
});

// BLOG
bot.onText(/\/blog/, async (msg) => {
  if (!isOwner(msg)) return;

  waitingFor = "blogUrl";

  await bot.sendMessage(
    msg.chat.id,
    `📝 Let's add your blog post.

Send me the full blog post URL.

Example:
https://example.com/my-blog-post`
  );
});

// CAMPAIGN
bot.onText(/\/campaign/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!campaign.blogUrl) {
    return bot.sendMessage(
      msg.chat.id,
      "⚠️ No blog post has been added yet.\n\nUse /blog first."
    );
  }

  await bot.sendMessage(
    msg.chat.id,
    `📣 Current campaign

Title:
${campaign.blogTitle || "Not set"}

URL:
${campaign.blogUrl}

Description:
${campaign.blogDescription || "Not set"}

Mode:
${mode}

Next we will add prospect discovery and personalized outreach.`
  );
});

// TEST
bot.onText(/\/test/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!campaign.blogUrl) {
    return bot.sendMessage(
      msg.chat.id,
      "⚠️ Add a blog post first with /blog."
    );
  }

  await bot.sendMessage(
    msg.chat.id,
    `🧪 Test campaign

Blog:
${campaign.blogTitle || "Untitled"}

${campaign.blogUrl}

Mode: ${mode}

No emails will actually be sent while dry-run is active.`
  );
});

// NORMAL TEXT MESSAGES
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (!isOwner(msg)) return;

  const text = msg.text.trim();

  // Ignore commands.
  if (text.startsWith("/")) return;

  if (waitingFor === "blogUrl") {
    campaign.blogUrl = text;
    waitingFor = "blogTitle";

    return bot.sendMessage(
      msg.chat.id,
      `✅ Blog URL received.

Now send me the title of the blog post.`
    );
  }

  if (waitingFor === "blogTitle") {
    campaign.blogTitle = text;
    waitingFor = "blogDescription";

    return bot.sendMessage(
      msg.chat.id,
      `✅ Title saved.

Now send me a short description of the article.

This will later help the bot create relevant outreach messages.`
    );
  }

  if (waitingFor === "blogDescription") {
    campaign.blogDescription = text;
    waitingFor = null;

    return bot.sendMessage(
      msg.chat.id,
      `✅ Blog campaign information saved.

Title:
${campaign.blogTitle}

URL:
${campaign.blogUrl}

Description:
${campaign.blogDescription}

Use /campaign to view it or /test to run a dry-run test.`
    );
  }
});

// ----------------------------------------------------
// RENDER WEB SERVICE HEALTH SERVER
// ----------------------------------------------------

const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("Jabari Promoter is running.");
  })
  .listen(PORT, "0.0.0.0", () => {
    console.log(`Jabari Promoter is running on port ${PORT}`);
  });
