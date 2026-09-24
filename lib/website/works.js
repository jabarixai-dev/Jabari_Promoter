const https = require('https');

const OWNER = process.env.GITHUB_OWNER || 'jabarixai-dev';
const REPO = process.env.GITHUB_REPO || 'Jabari';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const PATH = 'works/works.json';

function githubRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method,
      headers: {
        'User-Agent': 'Jabari-Works-Manager',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({status:res.statusCode,data:JSON.parse(data)}); } catch (_) { resolve({status:res.statusCode,data:{}}); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function clean(raw) {
  const x = raw || {};
  const link = String(x.link || '').trim();
  if (link && !/^https:\/\//i.test(link)) throw new Error('Work links must use https:// or be left empty.');
  return {
    id: String(x.id || '').trim(),
    title: String(x.title || '').trim(),
    body: String(x.body || '').trim(),
    image: String(x.image || '').trim(),
    link
  };
}

async function getWorks() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  const current = await githubRequest('GET', `/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`, null, token);
  if (current.status === 404) return [];
  if (current.status !== 200) throw new Error('Could not read My Works from GitHub.');
  const decoded = Buffer.from(current.data.content, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  return Array.isArray(parsed) ? parsed.map(clean) : [];
}

async function saveWorks(items) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  const works = items.map(clean).filter(x => x.title);
  const apiPath = `/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${encodeURIComponent(BRANCH)}`;
  const current = await githubRequest('GET', apiPath, null, token);
  const payload = {
    message: 'Update My Works',
    content: Buffer.from(JSON.stringify(works, null, 2) + '\n').toString('base64'),
    branch: BRANCH
  };
  if (current.status === 200 && current.data.sha) payload.sha = current.data.sha;
  const result = await githubRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${PATH}`, payload, token);
  if (result.status < 200 || result.status >= 300) throw new Error('Could not save My Works to GitHub.');
  return works;
}

async function uploadImage(buffer, originalName='work.jpg') {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not configured.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Image is empty.');
  if (buffer.length > 2 * 1024 * 1024) throw new Error('Image must be 2 MB or smaller.');
  const ext = /\.(png|webp|jpg|jpeg)$/i.exec(String(originalName))?.[1]?.toLowerCase() || 'jpg';
  const safeExt = ext === 'jpeg' ? 'jpg' : ext;
  const filename = `work-${Date.now()}.${safeExt}`;
  const path = `works-media/${filename}`;
  const result = await githubRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${path}`, {
    message: `Upload My Work image ${filename}`,
    content: buffer.toString('base64'), branch: BRANCH
  }, token);
  if (result.status < 200 || result.status >= 300) throw new Error('Could not upload the work image to GitHub.');
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${path}`;
}

module.exports = { getWorks, saveWorks, uploadImage };
