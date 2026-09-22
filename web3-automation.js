const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.PROMOTER_SUPABASE_URL || '',
  process.env.PROMOTER_SUPABASE_SERVICE_ROLE_KEY || ''
);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'jabarixai-dev';
const GITHUB_REPO = process.env.GITHUB_REPO || 'Jabari';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const SITE_URL = (process.env.JABARI_SITE_URL || 'https://jabarixai-dev.netlify.app').replace(/\/$/, '');

const SETTINGS_ID = 1;
let promotionHandler = null;
function setPromotionHandler(fn){ promotionHandler = typeof fn === 'function' ? fn : null; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex');
}

function slugify(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || `article-${Date.now()}`;
}

function cleanText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

async function githubRequest(path, options = {}) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is missing.');
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || `GitHub HTTP ${response.status}`);
  return data;
}

async function readPosts() {
  const path = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/blog/posts.json?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const data = await githubRequest(path);
  const raw = Buffer.from(data.content || '', 'base64').toString('utf8');
  return { posts: Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [], sha: data.sha };
}

async function writePosts(posts, sha, message) {
  const path = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/blog/posts.json`;
  return githubRequest(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(posts, null, 2) + '\n').toString('base64'),
      branch: GITHUB_BRANCH,
      sha
    })
  });
}

async function createBlogPost({ title, content, type, image = '' }) {
  const { posts, sha } = await readPosts();
  const id = `auto-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const slug = `${slugify(title)}-${id.slice(-6)}`;
  const now = new Date().toISOString();
  const post = {
    id,
    slug,
    title,
    content,
    image,
    video: '',
    date: now.slice(0, 10),
    updatedAt: now,
    category: type,
    articleType: type
  };
  posts.unshift(post);
  await writePosts(posts, sha, `Add automated ${type} article: ${title}`);
  return { ...post, url: `${SITE_URL}/#blog/${encodeURIComponent(slug)}` };
}

async function getSettings() {
  const { data, error } = await supabase.from('promoter_automation_settings').select('*').eq('id', SETTINGS_ID).single();
  if (error) throw error;
  return data;
}

async function saveSettings(patch) {
  const { data, error } = await supabase.from('promoter_automation_settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', SETTINGS_ID).select('*').single();
  if (error) throw error;
  return data;
}

