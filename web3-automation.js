const { createClient } = require('@supabase/supabase-js');
const websiteBlog = require('./lib/website/blog');

const supabaseUrl = process.env.PROMOTER_SUPABASE_URL || '';
const supabaseKey = process.env.PROMOTER_SUPABASE_SERVICE_ROLE_KEY || '';
const siteUrl = String(process.env.JABARI_SITE_URL || '').replace(/\/$/, '');

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing PROMOTER_SUPABASE_URL or PROMOTER_SUPABASE_SERVICE_ROLE_KEY.');
}

const supabase = createClient(supabaseUrl, supabaseKey);
let promotionHandler = null;
let schedulerStarted = false;
let schedulerBusy = false;

const NEWS_FEEDS = [
  'https://news.google.com/rss/search?q=Web3+blockchain+crypto&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=DeFi+crypto+Web3&hl=en-US&gl=US&ceid=US:en'
];

const OPPORTUNITY_FEEDS = [
  'https://news.google.com/rss/search?q=Web3+bounty+OR+crypto+bounty&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Web3+alpha+OR+crypto+airdrop+opportunity&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Web3+quest+reward+OR+blockchain+hackathon+bounty&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=Web3+earn+opportunity+OR+crypto+grant&hl=en-US&gl=US&ceid=US:en'
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function cleanText(value) {
  let text = String(value || '').replace(/<!\[CDATA\[|\]\]>/g, '');
  for (let i = 0; i < 3; i++) {
    const decoded = text
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    if (decoded === text) break;
    text = decoded;
  }
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function xmlTag(item, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  return cleanText(item.match(re)?.[1] || '');
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = xmlTag(block, 'title');
    const link = xmlTag(block, 'link');
    const description = xmlTag(block, 'description');
    const pubDate = xmlTag(block, 'pubDate');
    const source = xmlTag(block, 'source');
    if (title && link) items.push({ title, link, description, pubDate, source });
  }
  return items;
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: options.redirect || 'follow',
      headers: {
        'User-Agent': 'JabariPromoter/1.0 Web3Research',
        ...(options.headers || {})
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), finalUrl: res.url || url, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

function extractCanonicalUrl(html, baseUrl) {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:url["'][^>]+content=["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match?.[1]) {
      try { return new URL(match[1], baseUrl).href; } catch (_) {}
    }
  }
  return '';
}

async function resolveSourceUrl(rawUrl) {
  const original = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(original)) return '';
  let parsed;
  try { parsed = new URL(original); } catch (_) { return ''; }

  // RSS may expose a Google News redirect rather than the publisher's page.
  // Follow it and, if Google remains the final host, inspect canonical metadata.
  if (!/(\.|^)news\.google\.com$/i.test(parsed.hostname)) return original;

  try {
    const result = await fetchText(original, {
      timeout: 15000,
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    });
    try {
      const final = new URL(result.finalUrl);
      if (!/(\.|^)news\.google\.com$/i.test(final.hostname)) return final.href;
    } catch (_) {}

    const canonical = extractCanonicalUrl(result.text, result.finalUrl || original);
    if (canonical) {
      try {
        const u = new URL(canonical);
        if (!/(\.|^)news\.google\.com$/i.test(u.hostname)) return u.href;
      } catch (_) {}
    }

    const metaRefresh = result.text.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i);
    if (metaRefresh?.[1]) {
      try {
        const u = new URL(metaRefresh[1].trim(), result.finalUrl || original);
        if (!/(\.|^)news\.google\.com$/i.test(u.hostname)) return u.href;
      } catch (_) {}
    }
  } catch (e) {
    console.error('Source URL resolution failed:', original, e.message);
  }
  return '';
}

async function fetchSourcePage(url) {
  const result = await fetchText(url, {
    timeout: 15000,
    headers: { 'Accept': 'text/html,application/xhtml+xml' }
  });
  const canonical = extractCanonicalUrl(result.text, result.finalUrl || url);
  return {
    url: canonical || result.finalUrl || url,
    html: result.text
  };
}

