require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const dns = require("dns").promises;
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const websiteBlog = require("./lib/website/blog");
const websiteShop = require("./lib/website/shop");
const websiteReviews = require("./lib/website/reviews");

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerId = String(process.env.BOT_OWNER_ID || "");
const mode = process.env.MODE || "dry-run";
const PORT = Number(process.env.PORT || 10000);
const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://jabari-promoter.onrender.com";

if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
const promoterSupabaseUrl =
  process.env.PROMOTER_SUPABASE_URL || "";

const promoterSupabaseServiceRoleKey =
  process.env.PROMOTER_SUPABASE_SERVICE_ROLE_KEY || "";

if (!promoterSupabaseUrl || !promoterSupabaseServiceRoleKey) {
  throw new Error(
    "Missing PROMOTER_SUPABASE_URL or PROMOTER_SUPABASE_SERVICE_ROLE_KEY. " +
    "Jabari Promoter must use its own dedicated Supabase project."
  );
}

const supabase = createClient(
  promoterSupabaseUrl,
  promoterSupabaseServiceRoleKey
);
const bot = new TelegramBot(token, { polling: false });

const webhookSecret = crypto.createHash("sha256").update(token).digest("hex");
const webhookPath = process.env.TELEGRAM_WEBHOOK_PATH || `/telegram-webhook-${webhookSecret.slice(0, 32)}`;
const webhookUrl = `${BASE_URL}${webhookPath}`;

const googleClientId = process.env.GOOGLE_CLIENT_ID || "";
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
const googleRefreshToken = process.env.GOOGLE_REFRESH_TOKEN || "";
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `${BASE_URL}/oauth2callback`;
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const geminiFallbackModels = [geminiModel, "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"].filter((v,i,a) => v && a.indexOf(v) === i);

const PROMOTION_LIMIT = 10;
let contacts = [];
let inputState = null;
let stats = { totalRuns: 0, totalSent: 0, totalFailed: 0, lastRun: null };
let oauthState = null;
let scanResults = [];
let scanPages = [];
let scanSkippedPages = [];
let scanAttempts = 0;
let scanSelected = new Set();
let scanRunning = false;

function isOwner(update) {
  return !!ownerId && String(update?.from?.id) === ownerId;
}

function deny(chatId) {
  return bot.sendMessage(chatId, "Access denied.");
}

function menu(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

function btn(text, data) {
  return { text, callback_data: data };
}

async function safeEdit(chatId, messageId, text, replyMarkup) {
  try {
    return await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup || { inline_keyboard: [] },
      disable_web_page_preview: true
    });
  } catch (e) {
    if (!String(e.message || "").includes("message is not modified")) {
      console.error("Menu edit error:", e.message);
    }
  }
}

async function answer(q, text) {
  try { await bot.answerCallbackQuery(q.id, text ? { text } : {}); } catch (_) {}
}

async function loadContacts() {
  const { data, error } = await supabase
    .from("promoter_contacts")
    .select("id, name, email")
    .order("id", { ascending: true });
  if (error) throw error;
  contacts = data || [];
  return contacts;
}

async function addContact(name, email) {
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new Error("Please provide a valid email address.");
  const { data, error } = await supabase
    .from("promoter_contacts")
    .insert({ name: name.trim(), email: cleanEmail })
    .select("id, name, email")
    .single();
  if (error) throw error;
  await loadContacts();
  return data;
}

async function removeContact(id) {
  const { error } = await supabase.from("promoter_contacts").delete().eq("id", id);
  if (error) throw error;
  await loadContacts();
}


function isPrivateIp(ip) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error("Please provide a valid website URL."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http:// and https:// websites are supported.");
  if (u.username || u.password) throw new Error("Website URLs with embedded usernames or passwords are not allowed.");
  const addresses = await dns.lookup(u.hostname, { all: true });
  if (!addresses.length || addresses.some(x => isPrivateIp(x.address))) {
    throw new Error("That website resolves to a private or local network address and cannot be scanned.");
  }
  return u;
}

async function fetchPublicPage(rawUrl, maxRedirects = 3) {
  let current = await assertPublicUrl(rawUrl);
  for (let i = 0; i <= maxRedirects; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    try {
      response = await fetch(current.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "JabariPromoter/1.0 (+public-email-scanner)" }
      });
    } catch (e) {
      if (e?.name === "AbortError") throw new Error("The website took too long to respond.");
      throw new Error(`Could not open the website: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Website returned redirect status ${response.status} without a destination.`);
      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }
    if (!response.ok) throw new Error(`Website returned HTTP ${response.status}.`);
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) throw new Error("That URL does not appear to be a public HTML webpage.");
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 1500000) throw new Error("The webpage is too large to scan safely.");

    const reader = response.body?.getReader();
    if (!reader) return { url: current.href, html: await response.text() };
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 1500000) {
        await reader.cancel();
        throw new Error("The webpage is too large to scan safely.");
      }
      chunks.push(value);
    }
    return { url: current.href, html: Buffer.concat(chunks.map(x => Buffer.from(x))).toString("utf8") };
  }
  throw new Error("Too many website redirects.");
}

