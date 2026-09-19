require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const bot = new TelegramBot(token, { polling: false });
const ownerId = String(process.env.BOT_OWNER_ID || "");
const mode = process.env.MODE || "dry-run";
const PORT = process.env.PORT || 10000;

const campaign = { blogUrl: "", blogTitle: "", blogDescription: "" };
let contacts = [];
let campaignDraft = null;
const PROMOTION_LIMIT = 10;
const results = { totalRuns: 0, totalSent: 0, totalFailed: 0, lastRun: null, lastResults: [] };

const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN || "";
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || "https://jabari-promoter.onrender.com/oauth2callback";
let oauthState = null;

const webhookSecret = crypto.createHash("sha256").update(token).digest("hex");
const webhookPath = process.env.TELEGRAM_WEBHOOK_PATH || `/telegram-webhook-${webhookSecret.slice(0, 32)}`;
const webhookUrl = `https://jabari-promoter.onrender.com${webhookPath}`;

function isOwner(msg) {
  return !!(ownerId && msg?.from && String(msg.from.id) === ownerId);
}
function deny(msg) { return bot.sendMessage(msg.chat.id, "Access denied."); }

async function loadCampaign() {
  const { data, error } = await supabase.from("promoter_campaign").select("blog_url, blog_title, blog_description").eq("id", 1).single();
  if (error) return console.error("Failed to load campaign:", error.message);
  campaign.blogUrl = data?.blog_url || "";
  campaign.blogTitle = data?.blog_title || "";
  campaign.blogDescription = data?.blog_description || "";
}
async function saveCampaign() {
  const { error } = await supabase.from("promoter_campaign").upsert({
    id: 1, blog_url: campaign.blogUrl || "", blog_title: campaign.blogTitle || "",
    blog_description: campaign.blogDescription || "", updated_at: new Date().toISOString()
  });
  if (error) throw error;
}
async function deleteCampaign() {
  const { error } = await supabase.from("promoter_campaign").update({
    blog_url: "", blog_title: "", blog_description: "", updated_at: new Date().toISOString()
  }).eq("id", 1);
  if (error) throw error;
  campaign.blogUrl = campaign.blogTitle = campaign.blogDescription = "";
}
async function loadContacts() {
  const { data, error } = await supabase.from("promoter_contacts").select("id, name, email").order("id", { ascending: true });
  if (error) { console.error("Failed to load contacts:", error.message); return []; }
  return data || [];
}
async function saveContact(name, email) {
  const { data, error } = await supabase.from("promoter_contacts").insert({ name: name || "", email: email.toLowerCase().trim() }).select("id, name, email").single();
  if (error) throw error; return data;
}
async function deleteContact(email) {
  const { error } = await supabase.from("promoter_contacts").delete().eq("email", email.toLowerCase().trim());
  if (error) throw error;
}
async function saveResult(email, status) {
  const { error } = await supabase.from("promoter_results").insert({ email, status, campaign_title: campaign.blogTitle || "" });
  if (error) console.error("Failed to save result:", error.message);
}

