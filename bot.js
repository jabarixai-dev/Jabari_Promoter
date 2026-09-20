require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const dns = require("dns").promises;
const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerId = String(process.env.BOT_OWNER_ID || "");
const mode = process.env.MODE || "dry-run";
const PORT = Number(process.env.PORT || 10000);
const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://jabari-promoter.onrender.com";

if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase environment variables");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
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
let scanSelected = new Set();
let scanRunning = false;
let mediaAutomationRunning = false;
let mediaWorkerSecret = "";

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
  const maxPages = 5;

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift();
    queued.delete(url);
    if (visited.has(url)) continue;
    visited.add(url);

    const pageNumber = pages.length + 1;
    if (onProgress) await onProgress(`🔎 Scanning page ${pageNumber}/${maxPages}…\n\n${url}`);

    try {
      const page = await fetchPublicPage(url);
      pages.push(page.url);

      const foundOnPage = extractEmails(page.html);
      for (const email of foundOnPage) emails.add(email);

      if (onProgress) {
        const foundText = foundOnPage.length ? `\n📧 Found ${foundOnPage.length} email${foundOnPage.length === 1 ? "" : "s"} on this page.` : "\nNo email found on this page.";
        await onProgress(`🔎 Scanned page ${pages.length}/${maxPages}\n\n${page.url}${foundText}`);
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
      console.log(`Scanner skipped ${url}: ${e.message}`);
      if (onProgress) await onProgress(`⚠️ Could not scan page ${pageNumber}/${maxPages}\n\n${url}\n\n${e.message}`);
    }
  }

  return { emails: [...emails].sort(), pages };
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


// ----- Jabari Media / Autopilot -----
async function ensureMediaWorkerSecret() {
  const { data, error } = await supabase.from("media_worker_config").select("worker_secret").eq("id", 1).maybeSingle();
  if (error) throw error;
  if (data?.worker_secret) { mediaWorkerSecret = data.worker_secret; return mediaWorkerSecret; }
  const secret = crypto.randomBytes(48).toString("hex");
  const { data: saved, error: saveError } = await supabase
    .from("media_worker_config")
    .upsert({ id: 1, worker_secret: secret, updated_at: new Date().toISOString() })
    .select("worker_secret")
    .single();
  if (saveError) throw saveError;
  mediaWorkerSecret = saved.worker_secret;
  return mediaWorkerSecret;
}

const MEDIA_TIMEZONE = "Africa/Lagos";

function nextAutopilotRunDate(frequency) {
  if (!frequency || frequency === "manual") return null;
  const hours = frequency === "twice_daily" ? 12 : frequency === "weekly" ? 168 : 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function formatAutopilotDate(value) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-NG", {
    timeZone: MEDIA_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(new Date(value));
}

async function getMediaAutopilot() {
  const { data, error } = await supabase.from("media_autopilot").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}

async function setMediaAutopilot(patch) {
  const { data, error } = await supabase.from("media_autopilot").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1).select("*").single();
  if (error) throw error;
  return data;
}

