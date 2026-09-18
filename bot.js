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

// ----------------------------------------------------
// RESEND SETTINGS
// ----------------------------------------------------

const resendApiKey = process.env.RESEND_API_KEY || "";

// Example:
// Jabari Promoter <promoter@yourdomain.com>
//
// This address/domain must be accepted by Resend.
const resendFrom = process.env.RESEND_FROM || "";

// Safety switch.
// false = no emails are actually sent.
// true  = Resend will actually send emails.
const sendEmails =
  String(process.env.SEND_EMAILS || "false").toLowerCase() === "true";

// ----------------------------------------------------
// CAMPAIGN DATA
// ----------------------------------------------------

const campaign = {
  blogUrl: process.env.BLOG_URL || "",
  blogTitle: process.env.BLOG_TITLE || "",
  blogDescription: process.env.BLOG_DESCRIPTION || ""
};

// Keeps track of what the owner is currently entering.
let waitingFor = null;

// ----------------------------------------------------
// OWNER CHECK
// ----------------------------------------------------

function isOwner(msg) {
  return ownerId && String(msg.from.id) === ownerId;
}

function accessDenied(msg) {
  return bot.sendMessage(
    msg.chat.id,
    "Access denied."
  );
}

// ----------------------------------------------------
// START
// ----------------------------------------------------

bot.onText(/\/start/, async (msg) => {
  if (!isOwner(msg)) return accessDenied(msg);

  waitingFor = null;

  await bot.sendMessage(
    msg.chat.id,
    `🤖 Jabari Promoter is online.

Mode: ${mode}

Email sending:
${sendEmails ? "🟢 Enabled" : "🔴 Disabled"}

Commands:

/status — Check bot status
/blog — Add or view blog
/campaign — View campaign
/test — Test campaign
/testemail — Test Resend email
/help — Show commands`
  );
});

// ----------------------------------------------------
// STATUS
// ----------------------------------------------------

bot.onText(/\/status/, async (msg) => {
  if (!isOwner(msg)) return;

  await bot.sendMessage(
    msg.chat.id,
    `✅ Bot is online.

Mode: ${mode}

Email sending:
${
  sendEmails
    ? "🟢 Enabled"
    : "🔴 Disabled (safe mode)"
}

Resend:
${
  resendApiKey
    ? "✅ API key detected"
    : "❌ API key missing"
}

Sender:
${
  resendFrom
    ? resendFrom
    : "❌ RESEND_FROM not configured"
}`
  );
});

// ----------------------------------------------------
// HELP
// ----------------------------------------------------

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
/testemail
/help

Use /blog to add the article you want to promote.

Use /testemail to test the Resend connection.

Emails remain disabled unless SEND_EMAILS=true.`
  );
});

// ----------------------------------------------------
// BLOG
// ----------------------------------------------------

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

// ----------------------------------------------------
// CAMPAIGN
// ----------------------------------------------------

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

Email sending:
${sendEmails ? "Enabled" : "Disabled"}

Next we will add prospect discovery and controlled outreach.`
  );
});

// ----------------------------------------------------
// TEST CAMPAIGN
// ----------------------------------------------------