function createOAuthClient() {
  const { google } = require("googleapis");
  return new google.auth.OAuth2(googleClientId, googleClientSecret, googleRedirectUri);
}
function base64UrlEncode(s) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
function createGmailMessage(to, subject, text) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  return base64UrlEncode([
    "From: Jabari Promoter <jabari.xai@gmail.com>", `To: ${to}`, `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", text
  ].join("\r\n"));
}
async function sendEmail(to, subject, text) {
  if (mode !== "live") { console.log(`[DRY RUN] Email to ${to}: ${subject}`); return { success: true, dryRun: true }; }
  if (!googleClientId || !googleClientSecret || !googleRefreshToken) throw new Error("Google OAuth environment variables are missing.");
  const auth = createOAuthClient(); auth.setCredentials({ refresh_token: googleRefreshToken });
  const { google } = require("googleapis");
  const gmail = google.gmail({ version: "v1", auth });
  const response = await gmail.users.messages.send({ userId: "me", requestBody: { raw: createGmailMessage(to, subject, text) } });
  return { success: true, id: response.data.id };
}
async function promoteToContacts() {
  const list = await loadContacts();
  if (!list.length) throw new Error("No contacts have been added yet.");
  if (!campaign.blogUrl) throw new Error("No blog URL has been added.");
  const subject = `Jabari Promoter — ${campaign.blogTitle || "New Blog Post"}`;
  const message = ["Hello,", "", "We would like to share a new blog post with you.", "", campaign.blogTitle, "", campaign.blogDescription, "", "Read the full post:", campaign.blogUrl, "", "Best regards,", "Jabari Promoter"].join("\n");
  const out = []; results.totalRuns++; results.lastRun = new Date().toISOString();
  for (const c of list.slice(0, PROMOTION_LIMIT)) {
    try { await sendEmail(c.email, subject, message); results.totalSent++; out.push({ email: c.email, status: "sent" }); await saveResult(c.email, "sent"); }
    catch (e) { results.totalFailed++; out.push({ email: c.email, status: "failed", error: e.message }); await saveResult(c.email, "failed"); }
  }
  results.lastResults = out; return out;
}

bot.onText(/^\/start$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  await bot.sendMessage(msg.chat.id, "Jabari Promoter is online.\n\nCommands:\n/status\n/blog\n/campaign\n/deletecampaign\n/cancelcampaign\n/contacts\n/addcontact Name | email@example.com\n/deletecontact email@example.com\n/promote\n/test\n/testemail email@example.com");
});
bot.onText(/^\/status$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  const list = await loadContacts();
  await bot.sendMessage(msg.chat.id, `Jabari Promoter Status\n\nMode: ${mode}\n\nContacts: ${list.length}\n\nBlog: ${campaign.blogTitle || "Not set"}\n\nLast run: ${results.lastRun || "No promotion yet"}\n\nSent: ${results.totalSent}\nFailed: ${results.totalFailed}`);
});
bot.onText(/^\/blog$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  await bot.sendMessage(msg.chat.id, `Current Campaign\n\nTitle:\n${campaign.blogTitle || "Not set"}\n\nDescription:\n${campaign.blogDescription || "Not set"}\n\nURL:\n${campaign.blogUrl || "Not set"}`);
});

bot.onText(/^\/campaign$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  campaignDraft = { chatId: msg.chat.id, step: "title", title: "", description: "", url: "" };
  await bot.sendMessage(msg.chat.id, "Let's create a campaign.\n\nWhat is the campaign title?", { reply_markup: { force_reply: true, input_field_placeholder: "Enter campaign title" } });
});
bot.onText(/^\/cancelcampaign$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  campaignDraft = null; await bot.sendMessage(msg.chat.id, "Campaign creation cancelled.");
});
bot.onText(/^\/deletecampaign$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  try { await deleteCampaign(); campaignDraft = null; await bot.sendMessage(msg.chat.id, "Saved campaign deleted successfully."); }
  catch (e) { await bot.sendMessage(msg.chat.id, `Could not delete campaign.\n\n${e.message}`); }
});

bot.onText(/^\/contacts$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  const list = await loadContacts();
  if (!list.length) return bot.sendMessage(msg.chat.id, "No contacts saved.");
  await bot.sendMessage(msg.chat.id, "Contacts\n\n" + list.map((c,i) => `${i+1}. ${c.name || "No name"} — ${c.email}`).join("\n"));
});
bot.onText(/^\/addcontact(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isOwner(msg)) return deny(msg);
  const value = match?.[1]?.trim() || ""; const parts = value.split("|"); const name = (parts[0] || "").trim(); const email = (parts[1] || "").trim();
  if (!email.includes("@")) return bot.sendMessage(msg.chat.id, "Use:\n/addcontact Name | email@example.com");
  try { await saveContact(name, email); contacts = await loadContacts(); await bot.sendMessage(msg.chat.id, `Contact added:\n\n${name || "No name"}\n${email}`); }
  catch (e) { await bot.sendMessage(msg.chat.id, `Could not add contact.\n\n${e.message}`); }
});
bot.onText(/^\/deletecontact\s+(.+)$/i, async (msg, match) => {
  if (!isOwner(msg)) return deny(msg);
  try { await deleteContact(match[1].trim()); contacts = await loadContacts(); await bot.sendMessage(msg.chat.id, `Deleted contact:\n\n${match[1].trim()}`); }
  catch (e) { await bot.sendMessage(msg.chat.id, `Could not delete contact.\n\n${e.message}`); }
});

bot.onText(/^\/promote$/, async msg => {
  if (!isOwner(msg)) return deny(msg);
  await bot.sendMessage(msg.chat.id, "Starting promotion...");
  try { const r = await promoteToContacts(); const sent = r.filter(x => x.status === "sent").length; const failed = r.filter(x => x.status === "failed").length; await bot.sendMessage(msg.chat.id, `Promotion complete.\n\nSent: ${sent}\nFailed: ${failed}\nTotal processed: ${r.length}`); }
  catch (e) { console.error("Promotion error:", e.message); await bot.sendMessage(msg.chat.id, `Promotion failed.\n\n${e.message}`); }
});
bot.onText(/^\/test$/, async msg => { if (!isOwner(msg)) return deny(msg); await bot.sendMessage(msg.chat.id, `Jabari Promoter test successful.\n\nTelegram: OK\nSupabase: configured\nGmail: configured\nMode: ${mode}`); });
bot.onText(/^\/testemail(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isOwner(msg)) return deny(msg); const email = match?.[1]?.trim() || ""; if (!email) return bot.sendMessage(msg.chat.id, "Use:\n/testemail your@email.com");
  try { await sendEmail(email, "Jabari Promoter — Test", "Hello,\n\nThis is a test email from Jabari Promoter.\n\nIf you received this message, Gmail sending is working correctly.\n\nJabari Promoter"); await bot.sendMessage(msg.chat.id, `Test email sent to:\n\n${email}`); }
  catch (e) { await bot.sendMessage(msg.chat.id, `Test email failed.\n\n${e.message}`); }
});

bot.on("message", async msg => {
  if (!isOwner(msg) || !msg.text || msg.text.startsWith("/") || !campaignDraft || campaignDraft.chatId !== msg.chat.id) return;
  if (campaignDraft.step === "title") {
    const title = msg.text.trim(); if (!title) return bot.sendMessage(msg.chat.id, "Please enter a campaign title.");
    campaignDraft.title = title; campaignDraft.step = "description";
    return bot.sendMessage(msg.chat.id, "Now send the campaign description.\n\nYou can use multiple paragraphs and line breaks.", { reply_markup: { force_reply: true, input_field_placeholder: "Enter campaign description" } });
  }
  if (campaignDraft.step === "description") {
    if (!msg.text.trim()) return bot.sendMessage(msg.chat.id, "Please enter a campaign description.");
    campaignDraft.description = msg.text; campaignDraft.step = "url";
    return bot.sendMessage(msg.chat.id, "Great. Now send the blog URL.", { reply_markup: { force_reply: true, input_field_placeholder: "https://example.com/article" } });
  }
  if (campaignDraft.step === "url") {
    const url = msg.text.trim(); let valid = false;
    try { const u = new URL(url); valid = u.protocol === "http:" || u.protocol === "https:"; } catch {}
    if (!valid) return bot.sendMessage(msg.chat.id, "That doesn't look like a valid blog URL.\n\nPlease send a URL beginning with https://", { reply_markup: { force_reply: true, input_field_placeholder: "https://example.com/article" } });
    campaignDraft.url = url;
    await bot.sendMessage(msg.chat.id, `Campaign Preview\n\nTitle:\n${campaignDraft.title}\n\nDescription:\n${campaignDraft.description}\n\nURL:\n${campaignDraft.url}`, { reply_markup: { inline_keyboard: [[{ text: "✅ Save Campaign", callback_data: "campaign_save" }, { text: "❌ Cancel", callback_data: "campaign_cancel" }]] } });
  }
});

bot.on("callback_query", async q => {
  try {
    if (!q.from || String(q.from.id) !== ownerId) return bot.answerCallbackQuery(q.id, { text: "Access denied." });
    if (q.data !== "campaign_save" && q.data !== "campaign_cancel") return;
    if (!campaignDraft || !q.message) return bot.answerCallbackQuery(q.id, { text: "This campaign draft has expired." });
    const chatId = q.message.chat.id;
    if (q.data === "campaign_cancel") {
      campaignDraft = null; await bot.answerCallbackQuery(q.id, { text: "Campaign cancelled." });
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id });
      return bot.sendMessage(chatId, "Campaign creation cancelled.");
    }
    campaign.blogTitle = campaignDraft.title; campaign.blogDescription = campaignDraft.description; campaign.blogUrl = campaignDraft.url;
    await saveCampaign(); campaignDraft = null;
    await bot.answerCallbackQuery(q.id, { text: "Campaign saved!" });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: q.message.message_id });
    await bot.sendMessage(chatId, "✅ Campaign saved successfully.\n\nUse /blog to view it.");
  } catch (e) { console.error("Callback query error:", e.message); }
});

async function handleOAuthCallback(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`); const code = url.searchParams.get("code"); const state = url.searchParams.get("state");
    if (!code) { res.writeHead(400); return res.end("Missing authorization code."); }
    if (oauthState && state !== oauthState) { res.writeHead(400); return res.end("Invalid OAuth state."); }
    const auth = createOAuthClient(); const { tokens } = await auth.getToken(code);
    console.log("Google OAuth completed.", Boolean(tokens.refresh_token));
    res.writeHead(200, { "Content-Type": "text/html" }); res.end("<h2>Gmail connected successfully.</h2><p>You can return to Telegram.</p>");
  } catch (e) { console.error("OAuth callback error:", e.message); res.writeHead(500); res.end("Google authorization failed."); }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === webhookPath) return handleTelegramUpdate(req, res);
  if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("Jabari Promoter is running."); }
  if (req.method === "GET" && req.url.startsWith("/oauth2callback")) return handleOAuthCallback(req, res);
  res.writeHead(404); res.end("Not found");
});

