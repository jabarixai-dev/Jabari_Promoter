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

let oauthState = null;

// ----------------------------------------------------
// CAMPAIGN
// ----------------------------------------------------

const campaign = {
  blogUrl: process.env.BLOG_URL || "",
  blogTitle: process.env.BLOG_TITLE || "",
  blogDescription: process.env.BLOG_DESCRIPTION || ""
};

// ----------------------------------------------------
// CONTACTS
// ----------------------------------------------------

// Contacts added here should be people who have
// permission/consent to receive your promotional emails.

const contacts = [];

// Maximum number of emails in one /promote run.
const PROMOTION_LIMIT = 10;

// ----------------------------------------------------
// RESULTS
// ----------------------------------------------------

const results = {
  totalRuns: 0,
  totalSent: 0,
  totalFailed: 0,
  lastRun: null,
  lastResults: []
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

Mode:
${mode}

Gmail:
${
  googleRefreshToken
    ? "🟢 Connected"
    : "🔴 Not authorized"
}

Contacts:
${contacts.length}

Commands:

/status
/blog
/campaign
/contacts
/addcontact
/removecontact
/promote
/results
/test
/testemail
/gmailauth
/help`
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

Authorization:
${
  googleRefreshToken
    ? "🟢 Connected"
    : "🔴 Not connected"
}

Sender:
jabari.xai@gmail.com

Contacts:
${contacts.length}

Promotion limit:
${PROMOTION_LIMIT} emails/run

Last sent:
${results.totalSent}

Last failed:
${results.totalFailed}`
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

BLOG
/blog — Add a blog campaign
/campaign — View campaign

CONTACTS
/contacts — View contacts
/addcontact — Add a contact
/removecontact — Remove a contact

PROMOTION
/promote — Send campaign
/results — View sending results

GMAIL
/gmailauth — Connect Gmail
/testemail — Send a Gmail test

OTHER
/status
/test
/help

Only use promotional contacts who have given appropriate permission to receive your emails.`
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

Send the full blog post URL.`
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

Contacts:
${contacts.length}

Gmail:
${
  googleRefreshToken
    ? "🟢 Connected"
    : "🔴 Not connected"
}

Promotion limit:
${PROMOTION_LIMIT} emails/run`
  );
});

// ----------------------------------------------------
// CONTACT LIST
// ----------------------------------------------------

bot.onText(/\/contacts/, async (msg) => {
  if (!isOwner(msg)) return;

  if (contacts.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      `📇 No contacts yet.

Use /addcontact to add an approved recipient.`
    );
  }

  const lines = contacts.map(
    (contact, index) =>
      `${index + 1}. ${contact.name} — ${contact.email}`
  );

  await bot.sendMessage(
    msg.chat.id,
    `📇 Approved contacts

${lines.join("\n")}

Total:
${contacts.length}`
  );
});

// ----------------------------------------------------
// ADD CONTACT
// ----------------------------------------------------

bot.onText(/\/addcontact/, async (msg) => {
  if (!isOwner(msg)) return;

  waitingFor = "contact";

  await bot.sendMessage(
    msg.chat.id,
    `➕ Add approved contact

Send it in this format:

Name | email@example.com

Example:

John Doe | john@example.com

Only add people who have given appropriate permission to receive your promotional emails.`
  );
});

// ----------------------------------------------------
// REMOVE CONTACT
// ----------------------------------------------------

bot.onText(/\/removecontact/, async (msg) => {
  if (!isOwner(msg)) return;

  if (contacts.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      "📇 There are no contacts to remove."
    );
  }

  waitingFor = "removeContact";

  await bot.sendMessage(
    msg.chat.id,
    `🗑️ Remove contact

Send the email address you want to remove.

Example:

john@example.com`
  );
});

// ----------------------------------------------------
// PROMOTE
// ----------------------------------------------------

bot.onText(/\/promote/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!campaign.blogUrl) {
    return bot.sendMessage(
      msg.chat.id,
      "⚠️ No campaign exists yet.\n\nUse /blog first."
    );
  }

  if (!googleRefreshToken) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Gmail is not connected.

Use /gmailauth first.`
    );
  }

  if (contacts.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      `⚠️ There are no contacts.

Use /addcontact first.`
    );
  }

  const batch =
    contacts.slice(0, PROMOTION_LIMIT);

  await bot.sendMessage(
    msg.chat.id,
    `📣 Promotion ready

Campaign:
${campaign.blogTitle || "Untitled"}

Recipients:
${batch.length}

Maximum per run:
${PROMOTION_LIMIT}

The emails will be personalized using each contact's name.

Starting...`
  );

  const runResults = [];

  for (const contact of batch) {
    try {
      const subject =
        campaign.blogTitle
          ? `Jabari — ${campaign.blogTitle}`
          : "A new article from Jabari";

      const html = createPromotionEmail(
        contact.name,
        subject
      );

      if (mode === "dry-run") {
        runResults.push({
          email: contact.email,
          status: "DRY RUN"
        });

        continue;
      }

      await sendGmail({
        to: contact.email,
        subject,
        html
      });

      results.totalSent++;

      runResults.push({
        email: contact.email,
        status: "SENT"
      });

      // Small pause between messages.
      await sleep(1500);

    } catch (error) {
      console.error(
        `Gmail failed for ${contact.email}:`,
        error.message
      );

      results.totalFailed++;

      runResults.push({
        email: contact.email,
        status: `FAILED — ${error.message}`
      });
    }
  }

  results.totalRuns++;
  results.lastRun =
    new Date().toISOString();

  results.lastResults =
    runResults;

  const sent =
    runResults.filter(
      r => r.status === "SENT"
    ).length;

  const dryRun =
    runResults.filter(
      r => r.status === "DRY RUN"
    ).length;

  const failed =
    runResults.filter(
      r => r.status.startsWith("FAILED")
    ).length;

  await bot.sendMessage(
    msg.chat.id,
    `📊 Promotion completed

Campaign:
${campaign.blogTitle || "Untitled"}

Processed:
${runResults.length}

Sent:
${sent}

Dry run:
${dryRun}

Failed:
${failed}

Use /results to view the detailed results.`
  );
});

