const https = require('https');

const owner = process.env.GITHUB_OWNER || 'jabarixai-dev';
const repo = process.env.GITHUB_REPO || 'Jabari';
const branch = process.env.GITHUB_BRANCH || 'main';
const token = process.env.GITHUB_TOKEN || '';
const aboutPath = 'about/content.json';

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('GITHUB_TOKEN is not configured.'));
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        'User-Agent': 'Jabari-Promoter-About',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)} : {})
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed.message || `GitHub API error (${res.statusCode})`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const defaultAbout = {
  bio: "I'm Jabari. I create professional digital experiences through website design, graphics design and technology, helping businesses, organizations and individuals present their work clearly and professionally.",
  services: [
    { title: 'Website Design', description: 'Professional, responsive websites for businesses, schools, organizations, portfolios and personal brands.' },
    { title: 'Graphics Design', description: 'Visual identities, promotional materials, social media graphics and product designs that help brands communicate clearly.' },
    { title: 'Computer Scientist', description: 'Technology-driven solutions, software concepts and AI-assisted digital projects.' }
  ]
};

async function readAbout() {
  const path = `/repos/${owner}/${repo}/contents/${aboutPath}?ref=${encodeURIComponent(branch)}`;
  try {
    const result = await request('GET', path);
    const content = Buffer.from(result.content || '', 'base64').toString('utf8');
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') throw new Error('about/content.json is invalid.');
    return { data, sha: result.sha };
  } catch (e) {
    if (/404/.test(e.message)) return { data: defaultAbout, sha: null };
    throw e;
  }
}

function normalize(data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid About data.');
  const services = Array.isArray(data.services) ? data.services.slice(0, 3).map(x => ({
    title: String(x?.title || '').trim(),
    description: String(x?.description || '').trim()
  })) : [];
  const bio = String(data.bio || '').trim();
  if (!bio || services.length !== 3 || services.some(x => !x.title || !x.description)) {
    throw new Error('Bio and all three services are required.');
  }
  return { bio, services };
}

async function getAbout() {
  const { data } = await readAbout();
  return normalize(data);
}

async function saveAbout(data) {
  const normalized = normalize(data);
  const { sha } = await readAbout();
  const content = Buffer.from(JSON.stringify(normalized, null, 2) + '\n').toString('base64');
  const body = {
    message: 'Update About content from Telegram',
    content,
    branch
  };
  if (sha) body.sha = sha;
  await request('PUT', `/repos/${owner}/${repo}/contents/${aboutPath}`, body);
  return normalized;
}

module.exports = { getAbout, saveAbout };