async function handleTelegramUpdate(req, res) {
  try {
    if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) { res.writeHead(403); return res.end("Forbidden"); }
    let body = ""; req.on("data", chunk => body += chunk.toString());
    req.on("end", async () => { try { await bot.processUpdate(JSON.parse(body)); res.writeHead(200); res.end("OK"); } catch (e) { console.error("Telegram update error:", e.message); res.writeHead(500); res.end("Update error"); } });
  } catch (e) { console.error("Webhook error:", e.message); res.writeHead(500); res.end("Server error"); }
}

server.listen(PORT, async () => {
  console.log(`Jabari Promoter is running on port ${PORT}`);
  try { const me = await bot.getMe(); console.log(`Telegram authenticated as @${me.username}`); await bot.setWebHook(webhookUrl, { secret_token: webhookSecret, drop_pending_updates: false }); console.log(`Telegram webhook registered: ${webhookUrl}`); }
  catch (e) { console.error("Telegram webhook setup failed:", e.message); }
  try { const { error } = await supabase.from("promoter_campaign").select("id").eq("id", 1).single(); if (error) console.error("Supabase connection failed:", error.message); else console.log("Supabase connected successfully: { id: 1 }"); contacts = await loadContacts(); await loadCampaign(); console.log(`Loaded ${contacts.length} contacts from Supabase.`); console.log(`Campaign loaded: ${campaign.blogTitle || "No campaign title"}`); }
  catch (e) { console.error("Startup data initialization failed:", e.message); }
});

process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));
process.on("uncaughtException", e => console.error("Uncaught exception:", e));
console.log("Jabari Promoter code loaded successfully.");
