require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

// Telegram uses a webhook on Render instead of long polling.
const bot = new TelegramBot(token, {
  polling: false
});

const ownerId = String(process.env.BOT_OWNER_ID || "");
const mode = process.env.MODE || "dry-run";

// ----------------------------------------------------
// GOOGLE GMAIL SETTINGS
// ----------------------------------------------------

const googleClientId =
  process.env.GOOGLE_CLIENT_ID || "";

const googleClientSecret =
  process.env.GOOGLE_CLIENT_SECRET || "";

const googleRefreshToken =
  process.env.GOOGLE_REFRESH_TOKEN || "";

const googleRedirectUri =
  process.env.GOOGLE_REDIRECT_URI ||
  "https://jabari-promoter.onrender.com/oauth2callback";

const gmailScope =
  "https://www.googleapis.com/auth/gmail.send";

let oauthState = null;

// ----------------------------------------------------
// CAMPAIGN
// ----------------------------------------------------

const campaign = {
  blogUrl: process.env.BLOG_URL || "",
  blogTitle: process.env.BLOG_TITLE || "",
  blogDescription: process.env.BLOG_DESCRIPTION || ""
};

async function loadCampaign() {
  const { data, error } = await supabase
    .from("promoter_campaign")
    .select("blog_url, blog_title, blog_description")
    .eq("id", 1)
    .single();

  if (error) {
    console.error(
      "Failed to load campaign:",
      error.message
    );
    return;
  }

  campaign.blogUrl =
    data?.blog_url || campaign.blogUrl;

  campaign.blogTitle =
    data?.blog_title || campaign.blogTitle;

  campaign.blogDescription =
    data?.blog_description ||
    campaign.blogDescription;
}

async function saveCampaign() {
  const { error } = await supabase
    .from("promoter_campaign")
    .upsert({
      id: 1,
      blog_url: campaign.blogUrl || "",
      blog_title: campaign.blogTitle || "",
      blog_description:
        campaign.blogDescription || "",
      updated_at: new Date().toISOString()
    });

  if (error) {
    throw error;
  }
}

// ----------------------------------------------------
// CONTACTS
// ----------------------------------------------------

let contacts = [];

async function loadContacts() {
  const { data, error } = await supabase
    .from("promoter_contacts")
    .select("id, name, email")
    .order("id", { ascending: true });

  if (error) {
    console.error(
      "Failed to load contacts:",
      error.message
    );
    return [];
  }

  return data || [];
}

async function saveContact(name, email) {
  const { data, error } = await supabase
    .from("promoter_contacts")
    .insert({
      name: name || "",
      email: email.toLowerCase().trim()
    })
    .select("id, name, email")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function deleteContact(email) {
  const { error } = await supabase
    .from("promoter_contacts")
    .delete()
    .eq(
      "email",
      email.toLowerCase().trim()
    );

  if (error) {
    throw error;
  }
}

// ----------------------------------------------------
// RESULTS
// ----------------------------------------------------

const PROMOTION_LIMIT = 10;

const results = {
  totalRuns: 0,
  totalSent: 0,
  totalFailed: 0,
  lastRun: null,
  lastResults: []
};

let waitingFor = null;

// ----------------------------------------------------
// SUPABASE INITIALIZATION
// ----------------------------------------------------

async function testSupabase() {
  const { data, error } = await supabase
    .from("promoter_campaign")
    .select("id")
    .eq("id", 1)
    .single();

  if (error) {
    console.error(
      "Supabase connection failed:",
      error.message
    );
  } else {
    console.log(
      "Supabase connected successfully:",
      data
    );
  }
}

async function initializeData() {
  await testSupabase();

  contacts = await loadContacts();

  await loadCampaign();

  console.log(
    `Loaded ${contacts.length} contacts from Supabase.`
  );

  console.log(
    `Campaign loaded: ${
      campaign.blogTitle ||
      "No campaign title"
    }`
  );
}

initializeData().catch((error) => {
  console.error(
    "Startup data initialization failed:",
    error.message
  );
});

// ----------------------------------------------------
// OWNER CHECK
// ----------------------------------------------------

function isOwner(msg) {
  return (
    ownerId &&
    String(msg.from.id) === ownerId
  );
}

function accessDenied(msg) {
  return bot.sendMessage(
    msg.chat.id,
    "Access denied."
  );
      }
// ----------------------------------------------------
// TELEGRAM WEBHOOK SETTINGS
// ----------------------------------------------------

const PORT = process.env.PORT || 10000;

const webhookPath =
  process.env.TELEGRAM_WEBHOOK_PATH ||
  `/telegram-webhook-${crypto
    .createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 32)}`;

const webhookUrl =
  `https://jabari-promoter.onrender.com${webhookPath}`;

// ----------------------------------------------------
// TELEGRAM UPDATE HANDLER
// ----------------------------------------------------

async function handleTelegramUpdate(req, res) {
  try {
    const secret =
      crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

    const receivedSecret =
      req.headers[
        "x-telegram-bot-api-secret-token"
      ];

    if (receivedSecret !== secret) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        const update = JSON.parse(body);

        await bot.processUpdate(update);

        res.writeHead(200, {
          "Content-Type": "text/plain"
        });

        res.end("OK");
      } catch (error) {
        console.error(
          "Telegram update error:",
          error.message
        );

        res.writeHead(500);
        res.end("Update error");
      }
    });
  } catch (error) {
    console.error(
      "Webhook error:",
      error.message
    );

    res.writeHead(500);
    res.end("Server error");
  }
}