// ----------------------------------------------------
// RESULTS
// ----------------------------------------------------

bot.onText(/\/results/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!results.lastResults.length) {
    return bot.sendMessage(
      msg.chat.id,
      `📊 No promotion has been run yet.`
    );
  }

  const lines =
    results.lastResults.map(
      (item, index) =>
        `${index + 1}. ${item.email}\n   ${item.status}`
    );

  await bot.sendMessage(
    msg.chat.id,
    `📊 Last promotion results

${lines.join("\n\n")}

Total runs:
${results.totalRuns}

Total sent:
${results.totalSent}

Total failed:
${results.totalFailed}`
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
    `🧪 Campaign test

Title:
${campaign.blogTitle || "Untitled"}

URL:
${campaign.blogUrl}

Description:
${campaign.blogDescription || "Not set"}

Contacts:
${contacts.length}

Gmail:
${
  googleRefreshToken
    ? "🟢 Connected"
    : "🔴 Not connected"
}

Mode:
${mode}`
  );
});

// ----------------------------------------------------
// GMAIL AUTH
// ----------------------------------------------------

bot.onText(/\/gmailauth/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!googleClientId || !googleClientSecret) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Google OAuth is not configured.

Check:

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET`
    );
  }

  oauthState =
    crypto.randomBytes(24).toString("hex");

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

Authorize using:

jabari.xai@gmail.com`
  );
});

// ----------------------------------------------------
// GOOGLE TOKEN EXCHANGE
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

  const data =
    await response.json();

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
// ACCESS TOKEN
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

  const data =
    await response.json();

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
// BASE64URL
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
// GMAIL SEND
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
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
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

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      "Gmail API returned an error."
    );
  }

  return data;
}