function decodeHtmlForEmailScan(html) {
  return html
    .replace(/&#64;|&#x40;|&commat;/gi, "@")
    .replace(/&#46;|&#x2e;|&period;/gi, ".")
    .replace(/\s*(?:\[|\(|\{)\s*at\s*(?:\]|\)|\})\s*/gi, "@")
    .replace(/\s*(?:\[|\(|\{)\s*dot\s*(?:\]|\)|\})\s*/gi, ".");
}

function isLikelyTechnicalEmail(email) {
  const value = String(email || '').toLowerCase();
  const domain = value.split('@')[1] || '';
  const technicalDomains = [
    'sentry.io',
    'bugsnag.com',
    'datadoghq.com',
    'newrelic.com',
    'segment.io',
    'mixpanel.com',
    'hotjar.com',
    'logrocket.com'
  ];
  if (technicalDomains.some(d => domain === d || domain.endsWith(`.${d}`))) return true;
  if (/(^|[._-])(telemetry|tracking|analytics|errors?|crash|logging)([._-]|$)/i.test(value)) return true;
  return false;
}

function extractEmails(html) {
  const decoded = decodeHtmlForEmailScan(html);
  const found = new Set();

  const mailtos = decoded.match(/mailto:[^'"\s>]+/gi) || [];
  for (const item of mailtos) {
    const email = item.slice(7).split(/[?#]/)[0].trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) found.add(email);
  }

  const plain = decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  for (const email of plain) found.add(email.toLowerCase());

  return [...found]
    .filter(email => !/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(email))
    .filter(email => !isLikelyTechnicalEmail(email));
}

function linkPriority(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (/(^|[-_/])(contact|contacts|reach-us|reach|support|connect)([-_/]|$)/.test(path)) return 0;
  if (/(^|[-_/])(about|company|team|staff|directory|people)([-_/]|$)/.test(path)) return 1;
  if (/(^|[-_/])(school|admissions|administration|office|help)([-_/]|$)/.test(path)) return 2;
  return 3;
}

function extractSameOriginLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = [];
  const seen = new Set();
  const re = /(?:href|action)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) && links.length < 50) {
    try {
      const u = new URL(match[1], base);
      if (!["http:", "https:"].includes(u.protocol) || u.origin !== base.origin) continue;
      u.hash = "";
      if (/\.(pdf|zip|png|jpe?g|gif|webp|svg|mp4|mp3|css|js)(\?.*)?$/i.test(u.pathname)) continue;
      if (u.href === base.href || seen.has(u.href)) continue;
      seen.add(u.href);
      links.push(u.href);
    } catch (_) {}
  }
  return links.sort((a, b) => linkPriority(a) - linkPriority(b));
}

async function scanWebsite(rawUrl, onProgress) {
  const first = await assertPublicUrl(rawUrl);
  const queue = [first.href];
  const queued = new Set(queue);
  const visited = new Set();
  const emails = new Set();
  const pages = [];
  const skippedPages = [];
  const maxPages = 15;
  const maxAttempts = 30;
  let attempts = 0;

  while (queue.length && pages.length < maxPages && attempts < maxAttempts) {
    const url = queue.shift();
    queued.delete(url);
    if (visited.has(url)) continue;
    visited.add(url);

    attempts++;
    const pageNumber = attempts;
    if (onProgress) await onProgress(`🔎 Scanning public page ${pageNumber}…\n\n${url}\n\nSuccessfully scanned: ${pages.length}/${maxPages}`);

    try {
      const page = await fetchPublicPage(url);
      pages.push(page.url);

      const foundOnPage = extractEmails(page.html);
      for (const email of foundOnPage) emails.add(email);

      if (onProgress) {
        const foundText = foundOnPage.length ? `\n📧 Found ${foundOnPage.length} email${foundOnPage.length === 1 ? "" : "s"} on this page.` : "\nNo email found on this page.";
        await onProgress(`🔎 Scanned page ${pages.length}/${maxPages}\n\n${page.url}${foundText}\n\nSkipped: ${skippedPages.length}`);
      }

      if (pages.length < maxPages) {
        for (const link of extractSameOriginLinks(page.html, page.url)) {
          if (!visited.has(link) && !queued.has(link) && queue.length < 20) {
            queue.push(link);
            queued.add(link);
          }
        }
      }
    } catch (e) {
      skippedPages.push({ url, reason: e.message });
      console.log(`Scanner skipped ${url}: ${e.message}`);
      if (onProgress) await onProgress(`⚠️ Page skipped — continuing…\n\n${url}\n\nReason: ${e.message}\n\nSuccessfully scanned: ${pages.length}/${maxPages}\nSkipped: ${skippedPages.length}`);
    }
  }

  return { emails: [...emails].sort(), pages, skippedPages, attempts };
}

async function addScannedEmails(emails) {
  await loadContacts();
  const existing = new Set(contacts.map(c => c.email.toLowerCase()));
  let added = 0;
  for (const email of emails) {
    if (existing.has(email.toLowerCase())) continue;
    try {
      await addContact("", email);
      existing.add(email.toLowerCase());
      added++;
    } catch (e) {
      console.error(`Could not add scanned email ${email}:`, e.message);
    }
  }
  return added;
}

async function getCampaigns() {
  const { data, error } = await supabase
    .from("promoter_campaigns")
    .select("id, title, description, blog_url, is_active, created_at, updated_at")
    .order("is_active", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function getCampaign(id) {
  const { data, error } = await supabase.from("promoter_campaigns").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

async function getActiveCampaign() {
  const { data, error } = await supabase
    .from("promoter_campaigns")
    .select("*")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function createCampaign(title, description, url) {
  const { data, error } = await supabase
    .from("promoter_campaigns")
    .insert({ title, description, blog_url: url, is_active: false })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function updateCampaign(id, title, description, url) {
  const { data, error } = await supabase
    .from("promoter_campaigns")
    .update({ title, description, blog_url: url, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function setActiveCampaign(id) {
  const { error: clearError } = await supabase
    .from("promoter_campaigns")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("is_active", true);
  if (clearError) throw clearError;

  const { error } = await supabase
    .from("promoter_campaigns")
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

async function deleteCampaignById(id) {
  const { error } = await supabase.from("promoter_campaigns").delete().eq("id", id);
  if (error) throw error;
}

function campaignPreview(c) {
  return `Campaign Preview\n\nTitle:\n${c.title || "Not set"}\n\nDescription:\n${c.description || "Not set"}\n\nURL:\n${c.blog_url || "Not set"}\n\nStatus: ${c.is_active ? "🟢 Active" : "⚪ Saved"}`;
}


function mainMenuText() {
  return "🚀 Jabari Promoter\n\nChoose what you want to do:";
}

function mainMenu() {
  return menu([
    [btn("📝 Campaigns", "menu_campaigns"), btn("🌐 Website Blog", "menu_website_blog")],
    [btn("🛍️ Website Shop", "menu_website_shop"), btn("⭐ Website Reviews", "menu_website_reviews")],
    [btn("👥 Contacts", "menu_contacts"), btn("📧 Promote", "menu_promote")],
    [btn("🕵️ Email Scanner", "menu_scanner"), btn("📊 Status", "menu_status")],
    [btn("🧪 Test Email", "menu_testemail")]
  ]);
}

async function showMain(chatId, messageId) {
  if (messageId) return safeEdit(chatId, messageId, mainMenuText(), mainMenu().reply_markup);
  return bot.sendMessage(chatId, mainMenuText(), mainMenu());
}


async function showWebsiteBlogMenu(chatId, messageId) {
  const posts = await websiteBlog.listPosts();
  const text = `🌐 Website Blog\n\nPosts in GitHub: ${posts.length}\n\nThis uses the same blog/posts.json as the Jabari website.`;
  const rows = [
    [btn("📋 View Posts", "website_blog_list")],
    [btn("➕ New Post", "website_blog_create")],
    [btn("🔄 Refresh", "menu_website_blog")],
    [btn("⬅️ Back", "menu_main")]
  ];
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showWebsiteBlogList(chatId, messageId) {
  const posts = await websiteBlog.listPosts();
  if (!posts.length) {
    const kb = { inline_keyboard: [[btn("➕ New Post", "website_blog_create")], [btn("⬅️ Back", "menu_website_blog")]] };
    const text = "📋 Website Blog\n\nNo posts found.";
    if (messageId) return safeEdit(chatId, messageId, text, kb);
    return bot.sendMessage(chatId, text, { reply_markup: kb });
  }
  const rows = posts.slice(0, 30).map(p => [btn(`${p.title || "Untitled"}`.slice(0, 50), `website_blog_view:${p.id}`)]);
  rows.push([btn("➕ New Post", "website_blog_create")]);
  rows.push([btn("⬅️ Back", "menu_website_blog")]);
  const text = `📋 Website Blog\n\nShowing ${Math.min(posts.length, 30)} of ${posts.length} posts.`;
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showWebsiteBlogDetails(chatId, messageId, id) {
  const posts = await websiteBlog.listPosts();
  const p = posts.find(x => String(x.id) === String(id));
  if (!p) throw new Error("Blog post not found.");
  const preview = String(p.content || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const text = `📰 ${p.title}\n\nDate: ${p.date || "—"}\n\n${preview.slice(0, 2500)}${preview.length > 2500 ? "…" : ""}`;
  const kb = { inline_keyboard: [
    [btn("✏️ Edit", `website_blog_edit:${p.id}`), btn("🗑️ Delete", `website_blog_delete:${p.id}`)],
    [btn("⬅️ Back", "website_blog_list")]
  ]};
  if (messageId) return safeEdit(chatId, messageId, text, kb);
  return bot.sendMessage(chatId, text, { reply_markup: kb });
}

async function startWebsiteBlogWizard(chatId, messageId, mode, post = null) {
  inputState = {
    chatId,
    type: mode === "edit" ? "website_blog_edit" : "website_blog_create",
    step: "title",
    id: post?.id || null,
    title: post?.title || "",
    content: post?.content || "",
    image: post?.image || "",
    video: post?.video || ""
  };

  const heading = mode === "edit" ? "✏️ Edit Website Blog Post" : "➕ New Website Blog Post";
  const prompt = mode === "edit"
    ? `Current title:\n${post?.title || "Untitled"}\n\nEnter the new title.`
    : "Enter the blog post title.";

  return safeEdit(chatId, messageId, `${heading}\n\n${prompt}`, {
    inline_keyboard: [[btn("❌ Cancel", "website_blog_cancel")]]
  });
}

async function showWebsiteShopMenu(chatId, messageId) {
  const products = await websiteShop.listProducts();
  const text = `🛍️ Website Shop

Products in GitHub: ${products.length}

This uses the same shop/products.json as the Jabari website.`;

  const rows = [
    [btn("📋 View Products", "website_shop_list")],
    [btn("➕ New Product", "website_shop_create")],
    [btn("🔄 Refresh", "menu_website_shop")],
    [btn("⬅️ Back", "menu_main")]
  ];

  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showWebsiteShopList(chatId, messageId) {
  const products = await websiteShop.listProducts();

  if (!products.length) {
    const kb = {
      inline_keyboard: [
        [btn("➕ New Product", "website_shop_create")],
        [btn("⬅️ Back", "menu_website_shop")]
      ]
    };

    const text = "📋 Website Shop\n\nNo products found.";

    if (messageId) return safeEdit(chatId, messageId, text, kb);
    return bot.sendMessage(chatId, text, { reply_markup: kb });
  }

  const rows = products.slice(0, 30).map(p => [
    btn(
      `${p.active === false ? "⚪" : "🟢"} ${p.title || "Untitled"} — ₦${Number(p.priceNaira || 0).toLocaleString()}`.slice(0, 60),
      `website_shop_view:${p.slug}`
    )
  ]);

  rows.push([btn("➕ New Product", "website_shop_create")]);
  rows.push([btn("⬅️ Back", "menu_website_shop")]);

  const text =
    `📋 Website Shop\n\nShowing ${Math.min(products.length, 30)} of ${products.length} products.`;

  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showWebsiteShopDetails(chatId, messageId, slug) {
  const products = await websiteShop.listProducts();
  const p = products.find(x => String(x.slug) === String(slug));

  if (!p) throw new Error("Shop product not found.");

  const text =
    `🛍️ ${p.title}\n\n` +
    `Price: ₦${Number(p.priceNaira || 0).toLocaleString()}\n` +
    `Status: ${p.active === false ? "⚪ Inactive" : "🟢 Active"}\n` +
    `PDF: ${p.file || "—"}\n\n` +
    `${p.desc || ""}`;

  const toggle = p.active === false ? "🟢 Activate" : "⚪ Deactivate";

  const kb = {
    inline_keyboard: [
      [
        btn("✏️ Edit", `website_shop_edit:${p.slug}`),
        btn(toggle, `website_shop_toggle:${p.slug}`)
      ],
      [btn("🗑️ Delete", `website_shop_delete:${p.slug}`)],
      [btn("⬅️ Back", "website_shop_list")]
    ]
  };

  if (messageId) return safeEdit(chatId, messageId, text, kb);
  return bot.sendMessage(chatId, text, { reply_markup: kb });
}

async function startWebsiteShopWizard(chatId, messageId, mode, product = null) {
  inputState = {
    chatId,
    type: mode === "edit" ? "website_shop_edit" : "website_shop_create",
    step: "title",
    slug: product?.slug || "",
    title: product?.title || "",
    desc: product?.desc || "",
    priceNaira: product?.priceNaira || "",
    file: product?.file || ""
  };

  const heading =
    mode === "edit"
      ? "✏️ Edit Website Shop Product"
      : "➕ New Website Shop Product";

  const prompt =
    mode === "edit"
      ? `Current title:\n${product?.title || "Untitled"}\n\nEnter the new title.`
      : "Enter the product title.";

  return safeEdit(
    chatId,
    messageId,
    `${heading}\n\n${prompt}`,
    { inline_keyboard: [[btn("❌ Cancel", "website_shop_cancel")]] }
  );
}


async function showWebsiteReviewsMenu(chatId, messageId) {
  const reviews = await websiteReviews.listReviews();
  const pending = reviews.filter(r => r.status !== 'hidden').length;
  const hidden = reviews.filter(r => r.status === 'hidden').length;
  const text = `⭐ Website Reviews\n\nTotal: ${reviews.length}\nVisible: ${pending}\nHidden: ${hidden}\n\nThis uses the same reviews/reviews.json as the Jabari website.`;
  const rows = [
    [btn("📋 View Reviews", "website_reviews_list")],
    [btn("🔄 Refresh", "menu_website_reviews")],
    [btn("⬅️ Back", "menu_main")]
  ];
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showWebsiteReviewsList(chatId, messageId) {
  const reviews = await websiteReviews.listReviews();
  if (!reviews.length) {
    const kb = { inline_keyboard: [[btn("🔄 Refresh", "menu_website_reviews")], [btn("⬅️ Back", "menu_website_reviews")]] };
    const text = "📋 Website Reviews\n\nNo reviews found.";
    if (messageId) return safeEdit(chatId, messageId, text, kb);
    return bot.sendMessage(chatId, text, { reply_markup: kb });
  }
  const rows = reviews.slice(0, 30).map(r => {
    const stars = '★'.repeat(Math.max(0, Math.min(5, Number(r.rating) || 0)));
    const status = r.status === 'hidden' ? '⚪' : '🟢';
    return [btn(`${status} ${stars || '—'} ${String(r.name || 'Anonymous').slice(0, 30)}`.slice(0, 60), `website_review_view:${r.id}`)];
  });
  rows.push([btn("🔄 Refresh", "menu_website_reviews")]);
  rows.push([btn("⬅️ Back", "menu_website_reviews")]);
  const text = `📋 Website Reviews\n\nShowing ${Math.min(reviews.length, 30)} of ${reviews.length} reviews.`;
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showWebsiteReviewDetails(chatId, messageId, id) {
  const reviews = await websiteReviews.listReviews();
  const r = reviews.find(x => String(x.id) === String(id));
  if (!r) throw new Error("Review not found.");
  const stars = '★'.repeat(Math.max(0, Math.min(5, Number(r.rating) || 0))) + '☆'.repeat(Math.max(0, 5 - Math.min(5, Number(r.rating) || 0)));
  const date = r.createdAt ? new Date(r.createdAt).toLocaleString() : '—';
  const text = `⭐ Website Review\n\n${r.name || 'Anonymous'}\n${stars}\n\n${r.message || ''}\n\nStatus: ${r.status === 'hidden' ? '⚪ Hidden' : '🟢 Visible'}\nDate: ${date}\n\n${r.reply ? `Jabari reply:\n${r.reply}` : 'No reply yet.'}`;
  const statusButton = r.status === 'hidden'
    ? btn("✅ Approve", `website_review_approve:${r.id}`)
    : btn("👁️ Hide", `website_review_hide:${r.id}`);
  const rows = [
    [statusButton, btn(r.reply ? "✏️ Edit Reply" : "💬 Reply", `website_review_reply:${r.id}`)],
    ...(r.reply ? [[btn("🗑️ Delete Reply", `website_review_delete_reply:${r.id}`)]] : []),
    [btn("❌ Delete Review", `website_review_delete:${r.id}`)],
    [btn("⬅️ Back", "website_reviews_list")]
  ];
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}


async function showCampaignMenu(chatId, messageId) {
  const campaigns = await getCampaigns();
  const active = campaigns.find(c => c.is_active);
  let text = `📝 Campaigns\n\nSaved campaigns: ${campaigns.length}\n\n`;
  text += active ? `🟢 Active: ${active.title}` : "⚪ No active campaign";
  const rows = [[btn("➕ Create New Campaign", "campaign_create")]];
  if (campaigns.length) rows.push([btn("📋 View Campaigns", "campaign_list")]);
  if (active) rows.push([btn("🟢 Active Campaign", `campaign_view:${active.id}`)]);
  rows.push([btn("⬅️ Back", "menu_main")]);
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showCampaignList(chatId, messageId) {
  const campaigns = await getCampaigns();
  if (!campaigns.length) {
    const text = "📋 My Campaigns\n\nNo campaigns saved yet.";
    const kb = { inline_keyboard: [[btn("➕ Create New Campaign", "campaign_create")], [btn("⬅️ Back", "menu_campaigns")]] };
    if (messageId) return safeEdit(chatId, messageId, text, kb); return bot.sendMessage(chatId, text, { reply_markup: kb });
  }
  const rows = campaigns.map(c => [btn(`${c.is_active ? "🟢" : "⚪"} ${c.title.slice(0, 40)}`, `campaign_view:${c.id}`)]);
  rows.push([btn("➕ Create New Campaign", "campaign_create")]);
  rows.push([btn("⬅️ Back", "menu_campaigns")]);
  const text = "📋 My Campaigns\n\nTap a campaign to view or manage it.";
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showCampaignDetails(chatId, messageId, id) {
  const c = await getCampaign(id);
  const rows = [];
  if (!c.is_active) rows.push([btn("🚀 Make Active", `campaign_active:${c.id}`)]);
  rows.push([btn("✏️ Edit", `campaign_edit:${c.id}`), btn("🗑️ Delete", `campaign_delete:${c.id}`)]);
  rows.push([btn("⬅️ Back", "campaign_list")]);
  const text = campaignPreview(c);
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showContactsMenu(chatId, messageId) {
  await loadContacts();
  const rows = [[btn("➕ Add Contact", "contact_add")]];
  if (contacts.length) rows.push([btn("📋 View Contacts", "contact_list")]);
  rows.push([btn("⬅️ Back", "menu_main")]);
  const text = `👥 Contacts\n\nSaved contacts: ${contacts.length}`;
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showContactList(chatId, messageId) {
  await loadContacts();
  if (!contacts.length) return showContactsMenu(chatId, messageId);
  const text = "📋 Contacts\n\nTap a contact to manage it.";
  const rows = contacts.map(c => [btn(`${c.name || "No name"} — ${c.email}`.slice(0, 60), `contact_view:${c.id}`)]);
  rows.push([btn("➕ Add Contact", "contact_add")]);
  rows.push([btn("⬅️ Back", "menu_contacts")]);
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function showContactDetails(chatId, messageId, id) {
  const c = contacts.find(x => String(x.id) === String(id)) || (await supabase.from("promoter_contacts").select("id,name,email").eq("id", id).single()).data;
  if (!c) throw new Error("Contact not found.");
  const text = `👤 Contact\n\nName:\n${c.name || "No name"}\n\nEmail:\n${c.email}`;
  const kb = { inline_keyboard: [[btn("🗑️ Delete Contact", `contact_delete:${c.id}`)], [btn("⬅️ Back", "contact_list")]] };
  if (messageId) return safeEdit(chatId, messageId, text, kb);
  return bot.sendMessage(chatId, text, { reply_markup: kb });
}


async function showScannerMenu(chatId, messageId) {
  const text = `🕵️ Email Scanner\n\nScan publicly accessible webpages for publicly listed email addresses.\n\nPrivate accounts and login-protected pages are not accessed.\n\nCurrent results: ${scanResults.length}${scanRunning ? "\n\n⏳ A scan is currently running…" : ""}`;
  const rows = scanRunning ? [] : [[btn("🌐 Scan Website", "scanner_website")]];
  if (scanResults.length) rows.push([btn("👀 View Results", "scanner_results"), btn("➕ Add All", "scanner_add_all")]);
  rows.push([btn("⬅️ Back", "menu_main")]);
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

function scannerResultsText() {
  if (!scanResults.length) return "🕵️ Scanner Results\n\nNo public email addresses were found.";
  const selectedCount = scanResults.filter(email => scanSelected.has(email)).length;
  const skippedText = scanSkippedPages.length ? `\nSkipped: ${scanSkippedPages.length}` : "";
  return `🕵️ Scanner Results\n\nFound: ${scanResults.length}\nPages scanned: ${scanPages.length}${skippedText}\nSelected: ${selectedCount}\n\nTap an email to select/deselect it.`;
}

async function showScannerResults(chatId, messageId) {
  const rows = [];
  if (scanResults.length) {
    for (const email of scanResults.slice(0, 40)) {
      const mark = scanSelected.has(email) ? "☑️" : "⬜";
      rows.push([btn(`${mark} ${email}`.slice(0, 60), `scanner_toggle:${encodeURIComponent(email)}`)]);
    }
    if (scanResults.length > 40) rows.push([btn(`…and ${scanResults.length - 40} more`, "scanner_noop")]);
    rows.push([btn("➕ Add Selected", "scanner_add_selected"), btn("➕ Add All", "scanner_add_all")]);
  }
  rows.push([btn("🕵️ Scan Another Website", "scanner_website")]);
  rows.push([btn("⬅️ Scanner", "menu_scanner")]);
  if (messageId) return safeEdit(chatId, messageId, scannerResultsText(), { inline_keyboard: rows });
  return bot.sendMessage(chatId, scannerResultsText(), { reply_markup: { inline_keyboard: rows } });
}

async function showStatus(chatId, messageId) {
  const active = await getActiveCampaign();
  await loadContacts();
  const text = `📊 Jabari Promoter Status\n\nMode: ${mode}\nContacts: ${contacts.length}\nCampaigns: ${(await getCampaigns()).length}\nActive campaign: ${active ? active.title : "None"}\n\nLast promotion: ${stats.lastRun || "No promotion yet"}\nSent: ${stats.totalSent}\nFailed: ${stats.totalFailed}`;
  const kb = { inline_keyboard: [[btn("🔄 Refresh", "menu_status")], [btn("⬅️ Back", "menu_main")]] };
  if (messageId) return safeEdit(chatId, messageId, text, kb);
  return bot.sendMessage(chatId, text, { reply_markup: kb });
}

async function showPromoteMenu(chatId, messageId) {
  const active = await getActiveCampaign();
  await loadContacts();
  if (!active) {
    const text = "📧 Promote\n\nThere is no active campaign yet. Create a campaign and make it active first.";
    const kb = { inline_keyboard: [[btn("📝 Campaigns", "menu_campaigns")], [btn("⬅️ Back", "menu_main")]] };
    if (messageId) return safeEdit(chatId, messageId, text, kb); return bot.sendMessage(chatId, text, { reply_markup: kb });
  }
  const text = `📧 Promote\n\nActive campaign:\n${active.title}\n\nRecipients: ${contacts.length}\nPromotion limit per run: ${Math.min(contacts.length, PROMOTION_LIMIT)}`;
  const rows = [[btn("🚀 Start Promotion", "promote_confirm")], [btn("📝 View Campaign", `campaign_view:${active.id}`)], [btn("⬅️ Back", "menu_main")]];
  if (messageId) return safeEdit(chatId, messageId, text, { inline_keyboard: rows });
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: rows } });
}

async function validateUrl(url) {
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

function beginWizard(chatId, type, campaign = null) {
  inputState = {
    chatId,
    type,
    step: "title",
    id: campaign?.id || null,
    title: campaign?.title || "",
    description: campaign?.description || "",
    url: campaign?.blog_url || ""
  };
}

async function promptWizard(chatId) {
  const s = inputState;
  if (!s) return;
  const prompts = {
    title: "Step 1 of 3\n\n📝 Enter the campaign title.",
    description: "Step 2 of 3\n\n📄 Enter the campaign description.\n\nMultiple paragraphs and line breaks are supported.",
    url: "Step 3 of 3\n\n🔗 Enter the blog URL."
  };
  return bot.sendMessage(chatId, prompts[s.step], { reply_markup: { force_reply: true } });
}

async function sendWizardPreview(chatId) {
  const s = inputState;
  const text = `Campaign Preview\n\nTitle:\n${s.title}\n\nDescription:\n${s.description}\n\nURL:\n${s.url}`;
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[btn("✅ Save Campaign", "wizard_save"), btn("✏️ Start Over", "wizard_restart")], [btn("❌ Cancel", "wizard_cancel")]] } });
}

async function finishPromotion(chatId) {
  const active = await getActiveCampaign();
  const list = await loadContacts();
  if (!active) throw new Error("No active campaign.");
  if (!list.length) throw new Error("No contacts have been added yet.");
  const recipients = list.slice(0, PROMOTION_LIMIT);
  const subject = `Jabari Promoter — ${active.title || "New Blog Post"}`;
  const body = ["Hello,", "", "We would like to share a new blog post with you.", "", active.title, "", active.description, "", "Read the full post:", active.blog_url, "", "Best regards,", "Jabari Promoter"].join("\n");
  const out = [];
  stats.totalRuns++;
  stats.lastRun = new Date().toISOString();
  for (const c of recipients) {
    try {
      await sendEmail(c.email, subject, body);
      stats.totalSent++;
      out.push({ email: c.email, status: "sent" });
      await supabase.from("promoter_results").insert({ email: c.email, status: "sent", campaign_title: active.title });
    } catch (e) {
      stats.totalFailed++;

      console.error("EMAIL SEND FAILED:", {
        email: c.email,
        message: e?.message || "Unknown error",
        code: e?.code || e?.response?.status || null,
        status: e?.response?.status || null,
        response: e?.response?.data || null,
        errors: e?.errors || null
      });

      out.push({ email: c.email, status: "failed", error: e?.message || "Unknown error" });
      await supabase.from("promoter_results").insert({ email: c.email, status: "failed", campaign_title: active.title });
    }
  }
  return out;
}

function createOAuthClient() {
  const { google } = require("googleapis");
  return new google.auth.OAuth2(googleClientId, googleClientSecret, googleRedirectUri);
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createGmailMessage(to, subject, text) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  return base64UrlEncode([
    "From: Jabari Promoter <jabari.xai@gmail.com>",
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text
  ].join("\r\n"));
}

async function sendEmail(to, subject, text) {
  if (mode !== "live") {
    console.log(`[DRY RUN] Email to ${to}: ${subject}`);
    return { success: true, dryRun: true };
  }
  if (!googleClientId || !googleClientSecret || !googleRefreshToken) throw new Error("Google OAuth environment variables are missing.");
  const { google } = require("googleapis");
  const auth = createOAuthClient();
  auth.setCredentials({ refresh_token: googleRefreshToken });
  const gmail = google.gmail({ version: "v1", auth });
  try {
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: createGmailMessage(to, subject, text) }
    });
    if (!response?.data?.id) throw new Error("Gmail API did not return a message ID.");
    return { success: true, id: response.data.id };
  } catch (e) {
    console.error("GMAIL API SEND ERROR:", {
      message: e?.message || "Unknown Gmail error",
      code: e?.code || null,
      status: e?.response?.status || null,
      statusText: e?.response?.statusText || null,
      response: e?.response?.data || null,
      errors: e?.errors || null
    });
    throw e;
  }
}

// ----- Commands: kept as backups. Normal navigation uses buttons. -----
bot.onText(/^\/start$/, async msg => {
  if (!isOwner(msg)) return deny(msg.chat.id);
  inputState = null;
  await showMain(msg.chat.id);
});
bot.onText(/^\/status$/, async msg => { if (isOwner(msg)) await showStatus(msg.chat.id); else await deny(msg.chat.id); });
bot.onText(/^\/blog$/, async msg => {
  if (!isOwner(msg)) return deny(msg.chat.id);
  const active = await getActiveCampaign();
  if (!active) return bot.sendMessage(msg.chat.id, "No active campaign.");
  await bot.sendMessage(msg.chat.id, campaignPreview(active));
});
bot.onText(/^\/campaign$/, async msg => { if (isOwner(msg)) await showCampaignMenu(msg.chat.id); else await deny(msg.chat.id); });
bot.onText(/^\/contacts$/, async msg => { if (isOwner(msg)) await showContactsMenu(msg.chat.id); else await deny(msg.chat.id); });
bot.onText(/^\/promote$/, async msg => { if (isOwner(msg)) await showPromoteMenu(msg.chat.id); else await deny(msg.chat.id); });
bot.onText(/^\/cancelcampaign$/, async msg => { if (!isOwner(msg)) return deny(msg.chat.id); inputState = null; await bot.sendMessage(msg.chat.id, "Campaign input cancelled."); await showMain(msg.chat.id); });
bot.onText(/^\/deletecampaign$/, async msg => { if (!isOwner(msg)) return deny(msg.chat.id); await showCampaignList(msg.chat.id); });
bot.onText(/^\/test$/, async msg => { if (isOwner(msg)) await bot.sendMessage(msg.chat.id, `Jabari Promoter test successful.\n\nTelegram: OK\nSupabase: configured\nGmail: ${googleRefreshToken ? "configured" : "not configured"}\nMode: ${mode}`); else await deny(msg.chat.id); });
bot.onText(/^\/testemail(?:\s+(.+))?$/i, async (msg, match) => {
  if (!isOwner(msg)) return deny(msg.chat.id);
  const email = match?.[1]?.trim();
  if (!email) return bot.sendMessage(msg.chat.id, "Use /testemail your@email.com");
  try { await sendEmail(email, "Jabari Promoter — Test", "Hello,\n\nThis is a test email from Jabari Promoter.\n\nJabari Promoter"); await bot.sendMessage(msg.chat.id, `Test email sent to:\n\n${email}`); }
  catch (e) { await bot.sendMessage(msg.chat.id, `Test email failed.\n\n${e.message}`); }
});

// ----- Text input flow -----
bot.on("message", async msg => {
  if (!isOwner(msg) || !msg.text || msg.text.startsWith("/") || !inputState || inputState.chatId !== msg.chat.id) return;
  const s = inputState;
  try {
    if (s.type === "scan_website") {
      const url = msg.text.trim();
      if (!(await validateUrl(url))) return bot.sendMessage(msg.chat.id, "Please send a valid URL beginning with https://");
      inputState = null;
      if (scanRunning) return bot.sendMessage(msg.chat.id, "⏳ A website scan is already running. Please wait for it to finish.");

      scanRunning = true;
      const progress = await bot.sendMessage(msg.chat.id, "🕵️ Starting website scan…\n\nI will scan the public homepage and prioritize Contact/About-style pages.");

      // Run the scan in the background so the Telegram webhook can respond immediately.
      void (async () => {
        try {
          const updateProgress = async text => {
            try {
              await safeEdit(msg.chat.id, progress.message_id, text);
            } catch (_) {}
          };
          const result = await scanWebsite(url, updateProgress);
          scanResults = result.emails;
          scanPages = result.pages;
          scanSkippedPages = result.skippedPages || [];
          scanAttempts = result.attempts || 0;
          scanSelected = new Set(scanResults);
          try { await showScannerResults(msg.chat.id, progress.message_id); } catch (_) { await showScannerResults(msg.chat.id); }
        } catch (e) {
          console.error("Website scanner error:", e.message);
          await safeEdit(msg.chat.id, progress.message_id, `❌ Scan failed.\n\n${e.message}`, { inline_keyboard: [[btn("🕵️ Scanner", "menu_scanner")], [btn("🏠 Main Menu", "menu_main")]] });
        } finally {
          scanRunning = false;
        }
      })();
      return;
    }

    if (s.type === "website_blog_create" || s.type === "website_blog_edit") {
      if (s.step === "title") {
        const title = msg.text.trim();
        if (!title) return bot.sendMessage(msg.chat.id, "Please enter a blog post title.");
        s.title = title;
        s.step = "content";
        return bot.sendMessage(msg.chat.id, "Now send the blog post content.\n\nYou can use multiple paragraphs.");
      }

      if (s.step === "content") {
        const content = msg.text;
        if (!content.trim()) return bot.sendMessage(msg.chat.id, "Please enter the blog post content.");
        s.content = content;
        const preview =
          `📝 ${s.type === "website_blog_edit" ? "Edit" : "New"} Website Blog Post\n\n` +
          `Title:\n${s.title}\n\n` +
          `Content:\n${s.content.slice(0, 3000)}${s.content.length > 3000 ? "…" : ""}\n\n` +
          `Save this post to the Jabari website?`;
        return bot.sendMessage(msg.chat.id, preview, {
          reply_markup: {
            inline_keyboard: [
              [btn("✅ Save to Website", "website_blog_save")],
              [btn("🔄 Start Again", "website_blog_restart")],
              [btn("❌ Cancel", "website_blog_cancel")]
            ]
          }
        });
      }
    }

if (s.type === "website_shop_create" || s.type === "website_shop_edit") {
  if (s.step === "title") {
    if (!msg.text.trim()) {
      return bot.sendMessage(msg.chat.id, "Please enter a product title.");
    }

    s.title = msg.text.trim();
    s.step = "desc";

    return bot.sendMessage(
      msg.chat.id,
      "Enter the product description."
    );
  }

  if (s.step === "desc") {
    if (!msg.text.trim()) {
      return bot.sendMessage(msg.chat.id, "Please enter a product description.");
    }

    s.desc = msg.text.trim();
    s.step = "price";

    return bot.sendMessage(
      msg.chat.id,
      "Enter the price in Nigerian Naira. Example: 1500"
    );
  }

  if (s.step === "price") {
    const price = Number(msg.text.replace(/[^0-9.]/g, ""));

    if (!Number.isFinite(price) || price <= 0) {
      return bot.sendMessage(
        msg.chat.id,
        "Please enter a valid price in Naira."
      );
    }

    s.priceNaira = price;
    s.step = "pdf";

    return bot.sendMessage(
      msg.chat.id,
      s.type === "website_shop_edit"
        ? "📄 Send a replacement PDF, or tap Keep Current PDF."
        : "📄 Send the product PDF.",
      {
        reply_markup: {
          inline_keyboard:
            s.type === "website_shop_edit"
              ? [
                  [btn("📄 Keep Current PDF", "website_shop_keep_pdf")],
                  [btn("❌ Cancel", "website_shop_cancel")]
                ]
              : [[btn("❌ Cancel", "website_shop_cancel")]]
        }
      }
    );
  }
}


    if (s.type === "website_review_reply") {
      const reply = msg.text.trim();
      if (!reply) return bot.sendMessage(msg.chat.id, "Please enter a reply, or tap Cancel.");
      await websiteReviews.setReply(s.id, reply);
      inputState = null;
      return bot.sendMessage(msg.chat.id, "✅ Reply saved to the website.", { reply_markup: { inline_keyboard: [[btn("⭐ Review", `website_review_view:${s.id}`)], [btn("📋 Reviews", "website_reviews_list")], [btn("🏠 Main Menu", "menu_main")]] } });
    }

    if (s.type === "campaign_create" || s.type === "campaign_edit") {
      if (s.step === "title") {
        if (!msg.text.trim()) return bot.sendMessage(msg.chat.id, "Please enter a campaign title.");
        s.title = msg.text.trim(); s.step = "description"; return promptWizard(msg.chat.id);
      }
      if (s.step === "description") {
        if (!msg.text.trim()) return bot.sendMessage(msg.chat.id, "Please enter a campaign description.");
        s.description = msg.text; s.step = "url"; return promptWizard(msg.chat.id);
      }
      if (s.step === "url") {
        const url = msg.text.trim();
        if (!(await validateUrl(url))) return bot.sendMessage(msg.chat.id, "Please send a valid URL beginning with https://");
        s.url = url; s.step = "preview"; return sendWizardPreview(msg.chat.id);
      }
    }

    if (s.type === "contact_add") {
      if (s.step === "name") {
        s.name = msg.text.trim(); s.step = "email";
        return bot.sendMessage(msg.chat.id, "Now enter the contact's email address.", { reply_markup: { force_reply: true } });
      }
      if (s.step === "email") {
        const c = await addContact(s.name || "", msg.text.trim());
        inputState = null;
        await bot.sendMessage(msg.chat.id, `✅ Contact added.\n\n${c.name || "No name"}\n${c.email}`);
        return showContactsMenu(msg.chat.id);
      }
    }
  } catch (e) {
    console.error("Input flow error:", e.message);
    await bot.sendMessage(msg.chat.id, `Something went wrong.\n\n${e.message}`);
  }
});

// ----- Buttons -----
bot.on("callback_query", async q => {
  if (!q.from || String(q.from.id) !== ownerId) return answer(q, "Access denied.");
  const chatId = q.message?.chat?.id;
  const messageId = q.message?.message_id;
  const data = q.data || "";
  if (!chatId) return answer(q);

  try {
    await answer(q);

    if (data === "menu_main") { inputState = null; return showMain(chatId, messageId); }
    if (data === "menu_campaigns") return showCampaignMenu(chatId, messageId);
    if (data === "menu_website_blog") return showWebsiteBlogMenu(chatId, messageId);
    if (data === "menu_website_shop") return showWebsiteShopMenu(chatId, messageId);

    if (data === "menu_website_reviews") return showWebsiteReviewsMenu(chatId, messageId);
    if (data === "website_reviews_list") return showWebsiteReviewsList(chatId, messageId);
    if (data.startsWith("website_review_view:")) return showWebsiteReviewDetails(chatId, messageId, data.slice("website_review_view:".length));
    if (data.startsWith("website_review_approve:")) {
      const id = data.slice("website_review_approve:".length);
      await websiteReviews.setStatus(id, "approved");
      return showWebsiteReviewDetails(chatId, messageId, id);
    }
    if (data.startsWith("website_review_hide:")) {
      const id = data.slice("website_review_hide:".length);
      await websiteReviews.setStatus(id, "hidden");
      return showWebsiteReviewDetails(chatId, messageId, id);
    }
    if (data.startsWith("website_review_reply:")) {
      const id = data.slice("website_review_reply:".length);
      const reviews = await websiteReviews.listReviews();
      const r = reviews.find(x => String(x.id) === String(id));
      if (!r) throw new Error("Review not found.");
      inputState = { chatId, type: "website_review_reply", step: "reply", id, existing: r.reply || "" };
      return safeEdit(chatId, messageId, `💬 Reply to ${r.name || "Anonymous"}\n\nCurrent reply:\n${r.reply || "(none)"}\n\nSend the new reply as your next message.`, { inline_keyboard: [[btn("❌ Cancel", `website_review_view:${id}`)]] });
    }
    if (data.startsWith("website_review_delete_reply:")) {
      const id = data.slice("website_review_delete_reply:".length);
      await websiteReviews.deleteReply(id);
      return showWebsiteReviewDetails(chatId, messageId, id);
    }
    if (data.startsWith("website_review_delete:")) {
      const id = data.slice("website_review_delete:".length);
      const reviews = await websiteReviews.listReviews();
      const r = reviews.find(x => String(x.id) === String(id));
      if (!r) throw new Error("Review not found.");
      return safeEdit(chatId, messageId, `❌ Delete Review\n\n${r.name || "Anonymous"}\n\n${String(r.message || "").slice(0, 500)}\n\nAre you sure?`, { inline_keyboard: [[btn("❌ Yes, Delete", `website_review_delete_yes:${id}`)], [btn("⬅️ Keep It", `website_review_view:${id}`)]] });
    }
    if (data.startsWith("website_review_delete_yes:")) {
      await websiteReviews.deleteReview(data.slice("website_review_delete_yes:".length));
      return showWebsiteReviewsList(chatId, messageId);
    }

    
    if (data === "website_shop_list") return showWebsiteShopList(chatId, messageId);
    
    if (data === "website_shop_create") {
      return startWebsiteShopWizard(chatId, messageId, "create");
    }
    
    if (data === "website_shop_cancel") {
      inputState = null;
      return showWebsiteShopMenu(chatId, messageId);
    }
    
    if (data === "website_shop_keep_pdf") {
      if (
        !inputState ||
        inputState.chatId !== chatId ||
        !["website_shop_create", "website_shop_edit"].includes(inputState.type)
      ) {
        return showWebsiteShopMenu(chatId, messageId);
      }
    
      if (inputState.type === "website_shop_create") {
        return bot.sendMessage(chatId, "A new product requires a PDF. Please send the PDF.");
      }
    
      const s = inputState;
    
      const p = await websiteShop.saveProduct({
        slug: s.slug,
        title: s.title,
        desc: s.desc,
        priceNaira: s.priceNaira,
        file: s.file,
        active: true
      });
    
      inputState = null;
    
      return safeEdit(
        chatId,
        messageId,
        `✅ Product updated.\n\n${p.title}`,
        {
          inline_keyboard: [
            [btn("📋 View Products", "website_shop_list")],
            [btn("🛍️ Website Shop", "menu_website_shop"), btn("⭐ Website Reviews", "menu_website_reviews")],
            [btn("🏠 Main Menu", "menu_main")]
          ]
        }
      );
    }
    
    if (data.startsWith("website_shop_view:")) {
      return showWebsiteShopDetails(
        chatId,
        messageId,
        data.slice("website_shop_view:".length)
      );
    }
    
    if (data.startsWith("website_shop_edit:")) {
      const slug = data.slice("website_shop_edit:".length);
      const products = await websiteShop.listProducts();
      const p = products.find(x => x.slug === slug);
    
      if (!p) throw new Error("Shop product not found.");
    
      return startWebsiteShopWizard(chatId, messageId, "edit", p);
    }
    
    if (data.startsWith("website_shop_toggle:")) {
      const slug = data.slice("website_shop_toggle:".length);
    
      await websiteShop.toggleProduct(slug);
    
      return showWebsiteShopDetails(chatId, messageId, slug);
    }
    
    if (data.startsWith("website_shop_delete:")) {
      const slug = data.slice("website_shop_delete:".length);
      const products = await websiteShop.listProducts();
      const p = products.find(x => x.slug === slug);
    
      if (!p) throw new Error("Shop product not found.");
    
      return safeEdit(
        chatId,
        messageId,
        `🗑️ Delete Shop Product\n\n${p.title}\n\nAre you sure?`,
        {
          inline_keyboard: [
            [btn("🗑️ Yes, Delete", `website_shop_delete_yes:${slug}`)],
            [btn("⬅️ Keep It", `website_shop_view:${slug}`)]
          ]
        }
      );
    }
    
    if (data.startsWith("website_shop_delete_yes:")) {
      await websiteShop.deleteProduct(
        data.slice("website_shop_delete_yes:".length)
      );
    
      return showWebsiteShopList(chatId, messageId);
    }
    
    if (data === "website_blog_create") {
      return startWebsiteBlogWizard(chatId, messageId, "create");
    }
    if (data.startsWith("website_blog_edit:")) {
      const id = data.slice("website_blog_edit:".length);
      const posts = await websiteBlog.listPosts();
      const post = posts.find(x => String(x.id) === String(id));
      if (!post) throw new Error("Blog post not found.");
      return startWebsiteBlogWizard(chatId, messageId, "edit", post);
    }
    if (data === "website_blog_cancel") {
      inputState = null;
      return showWebsiteBlogMenu(chatId, messageId);
    }
    if (data === "website_blog_restart") {
      if (!inputState || inputState.chatId !== chatId) return showWebsiteBlogMenu(chatId, messageId);
      const mode = inputState.type === "website_blog_edit" ? "edit" : "create";
      if (mode === "edit") {
        const posts = await websiteBlog.listPosts();
        const post = posts.find(x => String(x.id) === String(inputState.id));
        if (!post) throw new Error("Blog post not found.");
        return startWebsiteBlogWizard(chatId, messageId, "edit", post);
      }
      return startWebsiteBlogWizard(chatId, messageId, "create");
    }
    if (data === "website_blog_save") {
      if (!inputState || inputState.chatId !== chatId) return showWebsiteBlogMenu(chatId, messageId);
      const s = inputState;
      if (!s.title || !s.content?.trim()) return bot.sendMessage(chatId, "Title and content are required.");
      await safeEdit(chatId, messageId, "⏳ Saving the post to the Jabari website GitHub repository...");
      const post = s.type === "website_blog_edit"
        ? await websiteBlog.updatePost(s.id, { title: s.title, content: s.content, image: s.image || "", video: s.video || "" })
        : await websiteBlog.createPost({ title: s.title, content: s.content, image: s.image || "", video: s.video || "" });
      inputState = null;
      return safeEdit(
        chatId,
        messageId,
        `✅ Website Blog ${s.type === "website_blog_edit" ? "post updated" : "post created"}.\n\n${post.title}\n\nThe same blog/posts.json used by your Jabari website has been updated.`,
        { inline_keyboard: [[btn("📋 View Posts", "website_blog_list")], [btn("🌐 Website Blog", "menu_website_blog")], [btn("🏠 Main Menu", "menu_main")]] }
      );
    }
    if (data === "website_blog_list") return showWebsiteBlogList(chatId, messageId);
    if (data.startsWith("website_blog_view:")) return showWebsiteBlogDetails(chatId, messageId, data.slice("website_blog_view:".length));
    if (data.startsWith("website_blog_delete:")) {
      const id = data.slice("website_blog_delete:".length);
      const posts = await websiteBlog.listPosts();
      const p = posts.find(x => String(x.id) === String(id));
      if (!p) throw new Error("Blog post not found.");
      return safeEdit(chatId, messageId, `🗑️ Delete Website Post\n\n${p.title}\n\nAre you sure?`, { inline_keyboard: [[btn("🗑️ Yes, Delete", `website_blog_delete_yes:${id}`)], [btn("⬅️ Keep It", `website_blog_view:${id}`)]] });
    }
    if (data.startsWith("website_blog_delete_yes:")) {
      await websiteBlog.deletePost(data.slice("website_blog_delete_yes:".length));
      return showWebsiteBlogList(chatId, messageId);
    }
    if (data === "menu_contacts") return showContactsMenu(chatId, messageId);
    if (data === "menu_status") return showStatus(chatId, messageId);
    if (data === "menu_promote") return showPromoteMenu(chatId, messageId);
    if (data === "menu_scanner") return showScannerMenu(chatId, messageId);
    if (data === "scanner_website") {
      inputState = { chatId, type: "scan_website", step: "url" };
      return safeEdit(chatId, messageId, "🌐 Scan Website\n\nSend the public website URL you want to scan.\n\nExample:\nhttps://example.com", { inline_keyboard: [[btn("❌ Cancel", "scanner_cancel")]] });
    }
    if (data === "scanner_results") return showScannerResults(chatId, messageId);
    if (data === "scanner_noop") return answer(q);
    if (data.startsWith("scanner_toggle:")) {
      const email = decodeURIComponent(data.slice("scanner_toggle:".length));
      if (!scanResults.includes(email)) return showScannerResults(chatId, messageId);
      if (scanSelected.has(email)) scanSelected.delete(email);
      else scanSelected.add(email);
      return showScannerResults(chatId, messageId);
    }
    if (data === "scanner_cancel") { inputState = null; return showScannerMenu(chatId, messageId); }
    if (data === "scanner_add_selected") {
      const selected = scanResults.filter(email => scanSelected.has(email));
      if (!selected.length) return safeEdit(chatId, messageId, "Please select at least one email first.", { inline_keyboard: [[btn("👀 View Results", "scanner_results")], [btn("🕵️ Scanner", "menu_scanner")]] });
      const added = await addScannedEmails(selected);
      return safeEdit(chatId, messageId, `✅ Selected scanner results added.\n\nNew contacts: ${added}\nAlready in contacts: ${selected.length - added}`, { inline_keyboard: [[btn("👥 Contacts", "menu_contacts")], [btn("🕵️ Scanner", "menu_scanner")]] });
    }
    if (data === "scanner_add_all") {
      if (!scanResults.length) return showScannerResults(chatId, messageId);
      const added = await addScannedEmails(scanResults);
      return safeEdit(chatId, messageId, `✅ Scanner results added.\n\nNew contacts: ${added}\nAlready in contacts: ${scanResults.length - added}`, { inline_keyboard: [[btn("👥 Contacts", "menu_contacts")], [btn("🕵️ Scanner", "menu_scanner")]] });
    }

    if (data === "campaign_create") {
      beginWizard(chatId, "campaign_create");
      await safeEdit(chatId, messageId, "📝 Create Campaign\n\nLet's create a new campaign.\n\nThe existing campaigns will remain saved.", { inline_keyboard: [[btn("❌ Cancel", "wizard_cancel")]] });
      return promptWizard(chatId);
    }
    if (data === "campaign_list") return showCampaignList(chatId, messageId);
    if (data.startsWith("campaign_view:")) return showCampaignDetails(chatId, messageId, Number(data.split(":")[1]));
    if (data.startsWith("campaign_active:")) {
      const id = Number(data.split(":")[1]);
      await setActiveCampaign(id);
      await safeEdit(chatId, messageId, "✅ Campaign is now active.\n\nThis campaign will be used for the next promotion.", { inline_keyboard: [[btn("📧 Promote", "menu_promote")], [btn("📋 Campaigns", "campaign_list")]] });
      return;
    }
    if (data.startsWith("campaign_edit:")) {
      const id = Number(data.split(":")[1]);
      const c = await getCampaign(id);
      beginWizard(chatId, "campaign_edit", c);
      await safeEdit(chatId, messageId, `✏️ Edit Campaign\n\nCurrent title: ${c.title}\n\nEnter the new campaign title.`, { inline_keyboard: [[btn("❌ Cancel", "wizard_cancel")]] });
      return promptWizard(chatId);
    }
    if (data.startsWith("campaign_delete:")) {
      const id = Number(data.split(":")[1]);
      const c = await getCampaign(id);
      return safeEdit(chatId, messageId, `🗑️ Delete Campaign\n\nAre you sure you want to delete:\n\n${c.title}\n\nThis cannot be undone.`, { inline_keyboard: [[btn("🗑️ Yes, Delete", `campaign_delete_yes:${id}`)], [btn("⬅️ Keep It", `campaign_view:${id}`)]] });
    }
    if (data.startsWith("campaign_delete_yes:")) {
      const id = Number(data.split(":")[1]);
      await deleteCampaignById(id);
      return showCampaignList(chatId, messageId);
    }

    if (data === "wizard_cancel") {
      inputState = null;
      await safeEdit(chatId, messageId, "❌ Campaign input cancelled.", { inline_keyboard: [[btn("🏠 Main Menu", "menu_main")]] });
      return;
    }
    if (data === "wizard_restart") {
      const type = inputState?.type || "campaign_create";
      inputState = null;
      beginWizard(chatId, type);
      await safeEdit(chatId, messageId, "Starting over…", { inline_keyboard: [[btn("❌ Cancel", "wizard_cancel")]] });
      return promptWizard(chatId);
    }
    if (data === "wizard_save") {
      if (!inputState || inputState.chatId !== chatId || inputState.step !== "preview") return;
      const s = inputState;
      const c = s.id ? await updateCampaign(s.id, s.title, s.description, s.url) : await createCampaign(s.title, s.description, s.url);
      inputState = null;
      return safeEdit(chatId, messageId, `✅ Campaign saved.\n\n${c.title}\n\nIt is currently ${c.is_active ? "🟢 active" : "⚪ saved"}.\n\nYou can create another campaign without deleting this one.`, { inline_keyboard: [[btn("🚀 Make Active", `campaign_active:${c.id}`)], [btn("📋 View Campaigns", "campaign_list")], [btn("🏠 Main Menu", "menu_main")]] });
    }

    if (data === "contact_add") {
      inputState = { chatId, type: "contact_add", step: "name", name: "" };
      await safeEdit(chatId, messageId, "➕ Add Contact\n\nEnter the contact's name.", { inline_keyboard: [[btn("❌ Cancel", "contact_cancel")]] });
      return bot.sendMessage(chatId, "Name:", { reply_markup: { force_reply: true } });
    }
    if (data === "contact_cancel") { inputState = null; return showContactsMenu(chatId, messageId); }
    if (data === "contact_list") return showContactList(chatId, messageId);
    if (data.startsWith("contact_view:")) return showContactDetails(chatId, messageId, Number(data.split(":")[1]));
    if (data.startsWith("contact_delete:")) {
      const id = Number(data.split(":")[1]);
      const c = contacts.find(x => Number(x.id) === id);
      return safeEdit(chatId, messageId, `🗑️ Delete Contact\n\n${c?.name || "No name"}\n${c?.email || ""}\n\nAre you sure?`, { inline_keyboard: [[btn("🗑️ Yes, Delete", `contact_delete_yes:${id}`)], [btn("⬅️ Keep It", `contact_view:${id}`)]] });
    }
    if (data.startsWith("contact_delete_yes:")) {
      await removeContact(Number(data.split(":")[1]));
      return showContactList(chatId, messageId);
    }

    if (data === "promote_confirm") {
      const active = await getActiveCampaign();
      const list = await loadContacts();
      if (!active) return showPromoteMenu(chatId, messageId);
      return safeEdit(chatId, messageId, `⚠️ Confirm Promotion\n\nCampaign:\n${active.title}\n\nRecipients: ${Math.min(list.length, PROMOTION_LIMIT)}\n\nStart sending now?`, { inline_keyboard: [[btn("🚀 Yes, Start", "promote_start")], [btn("⬅️ Cancel", "menu_promote")]] });
    }
    if (data === "promote_start") {
      await safeEdit(chatId, messageId, "📧 Promotion started…\n\nPlease wait while the emails are processed.");
      const out = await finishPromotion(chatId);
      const sent = out.filter(x => x.status === "sent").length;
      const failed = out.filter(x => x.status === "failed").length;
      return bot.sendMessage(chatId, `✅ Promotion complete.\n\nSent: ${sent}\nFailed: ${failed}\nProcessed: ${out.length}`, { reply_markup: { inline_keyboard: [[btn("📊 Status", "menu_status")], [btn("🏠 Main Menu", "menu_main")]] } });
    }

    if (data === "menu_testemail") {
      inputState = { chatId, type: "test_email", step: "email" };
      await safeEdit(chatId, messageId, "🧪 Test Email\n\nEnter the email address where you want the test sent.", { inline_keyboard: [[btn("❌ Cancel", "testemail_cancel")]] });
      return bot.sendMessage(chatId, "Email address:", { reply_markup: { force_reply: true } });
    }
    if (data === "testemail_cancel") { inputState = null; return showMain(chatId, messageId); }
  } catch (e) {
    console.error("Callback error:", e.message);
    await bot.sendMessage(chatId, `Action failed.\n\n${e.message}`);
  }
});

bot.on("document", async msg => {
  if (!isOwner(msg) || !inputState || inputState.chatId !== msg.chat.id) {
    return;
  }

  const s = inputState;

  if (
    !["website_shop_create", "website_shop_edit"].includes(s.type) ||
    s.step !== "pdf"
  ) {
    return;
  }

  const doc = msg.document;

  if (!doc) return;

  if (
    String(doc.file_name || "").toLowerCase().slice(-4) !== ".pdf" ||
    String(doc.mime_type || "").toLowerCase() !== "application/pdf"
  ) {
    return bot.sendMessage(msg.chat.id, "❌ Please send a PDF file.");
  }

  try {
    await bot.sendMessage(
      msg.chat.id,
      "⏳ Uploading the PDF to the Jabari website…"
    );

    const fileUrl = await getTelegramFileLinkWithRetry(doc.file_id);
    const buffer = await downloadBinary(fileUrl);

    s.file = await websiteShop.uploadPdf(
      buffer,
      doc.file_name || "product.pdf"
    );

    const p = await websiteShop.saveProduct({
      slug: s.slug,
      title: s.title,
      desc: s.desc,
      priceNaira: s.priceNaira,
      file: s.file,
      active: true
    });

    inputState = null;

    return bot.sendMessage(
      msg.chat.id,
      `✅ Shop product ${s.type === "website_shop_edit" ? "updated" : "created"}.\n\n` +
      `${p.title}\n₦${Number(p.priceNaira).toLocaleString()}\n\n` +
      `The same shop/products.json used by the website has been updated.`,
      {
        reply_markup: {
          inline_keyboard: [
            [btn("📋 View Products", "website_shop_list")],
            [btn("🛍️ Website Shop", "menu_website_shop"), btn("⭐ Website Reviews", "menu_website_reviews")],
            [btn("🏠 Main Menu", "menu_main")]
          ]
        }
      }
    );
  } catch (e) {
    console.error("Website shop PDF upload error:", e.message);

    return bot.sendMessage(
      msg.chat.id,
      `❌ PDF upload failed.\n\n${e.message}`
    );
  }
});

// Test-email text continuation.
const originalMessageHandler = null;
bot.on("message", async msg => {
  if (!isOwner(msg) || !msg.text || msg.text.startsWith("/") || !inputState || inputState.chatId !== msg.chat.id) return;
  if (inputState.type !== "test_email") return;
  const email = msg.text.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bot.sendMessage(msg.chat.id, "Please enter a valid email address.");
  try {
    await sendEmail(email, "Jabari Promoter — Test", "Hello,\n\nThis is a test email from Jabari Promoter.\n\nIf you received this message, Gmail sending is working correctly.\n\nJabari Promoter");
    inputState = null;
    await bot.sendMessage(msg.chat.id, `✅ Test email sent to:\n\n${email}`, { reply_markup: { inline_keyboard: [[btn("🏠 Main Menu", "menu_main")]] } });
  } catch (e) {
    console.error("TEST EMAIL FAILED:", {
      message: e?.message || "Unknown error",
      code: e?.code || null,
      status: e?.response?.status || null,
      response: e?.response?.data || null,
      errors: e?.errors || null
    });
    await bot.sendMessage(msg.chat.id, `❌ Test email failed.\n\n${e.message}`);
  }
});

async function handleOAuthCallback(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) { res.writeHead(400); return res.end("Missing authorization code."); }
    if (oauthState && state !== oauthState) { res.writeHead(400); return res.end("Invalid OAuth state."); }
    const auth = createOAuthClient();
    const { tokens } = await auth.getToken(code);
    console.log("Google OAuth completed.", Boolean(tokens.refresh_token));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Gmail connected successfully.</h2><p>You can return to Telegram.</p>");
  } catch (e) {
    console.error("OAuth callback error:", e.message);
    res.writeHead(500); res.end("Google authorization failed.");
  }
}

async function handleTelegramUpdate(req, res) {
  if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
    res.writeHead(403); return res.end("Forbidden");
  }
  let body = "";
  req.on("data", chunk => { body += chunk.toString(); });
  req.on("end", async () => {
    try { await bot.processUpdate(JSON.parse(body)); res.writeHead(200); res.end("OK"); }
    catch (e) { console.error("Telegram update error:", e.message); res.writeHead(500); res.end("Update error"); }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === webhookPath) return handleTelegramUpdate(req, res);
  if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("Jabari Promoter is running."); }
  if (req.method === "GET" && req.url.startsWith("/oauth2callback")) return handleOAuthCallback(req, res);
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, async () => {
  console.log(`Jabari Promoter is running on port ${PORT}`);
  try {
    const me = await bot.getMe();
    console.log(`Telegram authenticated as @${me.username}`);
    await bot.setWebHook(webhookUrl, { secret_token: webhookSecret, drop_pending_updates: false });
    console.log(`Telegram webhook registered: ${webhookUrl}`);
  } catch (e) { console.error("Telegram webhook setup failed:", e.message); }

  try {
    await loadContacts();
    const { error } = await supabase.from("promoter_campaigns").select("id").limit(1);
    if (error) console.error("Supabase campaign table check failed:", error.message);
    else console.log(`Supabase connected successfully. Loaded ${contacts.length} contacts.`);
    const active = await getActiveCampaign();
    console.log(`Active campaign: ${active?.title || "None"}`);
  } catch (e) {
    console.error("Startup data initialization failed:", e.message);
  }
});


process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));
process.on("uncaughtException", e => console.error("Uncaught exception:", e));
console.log("Jabari Promoter code loaded successfully.");
