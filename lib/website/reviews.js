const https = require('https');

const owner = process.env.GITHUB_OWNER || 'jabarixai-dev';
const repo = process.env.GITHUB_REPO || 'Jabari';
const branch = process.env.GITHUB_BRANCH || 'main';
const token = process.env.GITHUB_TOKEN || '';
const reviewsPath = 'reviews/reviews.json';

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('GITHUB_TOKEN is not configured.'));
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        'User-Agent': 'Jabari-Promoter-Reviews',
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

async function readReviews() {
  const path = `/repos/${owner}/${repo}/contents/${reviewsPath}?ref=${encodeURIComponent(branch)}`;
  try {
    const result = await request('GET', path);
    const content = Buffer.from(result.content || '', 'base64').toString('utf8');
    const items = JSON.parse(content);
    if (!Array.isArray(items)) throw new Error('reviews/reviews.json is not an array.');
    return { items, sha: result.sha };
  } catch (e) {
    if (/404/.test(e.message)) return { items: [], sha: null };
    throw e;
  }
}

async function writeReviews(items, sha, message) {
  const content = Buffer.from(JSON.stringify(items, null, 2) + '\n').toString('base64');
  const body = { message, content, branch };
  if (sha) body.sha = sha;
  await request('PUT', `/repos/${owner}/${repo}/contents/${reviewsPath}`, body);
  return items;
}

async function listReviews() {
  const { items } = await readReviews();
  return items.sort((a,b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

async function updateReview(id, changes, message) {
  const { items, sha } = await readReviews();
  const index = items.findIndex(x => String(x.id) === String(id));
  if (index < 0) throw new Error('Review not found.');
  items[index] = { ...items[index], ...changes };
  await writeReviews(items, sha, message);
  return items[index];
}

async function setStatus(id, status) {
  if (!['approved','hidden'].includes(status)) throw new Error('Invalid review status.');
  return updateReview(id, { status }, `${status === 'approved' ? 'Approve' : 'Hide'} review`);
}

async function setReply(id, reply) {
  const clean = String(reply || '').trim();
  if (!clean) throw new Error('Reply cannot be empty.');
  return updateReview(id, {
    reply: clean,
    replyAuthor: 'Jabari',
    replyUpdatedAt: new Date().toISOString()
  }, 'Reply to review');
}

async function deleteReply(id) {
  return updateReview(id, { reply: '', replyAuthor: 'Jabari', replyUpdatedAt: '' }, 'Delete review reply');
}

async function deleteReview(id) {
  const { items, sha } = await readReviews();
  const next = items.filter(x => String(x.id) !== String(id));
  if (next.length === items.length) throw new Error('Review not found.');
  await writeReviews(next, sha, 'Delete review');
}

module.exports = { listReviews, setStatus, setReply, deleteReply, deleteReview };