// ----------------------------------------------------
// PROMOTIONAL EMAIL
// ----------------------------------------------------

function createPromotionEmail(
  name,
  subject
) {
  const safeName =
    escapeHtml(name || "there");

  const title =
    escapeHtml(
      campaign.blogTitle ||
      "A new article from Jabari"
    );

  const description =
    escapeHtml(
      campaign.blogDescription ||
      ""
    );

  const url =
    escapeAttribute(
      campaign.blogUrl
    );

  return `
<!DOCTYPE html>
<html>

<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1.0"
  >

  <title>${escapeHtml(subject)}</title>
</head>

<body
  style="
    margin:0;
    padding:0;
    background:#f5f5f5;
    font-family:Arial,sans-serif;
  "
>

  <div
    style="
      max-width:600px;
      margin:30px auto;
      background:#ffffff;
      padding:30px;
      border-radius:12px;
    "
  >

    <p>
      Hello ${safeName},
    </p>

    <h1>
      ${title}
    </h1>

    <p>
      ${description}
    </p>

    <p>
      We thought this article might be useful to you.
    </p>

    <p>
      <a
        href="${url}"
        style="
          display:inline-block;
          padding:12px 20px;
          background:#111;
          color:#fff;
          text-decoration:none;
          border-radius:6px;
        "
      >
        Read the article
      </a>
    </p>

    <hr
      style="
        border:none;
        border-top:1px solid #ddd;
        margin:25px 0;
      "
    >

    <p
      style="
        font-size:12px;
        color:#777;
      "
    >
      Jabari Promoter
    </p>

  </div>

</body>
</html>
`;
}

// ----------------------------------------------------
// TEST EMAIL
// ----------------------------------------------------

bot.onText(/\/testemail/, async (msg) => {
  if (!isOwner(msg)) return;

  if (!googleRefreshToken) {
    return bot.sendMessage(
      msg.chat.id,
      `❌ Gmail is not connected.

Use /gmailauth first.`
    );
  }

  waitingFor = "testEmail";

  await bot.sendMessage(
    msg.chat.id,
    `📧 Gmail test

Send the email address that should receive the test.

For the first test, use an address you control.`
  );
});

// ----------------------------------------------------
// NORMAL TEXT
// ----------------------------------------------------

bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (!isOwner(msg)) return;

  const text =
    msg.text.trim();

  if (text.startsWith("/")) return;

  // -----------------------------------------------
  // ADD CONTACT
  // -----------------------------------------------

  if (waitingFor === "contact") {
    waitingFor = null;

    const parts =
      text.split("|");

    if (parts.length < 2) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Invalid format.

Use:

Name | email@example.com

Then try /addcontact again.`
      );
    }

    const name =
      parts[0].trim();

    const email =
      parts.slice(1)
        .join("|")
        .trim()
        .toLowerCase();

    const emailPattern =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Invalid email address.

Use /addcontact again.`
      );
    }

    const exists =
      contacts.some(
        contact =>
          contact.email === email
      );

    if (exists) {
      return bot.sendMessage(
        msg.chat.id,
        "⚠️ That contact already exists."
      );
    }

    contacts.push({
      name:
        name || "there",
      email
    });

    return bot.sendMessage(
      msg.chat.id,
      `✅ Contact added.

Name:
${name || "there"}

Email:
${email}

Total contacts:
${contacts.length}`
    );
  }

  // -----------------------------------------------
  // REMOVE CONTACT
  // -----------------------------------------------

  if (waitingFor === "removeContact") {
    waitingFor = null;

    const email =
      text.toLowerCase();

    const index =
      contacts.findIndex(
        contact =>
          contact.email === email
      );

    if (index === -1) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Contact not found.

Use /contacts to view the current list.`
      );
    }

    const removed =
      contacts.splice(index, 1)[0];

    return bot.sendMessage(
      msg.chat.id,
      `🗑️ Contact removed.

${removed.name}
${removed.email}

Remaining:
${contacts.length}`
    );
  }

  // -----------------------------------------------
  // TEST EMAIL
  // -----------------------------------------------

  if (waitingFor === "testEmail") {
    waitingFor = null;

    const recipient =
      text;

    const emailPattern =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(recipient)) {
      return bot.sendMessage(
        msg.chat.id,
        `❌ Invalid email address.

Use /testemail again.`
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

    const html =
      createPromotionEmail(
        "there",
        subject
      );

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

Check the Google OAuth configuration.`
      );
    }

    return;
  }

  // -----------------------------------------------
  // BLOG URL
  // -----------------------------------------------

  if (waitingFor === "blogUrl") {
    campaign.blogUrl =
      text;

    waitingFor =
      "blogTitle";

    return bot.sendMessage(
      msg.chat.id,
      `✅ Blog URL received.

Now send me the title of the blog post.`
    );
  }

  // -----------------------------------------------
  // BLOG TITLE
  // -----------------------------------------------

  if (waitingFor === "blogTitle") {
    campaign.blogTitle =
      text;

    waitingFor =
      "blogDescription";

    return bot.sendMessage(
      msg.chat.id,
      `✅ Title saved.

Now send me a short description of the article.`
    );
  }

  // -----------------------------------------------
  // BLOG DESCRIPTION
  // -----------------------------------------------

  if (waitingFor === "blogDescription") {
    campaign.blogDescription =
      text;

    waitingFor = null;

    return bot.sendMessage(
      msg.chat.id,
      `✅ Blog campaign saved.

Title:
${campaign.blogTitle}

URL:
${campaign.blogUrl}

Description:
${campaign.blogDescription}

Use /campaign to view it.`
    );
  }
});

