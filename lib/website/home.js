const https = require('https');

const OWNER = process.env.GITHUB_OWNER || 'jabarixai-dev';
const REPO = process.env.GITHUB_REPO || 'Jabari';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const PATH = 'home/content.json';

const DEFAULT_HOME = {
  logoUrl: '',
  name: 'JABARI',
  tagline: 'Website Designer · Graphics Designer · Computer Scientist',
  socials: {
    whatsapp: 'https://wa.me/2349031761024',
    x: 'https://x.com/King_Jabari',
    telegram: 'https://t.me/King_Jabari',
    youtube: 'https://youtube.com/@king_jabari?si=ZTs8BNNN0XczyBEQ'
  },
  buttons: [
    { text: 'About', href: '#about' },
    { text: 'Reviews', href: '#reviews' },
    { text: 'Shop', href: '#shop' },
    { text: 'My Blogs', href: '#blogs' }
  ],
  footer: 'Africa · AI · Markets · Culture · Truth'
};

function githubRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'User-Agent': 'Jabari-Home-Manager',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = { raw: data }; }
        resolve({ status: res.statusCode, data: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function normalizeUrl(value, allowHash = true) {
  const v = String(value || '').trim();
  if (allowHash && /^#[A-Za-z0-9_-]+$/.test(v)) return v;
  if (/^https:\/\//i.test(v)) return v;
  throw new Error('Links must use https:// or a local #section link.');
}

function normalizeHome(raw) {
  const x = raw || {};
  const socials = x.socials || {};
  const sourceButtons = Array.isArray(x.buttons) ? x.buttons : [];
  const buttons = DEFAULT_HOME.buttons.map((fallback, i) => {
    const b = sourceButtons[i] || {};
    return {
      text: String(b.text || fallback.text).trim(),
      href: normalizeUrl(b.href || fallback.href)
    };
  });

  return {
    logoUrl: String(x.logoUrl || '').trim(),
    name: String(x.name || DEFAULT_HOME.name).trim(),
    tagline: String(x.tagline || DEFAULT_HOME.tagline).trim(),
    socials: {
      whatsapp: normalizeUrl(socials.whatsapp || DEFAULT_HOME.socials.whatsapp, false),
      x: normalizeUrl(socials.x || DEFAULT_HOME.socials.x, false),
      telegram: normalizeUrl(socials.telegram || DEFAULT_HOME.socials.telegram, false),
      youtube: normalizeUrl(socials.youtube || DEFAULT_HOME.socials.youtube, false)
    },
    buttons,
    footer: String(x.footer || DEFAULT_HOME.footer).trim()
  };
}

async function getHome() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  const apiPath = `/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`;
  const current = await githubRequest('GET', apiPath, null, token);
  if (current.status === 404) return { ...DEFAULT_HOME, socials: { ...DEFAULT_HOME.socials }, buttons: DEFAULT_HOME.buttons.map(x => ({ ...x })) };
  if (current.status !== 200) throw new Error('Could not read Home content from GitHub.');
  const decoded = Buffer.from(current.data.content, 'base64').toString('utf8');
  return normalizeHome(JSON.parse(decoded));
}

async function saveHome(data) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  const home = normalizeHome(data);
  const apiPath = `/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`;
  const current = await githubRequest('GET', apiPath, null, token);
  const payload = {
    message: 'Update website Home content',
    content: Buffer.from(JSON.stringify(home, null, 2) + '\n').toString('base64'),
    branch: BRANCH
  };
  if (current.status === 200 && current.data.sha) payload.sha = current.data.sha;
  const result = await githubRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${PATH}`, payload, token);
  if (result.status < 200 || result.status >= 300) throw new Error('Could not save Home content to GitHub.');
  return home;
}

async function uploadLogo(buffer, originalName = 'jabari-logo.jpg') {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Logo image is empty.');
  if (buffer.length > 2 * 1024 * 1024) throw new Error('Logo image must be 2 MB or smaller.');

  const ext = /\.(png|webp|jpg|jpeg)$/i.exec(String(originalName))?.[1]?.toLowerCase() || 'jpg';
  const safeExt = ext === 'jpeg' ? 'jpg' : ext;
  const filename = `jabari-logo-${Date.now()}.${safeExt}`;
  const path = `home-media/${filename}`;
  const payload = {
    message: `Upload Home logo ${filename}`,
    content: buffer.toString('base64'),
    branch: BRANCH
  };
  const result = await githubRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${path}`, payload, token);
  if (result.status < 200 || result.status >= 300) throw new Error('Could not upload the Home logo to GitHub.');
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}`;
}

module.exports = { DEFAULT_HOME, getHome, saveHome, uploadLogo };
