require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
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

// Temporary OAuth state.
// It is only valid while this server is running.
let oauthState = null;

// ----------------------------------------------------
// CAMPAIGN DATA
// ----------------------------------------------------

const campaign = {
  blogUrl: process.env.BLOG_URL || "",
  blogTitle: process.env.BLOG_TITLE || "",
  blogDescription: process.env.BLOG_DESCRIPTION || ""
};

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

Gmail:
${
  googleRefreshToken
    ? "🟢 Connected"
    : "🔴 Not authorized"
}

Commands:

/status — Check bot status
/blog — Add or view blog
/campaign — View campaign
/test — Test campaign
/gmailauth — Connect Gmail
/testemail — Send Gmail test
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

Mode:
${mode}

Gmail:

Client ID:
${
  googleClientId
    ? "✅ Detected"
    : "❌ Missing"
}

Client Secret:
${
  googleClientSecret
    ? "✅ Detected"
    : "❌ Missing"
}

Gmail authorization:
${
  googleRefreshToken
    ? "🟢 Connected"
    : "🔴 Not connected"
}

Sender:
jabari.xai@gmail.com`
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
/gmailauth
/testemail
/help

Use /blog to add the article you want to promote.

Use /gmailauth to connect your Gmail account.

Use /testemail to send a test email.`
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

Gmail:
${
  googleRefreshToken
    ? "Connected"
    : "Not connected"
}`
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

Gmail:
${
  googleRefreshToken
    ? "🟢 Connected"
    : "🔴 Not connected"
}

Use /testemail to send a Gmail test.`
  );
});

// ----------------------------------------------------
// GMAIL OAUTH AUTHORIZATION
// ----------------------------------------------------

bot.onText(/\/gmailauth/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!googleClientId || !googleClientSecret) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Google OAuth is not configured.

Check these Render variables:

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET`
    );
  }

  oauthState = crypto.randomBytes(24).toString("hex");

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" +
    encodeURIComponent(googleClientId) +
    "&redirect_uri=" +
    encodeURIComponent(googleRedirectUri) +
    "&response_type=code" +
    "&scope=" +
    encodeURIComponent(gmailScope) +
    "&access_type=offline" +
    "&prompt=consent" +
    "&state=" +
    encodeURIComponent(oauthState);

  await bot.sendMessage(
    msg.chat.id,
    `🔐 Gmail authorization

Open this link:

${authUrl}

Then:

1. Sign in with:
jabari.xai@gmail.com

2. Review the Gmail permission.

3. Allow the app.

4. Google will return you to Jabari Promoter.

⚠️ Only authorize your own Gmail account.

After authorization, come back to Telegram.`
  );
});

// ----------------------------------------------------
// EXCHANGE GOOGLE AUTH CODE FOR TOKENS
// ----------------------------------------------------

async function exchangeGoogleCode(code) {
  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: googleRedirectUri,
        grant_type: "authorization_code"
      }).toString()
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error_description ||
      data?.error ||
      "Google token exchange failed."
    );
  }

  return data;
}

// ----------------------------------------------------
// GET ACCESS TOKEN USING REFRESH TOKEN
// ----------------------------------------------------

async function getGoogleAccessToken() {
  if (!googleRefreshToken) {
    throw new Error(
      "GOOGLE_REFRESH_TOKEN is missing."
    );
  }

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded"
      },

      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        refresh_token: googleRefreshToken,
        grant_type: "refresh_token"
      }).toString()
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error_description ||
      data?.error ||
      "Could not refresh Google access token."
    );
  }

  return data.access_token;
}

// ----------------------------------------------------
// BASE64URL ENCODER
// ----------------------------------------------------

function base64UrlEncode(value) {
  return Buffer
    .from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// ----------------------------------------------------
// GMAIL SEND FUNCTION
// ----------------------------------------------------

async function sendGmail({
  to,
  subject,
  html
}) {
  const accessToken =
    await getGoogleAccessToken();

  const from =
    "Jabari Promoter <jabari.xai@gmail.com>";

  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "",
    html
  ].join("\r\n");

  const raw =
    base64UrlEncode(message);

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",

      headers: {
        "Authorization":
          `Bearer ${accessToken}`,
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        raw
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Gmail API returned an error."
    );
  }

  return data;
}

// ----------------------------------------------------
// TEST GMAIL EMAIL
// ----------------------------------------------------

bot.onText(/\/testemail/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!googleRefreshToken) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Gmail is not connected yet.

Use:

/gmailauth

first.`
    );
  }

  waitingFor = "testEmail";

  await bot.sendMessage(
    msg.chat.id,
    `📧 Gmail test

Send the email address that should receive the test.

For the first test, use an email address you control.

Example:
you@example.com`
  );
});