async function getNextMediaTopic() {
  const { data, error } = await supabase.from("media_topics")
    .select("id,topic,category_id,priority,status,created_at,media_categories(name)")
    .eq("status", "queued")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

function mediaSlugify(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || `article-${Date.now()}`;
}

async function mediaResearch(topic) {
  const q = encodeURIComponent(`${topic} 2026`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, { headers: { "User-Agent": "JabariMedia/1.0" } });
  if (!response.ok) throw new Error(`Research search failed with HTTP ${response.status}.`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 8).map(m => m[1]);
  const clean = value => String(value || "").replace(/<!\[CDATA\[([\\s\\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();
  return items.map(item => ({
    title: clean(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]),
    url: clean(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]),
    published_at: clean(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]),
    publisher: clean(item.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1])
  })).filter(x => x.title && x.url);
}

async function generateMediaArticle(topicRow, sources) {
  if (!geminiApiKey) throw new Error("GEMINI_API_KEY is missing on Render.");
  const sourceText = sources.map((s,i) => `${i+1}. ${s.title}\nPublisher: ${s.publisher || "Unknown"}\nURL: ${s.url}\nPublished: ${s.published_at || "Unknown"}`).join("\n\n");
  const prompt = `You are the senior writer for Jabari Media, a digital publication covering News, AI, Promotion, Crypto and Money.\n\nWrite a source-backed article about this topic:\n${topicRow.topic}\n\nResearch supplied by Jabari Media:\n${sourceText || "No usable sources were found."}\n\nRules:\n- Do not invent facts, quotes, statistics, dates or events.\n- If a claim cannot be supported by the supplied sources, phrase it as analysis or omit it.\n- Use only the supplied source URLs for factual citations.\n- Return clean HTML body content using p, h2, ul, li, strong and blockquote where appropriate.\n- Put citation markers such as [1], [2] immediately after claims.\n- Finish the body with <hr><h2>Sources</h2><ol> and include ONLY sources actually cited. Each source must be a direct URL from the supplied list, with target="_blank" rel="noopener noreferrer".\n- Keep the article readable and journalistic, not a generic AI essay.\n- Do not mention that you are an AI.\n\nReturn JSON with title, excerpt, content, seo_title, meta_description, tags.`;

  let lastError = null;
  for (const model of geminiFallbackModels) {
    for (const delay of [0, 3000, 7000]) {
      if (delay) await new Promise(r => setTimeout(r, delay));
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: {
            maxOutputTokens: 6500, responseMimeType: "application/json",
            responseSchema: { type: "OBJECT", properties: {
              title:{type:"STRING"}, excerpt:{type:"STRING"}, content:{type:"STRING"}, seo_title:{type:"STRING"}, meta_description:{type:"STRING"}, tags:{type:"ARRAY",items:{type:"STRING"}}
            }, required:["title","excerpt","content","seo_title","meta_description","tags"]
          }}})
        });
        const data = await response.json();
        if (!response.ok) {
          const err = new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
          err.status = response.status;
          throw err;
        }
        const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("").trim();
        if (!raw) throw new Error("Gemini returned an empty response.");
        return JSON.parse(raw);
      } catch (e) {
        lastError = e;
        console.error(`Gemini media generation failed on ${model}:`, e.message);
        const msg = String(e?.message || "").toLowerCase();
        const status = Number(e?.status || 0);
        const transient = status === 429 || status === 500 || status === 503 || /high demand|temporarily|overloaded|rate limit|too many requests|unavailable/.test(msg);
        if (!transient) throw e;
        break;
      }
    }
  }
  throw lastError || new Error("Article generation failed.");
}

function isTransientGeminiError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const status = Number(error?.status || 0);
  return status === 429 || status === 500 || status === 503 || /high demand|temporarily|overloaded|rate limit|too many requests|service unavailable|unavailable/.test(msg);
}