function htmlToReadableText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchFeeds(feeds) {
  const all = [];
  for (const feed of feeds) {
    try {
      const result = await fetchText(feed);
      all.push(...parseRss(result.text));
    } catch (e) {
      console.error('Web3 feed failed:', feed, e.message);
    }
  }
  const seen = new Set();
  return all.filter(item => {
    const key = `${item.title.toLowerCase()}|${item.link}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function classifyOpportunity(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  if (/bounty|hackathon|bug bounty/.test(text)) return 'bounty';
  if (/alpha|airdrop|early access|testnet|quest|campaign|points/.test(text)) return 'alpha';
  if (/grant|earn|reward|funding|opportunity|income/.test(text)) return 'money_making';
  return null;
}

function looksUsefulOpportunity(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const bad = [
    'casino', 'gambling', 'sportsbook', 'porn', 'adult', 'phishing',
    'malware', 'ransomware', 'steal your', 'guaranteed profit', '100% profit'
  ];
  return !bad.some(term => text.includes(term)) && item.link.startsWith('http');
}

function fingerprint(item, type, directUrl = '') {
  const normalized = `${type}|${item.title}|${directUrl || item.link}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return require('crypto').createHash('sha256').update(normalized).digest('hex');
}

function articleUrl(id) {
  return siteUrl ? `${siteUrl}/#blog/${encodeURIComponent(id)}` : '';
}

async function getSettings() {
  const { data, error } = await supabase.from('promoter_automation_settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}

async function saveSettings(patch) {
  const { data, error } = await supabase
    .from('promoter_automation_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function logRun(runType, status, patch = {}) {
  const payload = { run_type: runType, status, ...patch };
  const { data, error } = await supabase.from('promoter_automation_runs').insert(payload).select('*').single();
  if (error) console.error('Automation run log failed:', error.message);
  return data;
}

async function updateRun(id, patch) {
  if (!id) return;
  const { error } = await supabase.from('promoter_automation_runs').update(patch).eq('id', id);
  if (error) console.error('Automation run update failed:', error.message);
}

async function discoverOpportunities() {
  const run = await logRun('opportunity_discovery', 'started', { started_at: new Date().toISOString() });
  try {
    const items = await fetchFeeds(OPPORTUNITY_FEEDS);
    let stored = 0;
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;

    for (const item of items) {
      const type = classifyOpportunity(item);
      if (!type || !looksUsefulOpportunity(item)) continue;
      const publishedTime = Date.parse(item.pubDate || '') || Date.now();
      if (publishedTime < cutoff) continue;

      const directUrl = await resolveSourceUrl(item.link);
      if (!directUrl) {
        console.log('Skipping opportunity because a direct publisher URL could not be resolved:', item.title);
        continue;
      }

      const fp = fingerprint(item, type, directUrl);
      const row = {
        opportunity_type: type,
        title: item.title.slice(0, 300),
        summary: item.description.slice(0, 1200),
        content: `Source: ${item.source || 'Web3 source'}\n\n${item.description || item.title}`,
        source_url: directUrl,
        source_name: item.source || 'Web3 source',
        discovered_at: new Date().toISOString(),
        fingerprint: fp,
        status: 'verified'
      };

      const { error } = await supabase.from('promoter_opportunities').insert(row);
      if (!error) stored++;
      else if (error.code !== '23505') console.error('Opportunity store failed:', error.message);
    }

    await updateRun(run?.id, {
      status: 'completed', completed_at: new Date().toISOString(),
      items_found: items.length, items_published: 0, items_promoted: 0,
      message: `Stored ${stored} new opportunities with direct publisher URLs.`
    });
    return { found: items.length, stored };
  } catch (e) {
    await updateRun(run?.id, { status: 'failed', completed_at: new Date().toISOString(), message: e.message });
    throw e;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeTitle(value, fallback) {
  const title = cleanText(value).replace(/^web3\s+news\s+roundup\s*[-—:]\s*/i, '').trim();
  return title || fallback;
}

async function generateGeminiArticle(prompt, fallbackTitle, fallbackContent) {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return { title: fallbackTitle, content: fallbackContent };

  const models = [
    process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite'
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.35,
              maxOutputTokens: 7000
            }
          })
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        console.error(`Gemini ${model} failed: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join(' ').trim() || '';
      if (!text) continue;

      let title = fallbackTitle;
      let content = text;
      const titleMatch = text.match(/^\s*TITLE\s*:\s*(.+?)(?:\n|$)/i);
      if (titleMatch) {
        title = safeTitle(titleMatch[1], fallbackTitle);
        content = text.slice(titleMatch[0].length).trim();
      }
      content = content.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
      return { title, content };
    } catch (e) {
      console.error(`Gemini ${model} error:`, e.message);
    }
  }
  return { title: fallbackTitle, content: fallbackContent };
}

async function buildDetailedOpportunityArticle(chosen) {
  let sourceText = '';
  let directUrl = chosen.source_url || '';

  if (directUrl) {
    try {
      const page = await fetchSourcePage(directUrl);
      directUrl = page.url || directUrl;
      sourceText = htmlToReadableText(page.html).slice(0, 24000);
    } catch (e) {
      console.error('Could not read direct opportunity page:', e.message);
    }
  }

  const fallbackTitle = safeTitle(chosen.title, 'Web3 Opportunity Worth Exploring');
  const fallbackContent = [
    `<p><strong>${escapeHtml(fallbackTitle)}</strong> is a ${escapeHtml(chosen.opportunity_type)} opportunity identified from a public Web3 source.</p>`,
    `<h2>What is this opportunity?</h2><p>${escapeHtml(chosen.summary || chosen.content || 'The available public information is limited. Review the original opportunity page for the current details.')}</p>`,
    `<h2>What to check before participating</h2><ul><li>Confirm the official project or organizer.</li><li>Check current eligibility and geographic restrictions.</li><li>Check the deadline, required tasks and reward terms.</li><li>Never share seed phrases, private keys or passwords.</li><li>Use the official participation page rather than an unverified copy.</li></ul>`,
    `<h2>Original opportunity</h2><p><a href="${escapeHtml(directUrl)}" target="_blank" rel="noopener noreferrer">Open the original opportunity →</a></p>`,
    `<p><strong>Verification note:</strong> Details can change. Confirm the current terms on the official source before taking action.</p>`
  ].join('\n');

  const prompt = `You are writing a high-quality Web3 opportunity article for Jabari.

Create a detailed, useful article from the source material below. Do not invent eligibility, rewards, deadlines, investment returns, links, partnerships or instructions that are not supported by the source. If a detail is unclear, say it is unclear.

Return:
TITLE: one natural, interesting title (do not use "Web3 News Roundup")
Then HTML only using <p>, <h2>, <h3>, <ul>, <ol>, <li>, <strong>, <a>.

Target 900-1400 words.

Cover:
- What the opportunity is
- Why it may matter
- Who appears eligible, only if supported
- Step-by-step participation instructions, only if supported
- What participants may receive, only if supported
- Important requirements and deadlines, only if supported
- Risks, scams and verification checks
- A concise practical takeaway
- A final link to the original opportunity

Opportunity type: ${chosen.opportunity_type}
Title: ${chosen.title}
Publisher: ${chosen.source_name}
Direct source URL: ${directUrl}

RSS summary:
${chosen.summary || ''}

Source page text:
${sourceText || '(The direct page could not be read. Use only the RSS summary and clearly state when information is unavailable.)'}

IMPORTANT: The article must not expose a Google News RSS URL. Use the direct source URL supplied above for the final original-opportunity link.`;

  return generateGeminiArticle(prompt, fallbackTitle, fallbackContent);
}

function buildNewsFallback(items) {
  const date = new Date().toLocaleDateString('en-US', { dateStyle: 'long' });
  const lead = items[0]?.title || 'The Latest Web3 Developments';
  const title = safeTitle(lead, `What’s Moving in Web3 — ${date}`);
  const body = [
    `<p>Here are several notable developments currently appearing across public Web3 reporting as of ${escapeHtml(date)}.</p>`,
    ...items.slice(0, 6).map(item =>
      `<h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description || 'Public reporting is available from the source below.')}</p>`
    ),
    '<h2>What to watch</h2><p>Track official announcements and primary sources as these developments evolve. Information in fast-moving Web3 markets can change quickly.</p>',
    '<p><strong>Sources:</strong> The article is based on the public reports retrieved during this automation run.</p>'
  ];
  return { title, content: body.join('\n') };
}

async function buildNewsArticle(items) {
  const fallback = buildNewsFallback(items);
  const sourceMaterial = items.slice(0, 8).map((item, i) =>
    `SOURCE ${i + 1}\nTitle: ${item.title}\nPublisher: ${item.source || 'Unknown'}\nURL: ${item.link}\nSummary: ${item.description || ''}`
  ).join('\n\n');

  const prompt = `Write a polished Web3 news article for Jabari from the public source material below.

Return:
TITLE: a natural, editorial headline. Never use "Web3 News Roundup", "News Roundup", or "Roundup" in the title.
Then HTML only using <p>, <h2>, <h3>, <ul>, <li>, <strong> and <a>.

Target 900-1300 words. Explain the most important developments, provide context, explain why they matter, and identify what readers should watch next. Do not invent facts. Do not present speculation as fact. Keep the tone professional and readable.

Do not expose Google News RSS redirect URLs in the article. You may mention publishers by name, but do not add source links unless they are clearly direct publisher URLs.

SOURCE MATERIAL:
${sourceMaterial}`;

  return generateGeminiArticle(prompt, fallback.title, fallback.content);
}

async function publishNews() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.news_enabled) return { skipped: true, reason: 'News automation is OFF.' };
  const run = await logRun('news_publish', 'started', { started_at: new Date().toISOString() });
  try {
    const items = await fetchFeeds(NEWS_FEEDS);
    if (!items.length) throw new Error('No current Web3 news items were found.');
    const article = await buildNewsArticle(items);
    const post = await websiteBlog.createPost({
      title: article.title,
      content: article.content,
      articleType: 'news'
    });
    const url = articleUrl(post.id);
    await updateRun(run?.id, {
      status: 'completed', completed_at: new Date().toISOString(),
      items_found: items.length, items_published: 1, items_promoted: 0,
      message: post.title
    });
    await saveSettings({ last_news_run_at: new Date().toISOString() });
    return { skipped: false, post: { ...post, url } };
  } catch (e) {
    await updateRun(run?.id, { status: 'failed', completed_at: new Date().toISOString(), message: e.message });
    throw e;
  }
}

async function publishOpportunitySlot(slotName) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.opportunities_enabled) return { skipped: true, reason: 'Opportunity automation is OFF.' };

  const slot = String(slotName || 'Manual');
  const now = new Date();
  const slotKey = slot === 'Manual' ? `manual-${now.toISOString()}` : `${now.toISOString().slice(0,10)}-${slot}`;
  if (slot !== 'Manual' && settings.last_opportunity_publish_slot === slotKey) {
    return { skipped: true, reason: `${slot} slot has already been published today.` };
  }

  const { data: candidates, error } = await supabase
    .from('promoter_opportunities')
    .select('*')
    .in('status', ['verified', 'discovered'])
    .order('discovered_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  if (!candidates?.length) return { skipped: true, reason: 'No stored opportunity is available yet.' };

  const chosen = candidates.find(x => !x.expires_at || new Date(x.expires_at) > now) || candidates[0];
  if (!chosen.source_url || /(^|:\/\/)([^/]+\.)?news\.google\.com\//i.test(chosen.source_url)) {
    await supabase.from('promoter_opportunities').update({
      status: 'rejected',
      updated_at: new Date().toISOString()
    }).eq('id', chosen.id);
    return { skipped: true, reason: 'Stored opportunity has no verified direct publisher URL. It was not published.' };
  }

  const article = await buildDetailedOpportunityArticle(chosen);
  const post = await websiteBlog.createPost({
    title: article.title,
    content: article.content,
    articleType: chosen.opportunity_type,
    sourceUrl: chosen.source_url
  });
  const url = articleUrl(post.id);

  await supabase.from('promoter_opportunities').update({
    status: 'published', article_id: post.id, article_url: url,
    published_at: now.toISOString(), updated_at: now.toISOString()
  }).eq('id', chosen.id);

  if (slot !== 'Manual') await saveSettings({ last_opportunity_publish_slot: slotKey });

  let promotion = null;
  if (settings.promotion_enabled && promotionHandler && url) {
    try {
      promotion = await promotionHandler({
        title: article.title,
        description: chosen.summary || chosen.content || '',
        url
      });
      await supabase.from('promoter_opportunities').update({
        status: 'promoted', promoted_at: new Date().toISOString(), updated_at: new Date().toISOString()
      }).eq('id', chosen.id);
    } catch (e) {
      console.error('Opportunity promotion failed:', e.message);
      promotion = { error: e.message };
    }
  }

  await logRun('opportunity_publish', 'completed', {
    started_at: now.toISOString(), completed_at: new Date().toISOString(),
    items_found: 1, items_published: 1, items_promoted: promotion?.sent || 0,
    message: `${slot}: ${article.title}`
  });
  return { skipped: false, post: { ...post, url }, promotion };
}

async function automationStatus() {
  const settings = await getSettings();
  const { count, error } = await supabase.from('promoter_opportunities')
    .select('*', { count: 'exact', head: true })
    .in('status', ['verified', 'discovered']);
  if (error) throw error;
  return { settings, pending: count || 0 };
}

function setPromotionHandler(fn) { promotionHandler = typeof fn === 'function' ? fn : null; }

function lagosSlot() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = t => parts.find(x => x.type === t)?.value || '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (hour === 9 && minute === 0) return { name: 'Morning', key: `${date}-Morning` };
  if (hour === 15 && minute === 0) return { name: 'Afternoon', key: `${date}-Afternoon` };
  if (hour === 21 && minute === 0) return { name: 'Night', key: `${date}-Night` };
  return null;
}

async function schedulerTick() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const settings = await getSettings();
    if (!settings.enabled) return;

    const now = Date.now();
    const lastScan = settings.last_opportunity_scan_at ? Date.parse(settings.last_opportunity_scan_at) : 0;
    if (settings.hourly_discovery_enabled && (!lastScan || now - lastScan >= 60 * 60 * 1000)) {
      try {
        await discoverOpportunities();
        await saveSettings({ last_opportunity_scan_at: new Date().toISOString() });
      } catch (e) { console.error('Hourly opportunity scan failed:', e.message); }
    }

    const lastNews = settings.last_news_run_at ? Date.parse(settings.last_news_run_at) : 0;
    if (settings.news_enabled && (!lastNews || now - lastNews >= Number(settings.news_interval_hours || 5) * 60 * 60 * 1000)) {
      try { await publishNews(); } catch (e) { console.error('Scheduled news publish failed:', e.message); }
    }

    const slot = lagosSlot();
    if (slot) {
      try { await publishOpportunitySlot(slot.name); } catch (e) {
        console.error(`Scheduled ${slot.name} opportunity failed:`, e.message);
      }
    }
  } finally {
    schedulerBusy = false;
  }
}

function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  void schedulerTick();
  setInterval(() => void schedulerTick(), 60 * 1000);
}

module.exports = {
  getSettings,
  saveSettings,
  automationStatus,
  setPromotionHandler,
  discoverOpportunities,
  publishNews,
  publishOpportunitySlot,
  startScheduler
};