// ----------------------------------------------------
// NORMAL TEXT MESSAGES
// ----------------------------------------------------

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (!isOwner(msg)) return;

  const text = msg.text.trim();

  if (text.startsWith("/")) return;

  // --------------------------------------------------
  // TEST EMAIL
  // --------------------------------------------------

  if (waitingFor === "testEmail") {
    waitingFor = null;

    const recipient = text;

    const emailPattern =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(recipient)) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ That doesn't look like a valid email address.

Use /testemail to try again.`
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
      <strong>Jabari Promoter</strong>
      using Gmail.
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

    await bot.sendMessage(
      msg.chat.id,
      `📤 Sending Gmail test...

From:
jabari.xai@gmail.com

To:
${recipient}`
    );

    try {
      const result =
        await sendGmail({
          to: recipient,
          subject,
          html
        });

      await bot.sendMessage(
        msg.chat.id,
        `✅ Gmail test email sent successfully.

From:
jabari.xai@gmail.com

To:
${recipient}

Gmail message ID:
${result.id || "Not returned"}

Check the recipient inbox.`
      );

    } catch (error) {
      console.error(
        "Gmail error:",
        error
      );

      await bot.sendMessage(
        msg.chat.id,
        `❌ Gmail sending failed.

Reason:
${error.message}

Check:
• Google OAuth setup
• GOOGLE_CLIENT_ID
• GOOGLE_CLIENT_SECRET
• GOOGLE_REFRESH_TOKEN
• Gmail API`
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

Use /testemail to test Gmail.`
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
// RENDER OAUTH CALLBACK
// ----------------------------------------------------

const PORT =
  process.env.PORT || 10000;

const server =
  http.createServer(
    async (req, res) => {

      // ----------------------------------------------
      // GOOGLE OAUTH CALLBACK
      // ----------------------------------------------

      if (
        req.url.startsWith(
          "/oauth2callback"
        )
      ) {
        try {
          const url =
            new URL(
              req.url,
              `http://localhost:${PORT}`
            );

          const code =
            url.searchParams.get("code");

          const state =
            url.searchParams.get("state");

          const error =
            url.searchParams.get("error");

          if (error) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8"
            });

            return res.end(`
              <h2>Google authorization cancelled</h2>
              <p>You can close this page and return to Telegram.</p>
            `);
          }

          if (!code) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8"
            });

            return res.end(`
              <h2>Authorization code missing</h2>
            `);
          }

          if (
            !oauthState ||
            state !== oauthState
          ) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8"
            });

            return res.end(`
              <h2>Invalid authorization state</h2>
              <p>Please start again with /gmailauth.</p>
            `);
          }

          oauthState = null;

          const tokens =
            await exchangeGoogleCode(
              code
            );

          console.log(
            "Google OAuth completed."
          );

          res.writeHead(200, {
            "Content-Type":
              "text/html; charset=utf-8"
          });

          if (tokens.refresh_token) {
            return res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>Jabari Promoter</title>
              </head>

              <body style="font-family:Arial,sans-serif;padding:30px;max-width:700px;margin:auto;">

                <h2>✅ Gmail authorization successful</h2>

                <p>
                  Google has authorized Jabari Promoter.
                </p>

                <p>
                  A refresh token was generated.
                </p>

                <p>
                  Add the following value to Render as:
                </p>

                <p>
                  <strong>GOOGLE_REFRESH_TOKEN</strong>
                </p>

                <textarea
                  style="width:100%;height:140px;"
                  readonly
                >${escapeHtml(tokens.refresh_token)}</textarea>

                <p style="color:#b00020;">
                  ⚠️ Keep this token private. Do not post it publicly or send it to anyone.
                </p>

                <p>
                  After adding it to Render, redeploy the service.
                </p>

                <p>
                  Then return to Telegram and use /status.
                </p>

              </body>
              </html>
            `);
          }

          return res.end(`
            <!DOCTYPE html>
            <html>
            <body style="font-family:Arial,sans-serif;padding:30px;">
              <h2>⚠️ Authorization completed</h2>
              <p>Google did not return a refresh token.</p>
              <p>Run /gmailauth again and authorize the account when prompted.</p>
            </body>
            </html>
          `);

        } catch (error) {
          console.error(
            "OAuth callback error:",
            error
          );

          res.writeHead(500, {
            "Content-Type":
              "text/html; charset=utf-8"
          });

          return res.end(`
            <h2>❌ Gmail authorization failed</h2>
            <p>${escapeHtml(error.message)}</p>
            <p>Return to Telegram and try /gmailauth again.</p>
          `);
        }
      }

      // ----------------------------------------------
      // NORMAL RENDER HEALTH CHECK
      // ----------------------------------------------

      res.writeHead(200, {
        "Content-Type":
          "text/plain"
      });

      res.end(
        "Jabari Promoter is running."
      );
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Jabari Promoter is running on port ${PORT}`
    );
  }
);

// ----------------------------------------------------
// TELEGRAM POLLING ERROR
// ----------------------------------------------------

bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});