async function saveMediaSources(articleId, sources, content) {
  const used = [];
  const nums = [...String(content || "").matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
  const unique = [...new Set(nums)].filter(n => n >= 1 && n <= sources.length);
  for (const n of unique) {
    const s = sources[n - 1];
    used.push(s);
    await supabase.from("media_sources").insert({ article_id: articleId, title: s.title, url: s.url, publisher: s.publisher || null, published_at: s.published_at ? new Date(s.published_at).toISOString() : null });
  }
  return used;
}

async function createMediaDraftFromTopic(topicOverride = null) {
  const topic = topicOverride || await getNextMediaTopic();
  if (!topic) return { topic: null, article: null };
  await supabase.from("media_topics").update({ status: "processing" }).eq("id", topic.id);
  try {
    const sources = await mediaResearch(topic.topic);
    const article = await generateMediaArticle(topic, sources);
    let slug = mediaSlugify(article.title);
    const { data: existing } = await supabase.from("media_articles").select("id").eq("slug", slug).maybeSingle();
    if (existing) slug = `${slug}-${Date.now()}`;
    const author = await supabase.from("media_authors").select("id").eq("slug", "jabari").maybeSingle();
    const { data: saved, error } = await supabase.from("media_articles").insert({
      title: article.title, slug, excerpt: article.excerpt || "", content: article.content || "", category_id: topic.category_id || null,
      author_id: author?.data?.id || null, status: "draft", article_type: "article", seo_title: article.seo_title || article.title,
      meta_description: article.meta_description || article.excerpt || ""
    }).select("*").single();
    if (error) throw error;
    await saveMediaSources(saved.id, sources, article.content || "");
    await supabase.from("media_topics").update({ status: "published", used_at: new Date().toISOString() }).eq("id", topic.id);
    await supabase.from("media_automation_logs").insert({ action:"generate_article", status:"success", article_id:saved.id, topic_id:topic.id, message:`Draft created from topic: ${topic.topic}` });
    return { topic, article: saved, sources };
  } catch (e) {
    const nextStatus = isTransientGeminiError(e) ? "queued" : "failed";
    await supabase.from("media_topics").update({ status: nextStatus }).eq("id", topic.id);
    await supabase.from("media_automation_logs").insert({ action:"generate_article", status: nextStatus === "queued" ? "retryable" : "failed", topic_id:topic.id, message:e.message });
    throw e;
  }
}

async function publishMediaArticle(id) {
  const { data, error } = await supabase.from("media_articles").update({ status:"published", published_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id", id).in("status", ["draft","review"]).select("*").single();
  if (error) throw error;
  await supabase.from("media_automation_logs").insert({ action:"publish_article", status:"success", article_id:id, message:`Published: ${data.title}` });
  return data;
}

async function getMediaDrafts() {
  const { data, error } = await supabase.from("media_articles").select("id,title,status,created_at,media_categories(name)").in("status", ["draft","review"]).order("created_at", { ascending:false }).limit(10);
  if (error) throw error;
  return data || [];
}

async function prepareMediaPromotion(article) {
  const base = process.env.JABARI_MEDIA_BASE_URL || "https://jabarip.netlify.app";
  const articleUrl = `${base}/article.html?slug=${encodeURIComponent(article.slug)}`;
  const active = await getActiveCampaign();
  if (active) {
    await updateCampaign(active.id, article.title, article.excerpt || "Read the latest article from Jabari Media.", articleUrl);
  } else {
    const created = await createCampaign(article.title, article.excerpt || "Read the latest article from Jabari Media.", articleUrl);
    await setActiveCampaign(created.id);
  }
  return articleUrl;
}

async function runMediaAutomation(chatId, source = "manual") {
  if (mediaAutomationRunning) return { skipped: true, message: "A Jabari Media automation run is already in progress." };
  const auto = await getMediaAutopilot();
  if (source === "auto" && !auto.enabled) return { skipped: true, message: "Autopilot is OFF." };
  mediaAutomationRunning = true;
  try {
    const result = await createMediaDraftFromTopic();
    if (!result.topic) return { skipped:false, message:"No queued topic is waiting." };

    // A manual Run Now means: execute the complete current pipeline.
    // Review mode is the deliberate exception: generate a draft but do not publish.
    if (auto.mode === "full_auto") {
      const published = await publishMediaArticle(result.article.id);
      const articleUrl = await prepareMediaPromotion(published);
      let promotion = { sent:0, failed:0, processed:0 };
      try {
        const out = await finishPromotion(chatId);
        promotion = { sent:out.filter(x=>x.status==="sent").length, failed:out.filter(x=>x.status==="failed").length, processed:out.length };
      } catch (e) {
        console.error("Promotion failed:", e.message);
      }
      return { skipped:false, message:`Published and promoted: ${published.title}`, article:published, topic:result.topic, articleUrl, promotion };
    }

    return { skipped:false, message:`Draft created: ${result.article.title}`, article:result.article, topic:result.topic };
  } finally { mediaAutomationRunning = false; }
}

async function showMediaMenu(chatId, messageId) {
  const auto = await getMediaAutopilot();
  const queued = await getNextMediaTopic();
  const drafts = await getMediaDrafts();
  const text = `🤖 Jabari Media\n\nAutopilot: ${auto.enabled ? "🟢 ON" : "🔴 OFF"}\nMode: ${auto.mode}\nSchedule: ${auto.publishing_frequency}\nQueued topics: ${queued ? "1+" : "0"}\nDrafts waiting: ${drafts.length}`;
  const rows = [
    [btn("➕ Add Topic", "media_add_topic"), btn("📚 Topics", "media_topics")],
    [btn("✍️ Generate Next", "media_generate"), btn("📝 Drafts", "media_drafts")],
    [btn("⚙️ Autopilot", "media_autopilot")],
    [btn("🏠 Main Menu", "menu_main")]
  ];
  if (messageId) return safeEdit(chatId,messageId,text,{inline_keyboard:rows});
  return bot.sendMessage(chatId,text,{reply_markup:{inline_keyboard:rows}});
}

async function showMediaAutopilot(chatId, messageId) {
  const a = await getMediaAutopilot();
  const text = `⚙️ Jabari Autopilot\n\nStatus: ${a.enabled ? "🟢 ON" : "🔴 OFF"}\nMode: ${a.mode}\nFrequency: ${a.publishing_frequency}\nTimezone: WAT (Africa/Lagos)\nNext run: ${formatAutopilotDate(a.next_run_at)}\nLast run: ${a.last_run_at ? formatAutopilotDate(a.last_run_at) : "Never"}`;
  const rows = [[btn(a.enabled ? "🔴 Turn OFF" : "🟢 Turn ON", "media_toggle_auto")],[btn("▶️ Run Now", "media_run_now")],[btn("📝 Mode: " + a.mode, "media_mode")],[btn("⏱ Frequency: " + a.publishing_frequency, "media_frequency")],[btn("⬅️ Media", "menu_media")]];
  if (messageId) return safeEdit(chatId,messageId,text,{inline_keyboard:rows});
  return bot.sendMessage(chatId,text,{reply_markup:{inline_keyboard:rows}});
}

async function showMediaDrafts(chatId,messageId) {
  const drafts = await getMediaDrafts();
  if (!drafts.length) return safeEdit(chatId,messageId,"📝 No drafts waiting.",{inline_keyboard:[[btn("⬅️ Media","menu_media")]]});
  const rows = drafts.map(d => [btn(`📝 ${d.title}`.slice(0,55),`media_draft:${d.id}`)]);
  rows.push([btn("⬅️ Media","menu_media")]);
  const text = "📝 Drafts\n\nTap a draft to publish it.";
  if (messageId) return safeEdit(chatId,messageId,text,{inline_keyboard:rows});
  return bot.sendMessage(chatId,text,{reply_markup:{inline_keyboard:rows}});
}

function mainMenuText() {
  return "🚀 Jabari Promoter\n\nChoose what you want to do:";
}

function mainMenu() {
  return menu([
    [btn("🤖 Jabari Media", "menu_media"), btn("📝 Campaigns", "menu_campaigns")],
    [btn("👥 Contacts", "menu_contacts"), btn("📧 Promote", "menu_promote")],
    [btn("🕵️ Email Scanner", "menu_scanner"), btn("📊 Status", "menu_status")],
    [btn("🧪 Test Email", "menu_testemail")]
  ]);
}

async function showMain(chatId, messageId) {
  if (messageId) return safeEdit(chatId, messageId, mainMenuText(), mainMenu().reply_markup);
  return bot.sendMessage(chatId, mainMenuText(), mainMenu());
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
  return `🕵️ Scanner Results\n\nFound: ${scanResults.length}\nPages scanned: ${scanPages.length}\nSelected: ${selectedCount}\n\nTap an email to select/deselect it.`;
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
bot.onText(/^\/media$/, async msg => { if (isOwner(msg)) await showMediaMenu(msg.chat.id); else await deny(msg.chat.id); });
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

    if (s.type === "media_topic") {
      if (!msg.text.trim()) return bot.sendMessage(msg.chat.id,"Please send a topic.");
      const { error } = await supabase.from("media_topics").insert({ topic: msg.text.trim(), status:"queued" });
      if (error) throw error;
      inputState=null;
      await bot.sendMessage(msg.chat.id,`✅ Topic added to Jabari Media.\n\n${msg.text.trim()}`,{reply_markup:{inline_keyboard:[[btn("✍️ Generate Next","media_generate")],[btn("🤖 Media","menu_media")]]}});
      return;
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
    if (data === "menu_contacts") return showContactsMenu(chatId, messageId);
    if (data === "menu_status") return showStatus(chatId, messageId);
    if (data === "menu_promote") return showPromoteMenu(chatId, messageId);
    if (data === "menu_scanner") return showScannerMenu(chatId, messageId);
    if (data === "menu_media") return showMediaMenu(chatId, messageId);
    if (data === "media_autopilot") return showMediaAutopilot(chatId, messageId);
    if (data === "media_toggle_auto") {
      const a = await getMediaAutopilot();
      const next = !a.enabled;
      await setMediaAutopilot({ enabled: next, next_run_at: next ? nextAutopilotRunDate(a.publishing_frequency)?.toISOString() : null });
      return showMediaAutopilot(chatId, messageId);
    }
    if (data === "media_mode") {
      const a = await getMediaAutopilot();
      const next = a.mode === "review" ? "full_auto" : "review";
      await setMediaAutopilot({ mode: next });
      return showMediaAutopilot(chatId, messageId);
    }
    if (data === "media_frequency") {
      const a = await getMediaAutopilot();
      const order = ["manual","daily","twice_daily","weekly"];
      const next = order[(order.indexOf(a.publishing_frequency) + 1) % order.length];
      await setMediaAutopilot({ publishing_frequency: next, next_run_at: a.enabled && next !== "manual" ? nextAutopilotRunDate(next)?.toISOString() : null });
      return showMediaAutopilot(chatId, messageId);
    }
    if (data === "media_run_now") {
      await safeEdit(chatId,messageId,"▶️ Running Jabari Media now…\n\nResearching the next queued topic and generating a draft.");
      const r = await runMediaAutomation(chatId,"manual");
      const detail = r.promotion ? `

📧 Promotion: ${r.promotion.sent} sent, ${r.promotion.failed} failed` : "";
      return bot.sendMessage(chatId, r.article ? `✅ ${r.message}${detail}` : `ℹ️ ${r.message}`, {reply_markup:{inline_keyboard:[[btn("📝 Drafts","media_drafts")],[btn("🤖 Media","menu_media")]]}});
    }
    if (data === "media_generate" || data === "media_generate_retry") {
      await safeEdit(chatId,messageId,"✍️ Generating the next article…\n\nJabari will research the topic first.\n\nIf Gemini is temporarily busy, Jabari will retry automatically and can offer another retry button.");
      try {
        const r = await runMediaAutomation(chatId,"manual");
        return bot.sendMessage(chatId, r.article ? `✅ Draft created.

${r.article.title}

Status: Draft` : `ℹ️ ${r.message}`, {reply_markup:{inline_keyboard:[[btn("📝 Drafts","media_drafts")],[btn("🤖 Media","menu_media")]]}});
      } catch (e) {
        console.error("MEDIA GENERATION FAILED:", e.message);
        const retryable = isTransientGeminiError(e);
        return bot.sendMessage(chatId, `❌ Article generation failed.\n\n${e.message}${retryable ? "\n\nGemini is temporarily under load. Your topic has been kept in the queue." : ""}`, {reply_markup:{inline_keyboard:[...(retryable ? [[btn("🔄 Retry", "media_generate_retry")]] : []),[btn("🤖 Media","menu_media")]]}});
      }
    }
    if (data === "media_drafts") return showMediaDrafts(chatId,messageId);
    if (data.startsWith("media_draft:")) {
      const id = Number(data.split(":")[1]);
      const { data: d, error } = await supabase.from("media_articles").select("id,title,excerpt,status").eq("id",id).single();
      if (error) throw error;
      return safeEdit(chatId,messageId,`📝 Draft

${d.title}

${d.excerpt || "No excerpt"}

Status: ${d.status}`,{inline_keyboard:[[btn("🚀 Publish","media_publish:"+id)],[btn("🗑️ Delete","media_delete:"+id)],[btn("⬅️ Drafts","media_drafts")]]});
    }
    if (data.startsWith("media_publish:")) {
      const id = Number(data.split(":")[1]);
      const d = await publishMediaArticle(id);
      return safeEdit(chatId,messageId,`🚀 Published

${d.title}

The article is now marked published in Jabari Media.`,{inline_keyboard:[[btn("📢 Promote","media_promote:"+id)],[btn("📝 Drafts","media_drafts")],[btn("🤖 Media","menu_media")]]});
    }
    if (data.startsWith("media_promote:")) {
      const id = Number(data.split(":")[1]);
      const { data: d, error } = await supabase.from("media_articles").select("id,title,excerpt,slug").eq("id",id).eq("status","published").single();
      if (error) throw error;
      await prepareMediaPromotion(d);
      return showPromoteMenu(chatId,messageId);
    }
    if (data === "media_add_topic") {
      inputState = { chatId, type:"media_topic", step:"topic" };
      return safeEdit(chatId,messageId,`➕ Add Topic

Send the topic you want Jabari Media to write about.`, {inline_keyboard:[[btn("❌ Cancel","media_topic_cancel")]]});
    }
    if (data === "media_topic_cancel") { inputState=null; return showMediaMenu(chatId,messageId); }
    if (data === "media_topics") {
      const { data: topics, error } = await supabase.from("media_topics").select("id,topic,status").order("created_at",{ascending:false}).limit(10);
      if (error) throw error;
      const rows=(topics||[]).map(t=>[btn(`${t.status==='queued'?'🟡':'⚪'} ${t.topic}`.slice(0,55),`media_topic_view:${t.id}`)]);
      rows.push([btn("➕ Add Topic","media_add_topic"),btn("⬅️ Media","menu_media")]);
      return safeEdit(chatId,messageId,`📚 Topics

${topics?.length || 0} recent topics.`,{inline_keyboard:rows});
    }
    if (data.startsWith("media_topic_view:")) {
      const id=Number(data.split(":")[1]);
      const {data:t,error}=await supabase.from("media_topics").select("*").eq("id",id).single();
      if(error) throw error;
      return safeEdit(chatId,messageId,`📚 Topic

${t.topic}

Status: ${t.status}`,{inline_keyboard:[[btn("✍️ Generate","media_generate_topic:"+id)],[btn("🗑️ Delete","media_topic_delete:"+id)],[btn("⬅️ Topics","media_topics")]]});
    }
    if (data.startsWith("media_generate_topic:") || data.startsWith("media_generate_topic_retry:")) {
      const retryTopic = data.startsWith("media_generate_topic_retry:");
      const id=Number(data.split(":")[1]);
      const {data:t,error}=await supabase.from("media_topics").select("id,topic,category_id,status").eq("id",id).single();
      if(error) throw error;
      if(t.status!=="queued") return safeEdit(chatId,messageId,`This topic is not queued.\n\nStatus: ${t.status}`,{inline_keyboard:[[btn("⬅️ Topics","media_topics")]]});
      await safeEdit(chatId,messageId,`✍️ Generating…\n\nResearching the selected topic first.`);
      try {
        const result=await createMediaDraftFromTopic(t);
        return bot.sendMessage(chatId,`✅ Draft created.\n\n${result.article.title}\n\nStatus: Draft`,{reply_markup:{inline_keyboard:[[btn("📝 Drafts","media_drafts")],[btn("🤖 Media","menu_media")]]}});
      } catch (e) {
        const retryable = isTransientGeminiError(e);
        return bot.sendMessage(chatId,`❌ Article generation failed.\n\n${e.message}${retryable ? "\n\nYour topic has been kept in the queue." : ""}`,{reply_markup:{inline_keyboard:[...(retryable ? [[btn("🔄 Retry",`media_generate_topic_retry:${id}`)]] : []),[btn("⬅️ Topics","media_topics")]]}});
      }
    }
    if (data.startsWith("media_topic_delete:")) {
      const id=Number(data.split(":")[1]);
      await supabase.from("media_topics").delete().eq("id",id);
      return showMediaMenu(chatId,messageId);
    }
    if (data.startsWith("media_delete:")) {
      const id=Number(data.split(":")[1]);
      const {data:d,error}=await supabase.from("media_articles").select("id,title,status").eq("id",id).single();
      if(error) throw error;
      if(d.status==="published") throw new Error("Published articles cannot be deleted from Telegram.");
      await supabase.from("media_articles").delete().eq("id",id);
      return showMediaDrafts(chatId,messageId);
    }

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

async function handleAutomationWorker(req, res) {
  const provided = req.headers["x-jabari-worker-secret"] || "";
  if (!mediaWorkerSecret || provided !== mediaWorkerSecret) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok:false, error:"Forbidden" }));
  }
  try {
    const autoBefore = await getMediaAutopilot();
    if (!autoBefore.enabled || autoBefore.publishing_frequency === "manual") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok:true, skipped:true, message:"Autopilot is disabled or manual." }));
    }
    const result = await runMediaAutomation(null, "auto");
    const auto = await getMediaAutopilot();
    if (result.article && auto.enabled && auto.publishing_frequency !== "manual") {
      const hours = auto.publishing_frequency === "twice_daily" ? 12 : auto.publishing_frequency === "weekly" ? 168 : 24;
      await setMediaAutopilot({ last_run_at:new Date().toISOString(), next_run_at:new Date(Date.now()+hours*3600000).toISOString() });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok:true, result: result.message, articleId: result.article?.id || null }));
  } catch (e) {
    console.error("Automation worker failed:", e.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok:false, error:e.message }));
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
  if (req.method === "POST" && req.url === "/automation-worker") return handleAutomationWorker(req, res);
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
    await ensureMediaWorkerSecret();
    console.log("Media automation worker secret ready.");
  } catch (e) {
    console.error("Startup data initialization failed:", e.message);
  }
});


process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));
process.on("uncaughtException", e => console.error("Uncaught exception:", e));
console.log("Jabari Promoter code loaded successfully.");