// ----------------------------------------------------
// HTTP SERVER
// ----------------------------------------------------

const server = http.createServer(
  async (req, res) => {

    // Telegram webhook
    if (
      req.method === "POST" &&
      req.url === webhookPath
    ) {
      return handleTelegramUpdate(req, res);
    }

    // Health check
    if (
      req.method === "GET" &&
      req.url === "/"
    ) {
      res.writeHead(200, {
        "Content-Type": "text/plain"
      });

      res.end(
        "Jabari Promoter is running."
      );

      return;
    }

    // Gmail OAuth callback
    if (
      req.method === "GET" &&
      req.url.startsWith("/oauth2callback")
    ) {
      return handleOAuthCallback(
        req,
        res
      );
    }

    res.writeHead(404);
    res.end("Not found");
  }
);

// ----------------------------------------------------
// START SERVER + REGISTER TELEGRAM WEBHOOK
// ----------------------------------------------------

server.listen(PORT, async () => {
  console.log(
    `Jabari Promoter is running on port ${PORT}`
  );

  try {
    const me = await bot.getMe();

    console.log(
      `Telegram authenticated as @${me.username}`
    );

    const secret =
      crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

    await bot.setWebHook(
      webhookUrl,
      {
        secret_token: secret,
        drop_pending_updates: false
      }
    );

    console.log(
      `Telegram webhook registered: ${webhookUrl}`
    );
  } catch (error) {
    console.error(
      "Telegram webhook setup failed:",
      error.message
    );
  }
});
// ----------------------------------------------------
// GMAIL HELPERS
// ----------------------------------------------------

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createGmailMessage(
  to,
  subject,
  text
) {
  const encodedSubject =
    `=?UTF-8?B?${Buffer.from(
      subject,
      "utf8"
    ).toString("base64")}?=`;

  const message = [
    `From: Jabari Promoter <jabari.xai@gmail.com>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    text
  ].join("\r\n");

  return base64UrlEncode(message);
}

// ----------------------------------------------------
// GOOGLE OAUTH
// ----------------------------------------------------

function createOAuthClient() {
  const { google } = require("googleapis");

  return new google.auth.OAuth2(
    googleClientId,
    googleClientSecret,
    googleRedirectUri
  );
}

async function getGmailClient() {
  if (!googleClientId ||
      !googleClientSecret ||
      !googleRefreshToken) {
    throw new Error(
      "Google OAuth environment variables are missing."
    );
  }

  const auth = createOAuthClient();

  auth.setCredentials({
    refresh_token: googleRefreshToken
  });

  const { google } = require("googleapis");

  return google.gmail({
    version: "v1",
    auth
  });
}

// ----------------------------------------------------
// SEND EMAIL
// ----------------------------------------------------

async function sendEmail(
  to,
  subject,
  text
) {
  if (mode !== "live") {
    console.log(
      `[DRY RUN] Email to ${to}: ${subject}`
    );

    return {
      success: true,
      dryRun: true
    };
  }

  const gmail = await getGmailClient();

  const raw = createGmailMessage(
    to,
    subject,
    text
  );

  const response =
    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw
      }
    });

  return {
    success: true,
    id: response.data.id
  };
}

// ----------------------------------------------------
// SAVE PROMOTION RESULT
// ----------------------------------------------------

async function saveResult(
  email,
  status,
  campaignTitle
) {
  const { error } = await supabase
    .from("promoter_results")
    .insert({
      email,
      status,
      campaign_title:
        campaignTitle || ""
    });

  if (error) {
    console.error(
      "Failed to save result:",
      error.message
    );
  }
}

// ----------------------------------------------------
// PROMOTION
// ----------------------------------------------------

async function promoteToContacts() {
  const currentContacts =
    await loadContacts();

  if (!currentContacts.length) {
    throw new Error(
      "No contacts have been added yet."
    );
  }

  if (!campaign.blogUrl) {
    throw new Error(
      "No blog URL has been added."
    );
  }

  const subject =
    `Jabari Promoter — ${
      campaign.blogTitle ||
      "New Blog Post"
    }`;

  const message = [
    `Hello,`,
    ``,
    `We would like to share a new blog post with you.`,
    ``,
    campaign.blogTitle
      ? campaign.blogTitle
      : "",
    ``,
    campaign.blogDescription
      ? campaign.blogDescription
      : "",
    ``,
    `Read the full post:`,
    campaign.blogUrl,
    ``,
    `Best regards,`,
    `Jabari Promoter`
  ]
    .filter(
      line => line !== undefined
    )
    .join("\n");

  const selectedContacts =
    currentContacts.slice(
      0,
      PROMOTION_LIMIT
    );

  const runResults = [];

  results.totalRuns++;
  results.lastRun =
    new Date().toISOString();

  for (
    const contact of selectedContacts
  ) {
    try {
      await sendEmail(
        contact.email,
        subject,
        message
      );

      results.totalSent++;

      runResults.push({
        email: contact.email,
        status: "sent"
      });

      await saveResult(
        contact.email,
        "sent",
        campaign.blogTitle
      );

    } catch (error) {
      results.totalFailed++;

      runResults.push({
        email: contact.email,
        status: "failed",
        error: error.message
      });

      await saveResult(
        contact.email,
        "failed",
        campaign.blogTitle
      );
    }
  }

  results.lastResults =
    runResults;

  return runResults;
}

// ----------------------------------------------------
// GMAIL OAUTH CALLBACK
// ----------------------------------------------------

async function handleOAuthCallback(
  req,
  res
) {
  try {
    const url = new URL(
      req.url,
      `http://localhost:${PORT}`
    );

    const code =
      url.searchParams.get("code");

    const state =
      url.searchParams.get("state");

    if (!code) {
      res.writeHead(400, {
        "Content-Type": "text/plain"
      });

      res.end(
        "Missing authorization code."
      );

      return;
    }

    if (
      oauthState &&
      state !== oauthState
    ) {
      res.writeHead(400, {
        "Content-Type": "text/plain"
      });

      res.end("Invalid OAuth state.");

      return;
    }

    const auth =
      createOAuthClient();

    const { tokens } =
      await auth.getToken(code);

    console.log(
      "Google OAuth completed."
    );

    console.log(
      "Refresh token received:",
      Boolean(tokens.refresh_token)
    );

    res.writeHead(200, {
      "Content-Type": "text/html"
    });

    res.end(`
      <html>
        <body style="font-family:Arial;padding:40px">
          <h2>Gmail connected successfully.</h2>
          <p>You can return to Telegram.</p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error(
      "OAuth callback error:",
      error.message
    );

    res.writeHead(500, {
      "Content-Type": "text/plain"
    });

    res.end(
      "Google authorization failed."
    );
  }
}
// ----------------------------------------------------
// TELEGRAM COMMANDS
// ----------------------------------------------------

bot.onText(/^\/start$/, async msg => {
  if (!isOwner(msg)) {
    return accessDenied(msg);
  }

  await bot.sendMessage(
    msg.chat.id,
    `Jabari Promoter is online.

Commands:

/status
/blog
/campaign
/contacts
/promote
/test
/testemail`
  );
});

// ----------------------------------------------------
// STATUS
// ----------------------------------------------------

bot.onText(/^\/status$/, async msg => {
  if (!isOwner(msg)) {
    return accessDenied(msg);
  }

  const currentContacts =
    await loadContacts();

  await bot.sendMessage(
    msg.chat.id,
    `Jabari Promoter Status

Mode: ${mode}
Contacts: ${currentContacts.length}
Blog: ${
      campaign.blogTitle ||
      "Not set"
    }

Last run: ${
      results.lastRun ||
      "No promotion yet"
    }

Sent: ${results.totalSent}
Failed: ${results.totalFailed}`
  );
});

// ----------------------------------------------------
// BLOG
// ----------------------------------------------------

bot.onText(/^\/blog$/, async msg => {
  if (!isOwner(msg)) {
    return accessDenied(msg);
  }

  await bot.sendMessage(
    msg.chat.id,
    `Current Blog

Title:
${campaign.blogTitle || "Not set"}

Description:
${
    campaign.blogDescription ||
    "Not set"
  }

URL:
${campaign.blogUrl || "Not set"}`
  );
});

// ----------------------------------------------------
// CAMPAIGN
// ----------------------------------------------------

bot.onText(/^\/campaign$/, async msg => {
  if (!isOwner(msg)) {
    return accessDenied(msg);
  }

  waitingFor = {
    chatId: msg.chat.id,
    type: "campaign"
  };

  await bot.sendMessage(
    msg.chat.id,
    `Send the campaign in this format:

Title
Description
URL

Example:

My New Blog Post
A short description of the article.
https://example.com/post`
  );
});