bot.onText(/\/test$/, async (msg) => {
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

Mode:
${mode}

Email sending:
${
  sendEmails
    ? "🟢 Enabled"
    : "🔴 Disabled"
}

Use /testemail to test the Resend email connection.`
  );
});

// ----------------------------------------------------
// RESEND EMAIL FUNCTION
// ----------------------------------------------------

async function sendResendEmail({
  to,
  subject,
  html
}) {
  if (!resendApiKey) {
    throw new Error(
      "RESEND_API_KEY is missing."
    );
  }

  if (!resendFrom) {
    throw new Error(
      "RESEND_FROM is missing."
    );
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",

      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        from: resendFrom,
        to: [to],
        subject,
        html
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const errorMessage =
      data?.message ||
      data?.error ||
      "Resend returned an unknown error.";

    throw new Error(errorMessage);
  }

  return data;
}

// ----------------------------------------------------
// TEST RESEND EMAIL
// ----------------------------------------------------

bot.onText(/\/testemail/, async (msg) => {
  if (!isOwner(msg)) return;

  waitingFor = "testEmail";

  await bot.sendMessage(
    msg.chat.id,
    `📧 Resend email test

Send the email address that should receive the test.

Example:
you@example.com

${
  sendEmails
    ? "🟢 Email sending is ENABLED."
    : "🔴 Email sending is currently DISABLED. The test will only preview the email."
}`
  );
});

// ----------------------------------------------------
// NORMAL TEXT MESSAGES
// ----------------------------------------------------

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (!isOwner(msg)) return;

  const text = msg.text.trim();

  // Ignore commands.
  if (text.startsWith("/")) return;

  // --------------------------------------------------
  // TEST EMAIL RECIPIENT
  // --------------------------------------------------

  if (waitingFor === "testEmail") {
    waitingFor = null;

    const recipient = text;

    // Basic email validation.
    const emailPattern =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(recipient)) {
      return bot.sendMessage(
        msg.chat.id,
        "❌ That doesn't look like a valid email address.\n\nUse /testemail to try again."
      );
    }

    const title =
      campaign.blogTitle ||
      "Jabari Promoter Test";

    const blogUrl =
      campaign.blogUrl ||
      "https://example.com";

    const description =
      campaign.blogDescription ||
      "This is a test email from Jabari Promoter.";

    const subject =
      `Jabari Promoter — ${title}`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>

<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">

  <div style="max-width:600px;margin:30px auto;background:#ffffff;padding:30px;border-radius:12px;">

    <h1 style="margin-top:0;">
      ${escapeHtml(title)}
    </h1>

    <p>
      ${escapeHtml(description)}
    </p>

    <p>
      This is a test email sent through
      <strong>Jabari Promoter</strong>.
    </p>

    <p>
      <a
        href="${escapeAttribute(blogUrl)}"
        style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;"
      >
        Read the article
      </a>
    </p>

    <hr style="border:none;border-top:1px solid #ddd;margin:25px 0;">

    <p style="font-size:12px;color:#777;">
      Jabari Promoter test message.
    </p>

  </div>

</body>
</html>
`;

    // ------------------------------------------------
    // SAFE MODE
    // ------------------------------------------------

    if (!sendEmails) {
      return bot.sendMessage(
        msg.chat.id,
        `🧪 Resend test prepared.

Recipient:
${recipient}

Subject:
${subject}

Status:
🔴 NOT SENT

SEND_EMAILS is currently false, so no email was delivered.

Set SEND_EMAILS=true in Render when you're ready to perform the real test.`
      );
    }

    // ------------------------------------------------
    // SEND THROUGH RESEND
    // ------------------------------------------------

    await bot.sendMessage(
      msg.chat.id,
      `📤 Sending test email...

To:
${recipient}`
    );

    try {
      const result =
        await sendResendEmail({
          to: recipient,
          subject,
          html
        });

      await bot.sendMessage(
        msg.chat.id,
        `✅ Test email sent successfully.

Recipient:
${recipient}

Resend ID:
${result.id || "Not returned"}

Check the recipient inbox.`
      );

    } catch (error) {
      console.error(
        "Resend email error:",
        error
      );

      await bot.sendMessage(
        msg.chat.id,
        `❌ Resend failed.

Reason:
${error.message}

Check:
• RESEND_API_KEY
• RESEND_FROM
• Your Resend sender/domain
• Resend account status`
      );
    }

    return;
  }

  // --------------------------------------------------
  // BLOG URL
  // --------------------------------------------------

  if (waitingFor === "blogUrl") {
    campaign.blogUrl = text;
    waitingFor = "blogTitle";

    return bot.sendMessage(
      msg.chat.id,
      `✅ Blog URL received.

Now send me the title of the blog post.`
    );
  }

  // --------------------------------------------------
  // BLOG TITLE
  // --------------------------------------------------

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

  // --------------------------------------------------
  // BLOG DESCRIPTION
  // --------------------------------------------------

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

Use /campaign to view it.

Use /testemail to test Resend.`
    );
  }
});

// ----------------------------------------------------
// HTML SAFETY HELPERS
// ----------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ----------------------------------------------------
// TELEGRAM POLLING ERROR
// ----------------------------------------------------

bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});

// ----------------------------------------------------
// RENDER WEB SERVICE PORT
// ----------------------------------------------------

const PORT =
  process.env.PORT || 10000;

http
  .createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end(
      "Jabari Promoter is running."
    );
  })
  .listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `Jabari Promoter is running on port ${PORT}`
      );
    }
  );