async function rssSearch(query, limit = 10) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const response = await fetch(url, { headers: { 'User-Agent': 'JabariPromoter/1.0' } });
  if (!response.ok) throw new Error(`Search HTTP ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, limit).map(m => {
    const item = m[1];
    return {
      title: cleanText(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1]),
      url: cleanText(item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]),
      publisher: cleanText(item.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1]),
      published_at: cleanText(item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1])
    };
  }).filter(x => x.title && x.url);
}

async function geminiJson(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is missing.');
  const models = [...new Set([GEMINI_MODEL, 'gemini-3.7-flash', 'gemini-2.5-flash'])];
  let last;
  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 5000 }
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
      const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
      if (!raw) throw new Error('Gemini returned an empty response.');
      return JSON.parse(raw);
    } catch (e) {
      last = e;
      await sleep(800);
    }
  }
  throw last || new Error('Gemini generation failed.');
}

async function startRun(runType) {
  const { data, error } = await supabase.from('promoter_automation_runs').insert({ run_type: runType, status: 'started' }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function finishRun(id, patch) {
  await supabase.from('promoter_automation_runs').update({ ...patch, completed_at: new Date().toISOString() }).eq('id', id);
}

async function discoverOpportunities() {
  const runId = await startRun('opportunity_discovery');
  try {
    const queries = [
      'Web3 alpha opportunities 2026 crypto testnet rewards',
      'Web3 bounty hackathon grant rewards 2026',
      'crypto Web3 earn opportunity campaign rewards 2026',
      'blockchain protocol points testnet incentive campaign 2026'
    ];
    const rows = [];
    for (const q of queries) {
      try { rows.push(...await rssSearch(q, 8)); } catch (e) { console.error('Opportunity search:', e.message); }
    }
    const unique = new Map();
    for (const row of rows) unique.set(fingerprint(row.url.replace(/[?#].*$/, '')), row);

    let stored = 0;
    for (const row of unique.values()) {
      let type = 'money_making';
      const text = `${row.title} ${row.publisher}`.toLowerCase();
      if (/bounty|hackathon|grant/.test(text)) type = 'bounty';
      else if (/alpha|points|testnet|incentive|campaign/.test(text)) type = 'alpha';
      const { error } = await supabase.from('promoter_opportunities').upsert({
        opportunity_type: type,
        title: row.title.slice(0, 500),
        summary: `${row.publisher || 'Source'} — ${row.published_at || ''}`.trim(),
        source_url: row.url,
        source_name: row.publisher || null,
        fingerprint: fingerprint(row.url.replace(/[?#].*$/, '')),
        status: 'discovered',
        updated_at: new Date().toISOString()
      }, { onConflict: 'fingerprint', ignoreDuplicates: true });
      if (!error) stored++;
    }
    await finishRun(runId, { status: 'completed', items_found: unique.size, items_published: 0, message: `Stored ${stored} new opportunity candidates.` });
    return { found: unique.size, stored };
  } catch (e) {
    await finishRun(runId, { status: 'failed', message: e.message });
    throw e;
  }
}

async function publishOpportunitySlot(slotLabel) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.opportunities_enabled) return { skipped: true, reason: 'Opportunities disabled' };

  const runId = await startRun('opportunity_publish');
  try {
    const { data: candidates, error } = await supabase.from('promoter_opportunities')
      .select('*').in('status', ['discovered','verified']).order('discovered_at', { ascending: true }).limit(8);
    if (error) throw error;
    if (!candidates?.length) {
      await finishRun(runId, { status: 'skipped', message: `No stored opportunity for ${slotLabel}.` });
      return { skipped: true, reason: 'No candidates' };
    }

    const chosen = candidates[0];
    const research = candidates.slice(0, 5).map((x, i) => `${i + 1}. ${x.title}\nType: ${x.opportunity_type}\nSource: ${x.source_name || 'Unknown'}\nURL: ${x.source_url}`).join('\n\n');
    const article = await geminiJson(`You write a high-quality Web3 opportunities article for Jabari.\n\nSelected opportunity:\n${chosen.title}\nType: ${chosen.opportunity_type}\nSource: ${chosen.source_name || 'Unknown'}\nURL: ${chosen.source_url}\n\nOther candidates for context:\n${research}\n\nReturn JSON with title, content, summary. Content must be HTML using h2, p, ul and li. Do not invent eligibility, reward amounts, deadlines or steps. If a detail is not supported by the supplied source information, say that readers should verify it on the original source. Make the article useful and transparent. Do not include a Sources section.`);
    const post = await createBlogPost({ title: article.title || chosen.title, content: article.content, type: chosen.opportunity_type });
    await supabase.from('promoter_opportunities').update({ status: 'published', article_id: post.id, article_url: post.url, published_at: new Date().toISOString(), content: article.content, summary: article.summary || chosen.summary, updated_at: new Date().toISOString() }).eq('id', chosen.id);
    let promotion = null;
    if (settings.promotion_enabled && promotionHandler) {
      try { promotion = await promotionHandler({ title: post.title, description: article.summary || chosen.summary || '', url: post.url, opportunityId: chosen.id });
        if (promotion?.sent > 0) await supabase.from('promoter_opportunities').update({ status: 'promoted', promoted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', chosen.id);
      } catch (e) { console.error(`Opportunity promotion (${slotLabel}) failed:`, e.message); }
    }
    await finishRun(runId, { status: 'completed', items_found: 1, items_published: 1, items_promoted: promotion?.sent || 0, message: `${slotLabel}: ${post.url}` });
    return { post, opportunity: chosen, promotion };
  } catch (e) {
    await finishRun(runId, { status: 'failed', message: e.message });
    throw e;
  }
}

async function publishNews() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.news_enabled) return { skipped: true, reason: 'News disabled' };
  const runId = await startRun('news_publish');
  try {
    const queries = ['Web3 blockchain crypto news latest 2026', 'Ethereum Solana Bitcoin Web3 protocol news latest', 'AI agents Web3 blockchain news latest'];
    const rows = [];
    for (const q of queries) { try { rows.push(...await rssSearch(q, 8)); } catch (e) { console.error('News search:', e.message); } }
    const unique = [...new Map(rows.map(x => [fingerprint(x.url.replace(/[?#].*$/, '')), x])).values()].slice(0, 12);
    if (!unique.length) throw new Error('No Web3 news sources found.');
    const research = unique.map((x,i) => `${i+1}. ${x.title}\nPublisher: ${x.publisher || 'Unknown'}\nURL: ${x.url}\nPublished: ${x.published_at || 'Unknown'}`).join('\n\n');
    const article = await geminiJson(`You are the editor of a Web3 news blog. Compile one useful, factual news roundup from the supplied current headlines.\n\n${research}\n\nReturn JSON with title, content, summary. Content must be HTML using h2, p, ul and li. Do not invent facts, quotes, statistics or events. Do not add citation markers or a Sources section. Clearly distinguish analysis from reported facts.`);
    const post = await createBlogPost({ title: article.title, content: article.content, type: 'news' });
    await finishRun(runId, { status: 'completed', items_found: unique.length, items_published: 1, message: `News published: ${post.url}` });
    return { post };
  } catch (e) {
    await finishRun(runId, { status: 'failed', message: e.message });
    throw e;
  }
}

function startScheduler() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const settings = await getSettings();
      if (!settings.enabled) return;
      const now = Date.now();
      const hour = new Date().getHours();
      const lastOpportunity = settings.last_opportunity_scan_at ? new Date(settings.last_opportunity_scan_at).getTime() : 0;
      const lastNews = settings.last_news_run_at ? new Date(settings.last_news_run_at).getTime() : 0;
      if (settings.opportunities_enabled && (!lastOpportunity || now - lastOpportunity >= 55 * 60 * 1000)) {
        try { await discoverOpportunities(); await saveSettings({ last_opportunity_scan_at: new Date().toISOString() }); } catch (e) { console.error('Hourly opportunity automation:', e.message); }
      }
      if (settings.news_enabled && (!lastNews || now - lastNews >= settings.news_interval_hours * 3600000)) {
        try { await publishNews(); await saveSettings({ last_news_run_at: new Date().toISOString() }); } catch (e) { console.error('5-hour news automation:', e.message); }
      }
      const slots = [
        [settings.morning_hour, 'Morning'],
        [settings.afternoon_hour, 'Afternoon'],
        [settings.night_hour, 'Night']
      ];
      const lastSlot = settings.last_opportunity_publish_slot || '';
      const currentKey = `${new Date().toISOString().slice(0,10)}-${hour}`;
      const slot = slots.find(([h]) => h === hour);
      if (settings.opportunities_enabled && slot && lastSlot !== currentKey) {
        try { await publishOpportunitySlot(slot[1]); await saveSettings({ last_opportunity_publish_slot: currentKey }); } catch (e) { console.error(`${slot[1]} opportunity automation:`, e.message); }
      }
    } finally { busy = false; }
  };
  void tick();
  return setInterval(tick, 5 * 60 * 1000);
}

async function automationStatus() {
  const settings = await getSettings();
  const { data: pending } = await supabase.from('promoter_opportunities').select('id', { count: 'exact', head: true }).in('status', ['discovered','verified']);
  return { settings, pending: pending || 0 };
}

module.exports = { startScheduler, discoverOpportunities, publishNews, publishOpportunitySlot, automationStatus, getSettings, saveSettings, setPromotionHandler };