// ----------------------------------------------------
// CONTACTS
// ----------------------------------------------------

bot.onText(/^\/contacts$/, async msg => {
  if (!isOwner(msg)) {
    return accessDenied(msg);
  }

  const currentContacts =
    await loadContacts();

  if (!currentContacts.length) {
    return bot.sendMessage(
      msg.chat.id,
      "No contacts saved."
    );
  }

  const list =
    currentContacts
      .map(
        (contact, index) =>
          `${index + 1}. ${
            contact.name || "No name"
          } — ${contact.email}`
      )
      .join("\n");

  await bot.sendMessage(
    msg.chat.id,
    `Contacts\n\n${list}`
  );
});

// ----------------------------------------------------
// ADD CONTACT
// ----------------------------------------------------

bot.onText(
  /^\/addcontact(?:\s+(.+))?$/i,
  async (msg, match) => {
    if (!isOwner(msg)) {
      return accessDenied(msg);
    }

    const value =
      match && match[1]
        ? match[1].trim()
        : "";

    if (!value.includes("@")) {
      return bot.sendMessage(
        msg.chat.id,
        `Use:

/addcontact Name | email@example.com`
      );
    }

    const parts =
      value.split("|");

    const name =
      (parts[0] || "").trim();

    const email =
      (parts[1] || "").trim();

    if (!email.includes("@")) {
      return bot.sendMessage(
        msg.chat.id,
        "Please provide a valid email."
      );
    }

    try {
      await saveContact(
        name,
        email
      );

      contacts =
        await loadContacts();

      await bot.sendMessage(
        msg.chat.id,
        `Contact added:

${name || "No name"}
${email}`
      );
    } catch (error) {
      await bot.sendMessage(
        msg.chat.id,
        `Could not add contact.

${error.message}`
      );
    }
  }
);

