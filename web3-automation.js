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
  let text = String(value || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '');

  // RSS feeds can encode HTML markup as entities.
  // Decode first, then remove the actual HTML tags.
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

  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'JabariPromoter/1.0 Web3Research' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeeds(feeds) {
  const all = [];
  for (const feed of feeds) {
    try {
      const xml = await fetchText(feed);
      all.push(...parseRss(xml));
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

function fingerprint(item, type) {
  const normalized = `${type}|${item.title}|${item.link}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

      const fp = fingerprint(item, type);
      const row = {
        opportunity_type: type,
        title: item.title.slice(0, 300),
        summary: item.description.slice(0, 1200),
        content: `Source: ${item.source || 'Web3 source'}\n\n${item.description || item.title}`,
        source_url: item.link,
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
      message: `Stored ${stored} new opportunities.`
    });
    return { found: items.length, stored };
  } catch (e) {
    await updateRun(run?.id, { status: 'failed', completed_at: new Date().toISOString(), message: e.message });
    throw e;
  }
}

function buildNewsArticle(items) {
  const selected = items.slice(0, 8);
  const date = new Date().toLocaleDateString('en-US', { dateStyle: 'long' });
  const body = [
    `<p>Here is a concise Web3 news roundup for ${date}.</p>`,
    ...selected.map((item, i) => `<h2>${i + 1}. ${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description || 'Read the original report for details.')}</p><p><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">Read source</a></p>`),
    '<p><strong>Note:</strong> This roundup summarizes public reports. Verify important details with the original sources before acting on them.</p>'
  ];
  return { title: `Web3 News Roundup — ${date}`, content: body.join('\n') };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function publishNews() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.news_enabled) return { skipped: true, reason: 'News automation is OFF.' };
  const run = await logRun('news_publish', 'started', { started_at: new Date().toISOString() });
  try {
    const items = await fetchFeeds(NEWS_FEEDS);
    if (!items.length) throw new Error('No current Web3 news items were found.');
    const article = buildNewsArticle(items);
    const post = await websiteBlog.createPost(article);
    const url = articleUrl(post.id);
    await updateRun(run?.id, { status: 'completed', completed_at: new Date().toISOString(), items_found: items.length, items_published: 1, message: post.title });
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
  const title = chosen.title;
  const content = [
    `<p>${escapeHtml(chosen.summary || chosen.content || '')}</p>`,
    `<p><strong>Type:</strong> ${escapeHtml(chosen.opportunity_type)}</p>`,
    `<p><strong>Source:</strong> ${escapeHtml(chosen.source_name || 'Public source')}</p>`,
    `<p><a href="${escapeHtml(chosen.source_url)}" target="_blank" rel="noopener">View the original opportunity</a></p>`,
    '<p><strong>Do your own verification:</strong> availability, eligibility, deadlines, rewards and requirements can change.</p>'
  ].join('\n');

  const post = await websiteBlog.createPost({ title, content });
  const url = articleUrl(post.id);

  await supabase.from('promoter_opportunities').update({
    status: 'published', article_id: post.id, article_url: url, published_at: now.toISOString(), updated_at: now.toISOString()
  }).eq('id', chosen.id);

  if (slot !== 'Manual') await saveSettings({ last_opportunity_publish_slot: slotKey });

  let promotion = null;
  if (settings.promotion_enabled && promotionHandler && url) {
    try {
      promotion = await promotionHandler({ title, description: chosen.summary || chosen.content || '', url });
      await supabase.from('promoter_opportunities').update({ status: 'promoted', promoted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', chosen.id);
    } catch (e) {
      console.error('Opportunity promotion failed:', e.message);
      promotion = { error: e.message };
    }
  }

  await logRun('opportunity_publish', 'completed', { started_at: now.toISOString(), completed_at: new Date().toISOString(), items_found: 1, items_published: 1, items_promoted: promotion?.sent || 0, message: `${slot}: ${title}` });
  return { skipped: false, post: { ...post, url }, promotion };
}

async function automationStatus() {
  const settings = await getSettings();
  const { count, error } = await supabase.from('promoter_opportunities').select('*', { count: 'exact', head: true }).in('status', ['verified', 'discovered']);
  if (error) throw error;
  return { settings, pending: count || 0 };
}

function setPromotionHandler(fn) { promotionHandler = typeof fn === 'function' ? fn : null; }

function lagosSlot() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit'
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
      try { await publishOpportunitySlot(slot.name); } catch (e) { console.error(`Scheduled ${slot.name} opportunity failed:`, e.message); }
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