// ----------------------------------------------------
// HTML SAFETY
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
// DELAY
// ----------------------------------------------------

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

// ----------------------------------------------------
// OAUTH CALLBACK
// ----------------------------------------------------

const PORT =
  process.env.PORT || 10000;

const server =
  http.createServer(
    async (req, res) => {

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
              <p>Return to Telegram.</p>
            `);
          }

          if (!code) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8"
            });

            return res.end(
              "<h2>Authorization code missing</h2>"
            );
          }

          if (
            !oauthState ||
            state !== oauthState
          ) {
            res.writeHead(400, {
              "Content-Type":
                "text/html; charset=utf-8"
            });

            return res.end(
              "<h2>Invalid authorization state</h2>"
            );
          }

          oauthState = null;

          const tokens =
            await exchangeGoogleCode(
              code
            );

          res.writeHead(200, {
            "Content-Type":
              "text/html; charset=utf-8"
          });

          if (tokens.refresh_token) {

            return res.end(`
              <!DOCTYPE html>
              <html>

              <body
                style="
                  font-family:Arial;
                  padding:30px;
                  max-width:700px;
                  margin:auto;
                "
              >

                <h2>
                  ✅ Gmail authorization successful
                </h2>

                <p>
                  A new refresh token was generated.
                </p>

                <p>
                  Add it to Render as:
                </p>

                <strong>
                  GOOGLE_REFRESH_TOKEN
                </strong>

                <br><br>

                <textarea
                  style="
                    width:100%;
                    height:140px;
                  "
                  readonly
                >${escapeHtml(tokens.refresh_token)}</textarea>

                <p style="color:#b00020;">
                  ⚠️ Keep this token private.
                </p>

              </body>
              </html>
            `);
          }

          return res.end(`
            <h2>
              ⚠️ Authorization completed
            </h2>

            <p>
              Google did not return a refresh token.
            </p>

            <p>
              Run /gmailauth again.
            </p>
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
            <h2>
              ❌ Gmail authorization failed
            </h2>

            <p>
              ${escapeHtml(error.message)}
            </p>
          `);
        }
      }

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
// TELEGRAM ERROR
// ----------------------------------------------------

bot.on("polling_error", (error) => {
  console.error(
    "Telegram polling error:",
    error.message
  );
});