// ----------------------------------------------------
// DELETE CONTACT
// ----------------------------------------------------

bot.onText(
  /^\/deletecontact\s+(.+)$/i,
  async (msg, match) => {
    if (!isOwner(msg)) {
      return accessDenied(msg);
    }

    const email =
      match[1].trim();

    try {
      await deleteContact(email);

      contacts =
        await loadContacts();

      await bot.sendMessage(
        msg.chat.id,
        `Deleted contact:

${email}`
      );
    } catch (error) {
      await bot.sendMessage(
        msg.chat.id,
        `Could not delete contact.

${error.message}`
      );
    }
  }
);

// ----------------------------------------------------
// PROMOTE
// ----------------------------------------------------

bot.onText(/^\/promote$/, async msg => {
  if (!isOwner(msg)) {
    return accessDenied(msg);
  }

  await bot.sendMessage(
    msg.chat.id,
    "Starting promotion..."
  );

  try {
    const runResults =
      await promoteToContacts();

    const sent =
      runResults.filter(
        item => item.status === "sent"
      ).length;

    const failed =
      runResults.filter(
        item => item.status === "failed"
      ).length;

    await bot.sendMessage(
      msg.chat.id,
      `Promotion complete.

Sent: ${sent}
Failed: ${failed}
Total processed: ${runResults.length}`
    );
  } catch (error) {
    console.error(
      "Promotion error:",
      error.message
    );

    await bot.sendMessage(
      msg.chat.id,
      `Promotion failed.

${error.message}`
    );
  }
});

// ----------------------------------------------------
// TEST
// ----------------------------------------------------

bot.onText(/^\/test$/, async msg => {
  if (!isOwner(msg)) {
    return accessDenied(msg);
  }

  await bot.sendMessage(
    msg.chat.id,
    `Jabari Promoter test successful.

Telegram: OK
Supabase: configured
Gmail: configured
Mode: ${mode}`
  );
});

// ----------------------------------------------------
// TEST EMAIL
// ----------------------------------------------------

bot.onText(
  /^\/testemail(?:\s+(.+))?$/i,
  async (msg, match) => {
    if (!isOwner(msg)) {
      return accessDenied(msg);
    }

    const email =
      match && match[1]
        ? match[1].trim()
        : "";

    if (!email) {
      return bot.sendMessage(
        msg.chat.id,
        "Use:\n/testemail your@email.com"
      );
    }

    try {
      await sendEmail(
        email,
        "Jabari Promoter — Test",
        `Hello,

This is a test email from Jabari Promoter.

If you received this message, Gmail sending is working correctly.

Jabari Promoter`
      );

      await bot.sendMessage(
        msg.chat.id,
        `Test email sent to:

${email}`
      );
    } catch (error) {
      console.error(
        "Test email error:",
        error.message
      );

      await bot.sendMessage(
        msg.chat.id,
        `Test email failed.

${error.message}`
      );
    }
  }
);

// ----------------------------------------------------
// TEXT INPUT HANDLER
// ----------------------------------------------------

bot.on("message", async msg => {
  if (!isOwner(msg)) {
    return;
  }

  if (
    !msg.text ||
    msg.text.startsWith("/")
  ) {
    return;
  }

  if (
    !waitingFor ||
    waitingFor.chatId !== msg.chat.id
  ) {
    return;
  }

  if (
    waitingFor.type === "campaign"
  ) {
    const lines =
      msg.text
        .split("\n")
        .map(line => line.trim());

    if (lines.length < 3) {
      return bot.sendMessage(
        msg.chat.id,
        `Please send:

Title
Description
URL`
      );
    }

    campaign.blogTitle =
      lines[0] || "";

    campaign.blogDescription =
      lines[1] || "";

    campaign.blogUrl =
      lines.slice(2).join("\n") || "";

    try {
      await saveCampaign();

      waitingFor = null;

      await bot.sendMessage(
        msg.chat.id,
        `Campaign saved successfully.

Title:
${campaign.blogTitle}

URL:
${campaign.blogUrl}`
      );
    } catch (error) {
      await bot.sendMessage(
        msg.chat.id,
        `Could not save campaign.

${error.message}`
      );
    }
  }
});

// ----------------------------------------------------
// TELEGRAM ERROR HANDLERS
// ----------------------------------------------------

bot.on("polling_error", error => {
  console.error(
    "Unexpected polling error:",
    error.message
  );
});

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

console.log(
  "Jabari Promoter code loaded successfully."
);
