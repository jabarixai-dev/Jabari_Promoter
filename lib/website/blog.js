const https = require('https');

const owner = process.env.GITHUB_OWNER || 'jabarixai-dev';
const repo = process.env.GITHUB_REPO || 'Jabari';
const branch = process.env.GITHUB_BRANCH || 'main';
const token = process.env.GITHUB_TOKEN || '';
const path = 'blog/posts.json';

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('GITHUB_TOKEN is not configured.'));
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'Jabari-Promoter',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(parsed?.message || `GitHub API error (${res.statusCode})`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function apiPath() {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`;
}

async function readCatalog() {
  const response = await request('GET', apiPath());
  if (!response?.content) throw new Error('GitHub did not return blog/posts.json content.');
  const json = Buffer.from(response.content, 'base64').toString('utf8');
  const posts = JSON.parse(json);
  if (!Array.isArray(posts)) throw new Error('blog/posts.json is not a valid array.');
  return { posts, sha: response.sha };
}

async function listPosts() {
  const { posts } = await readCatalog();
  return posts.slice().sort((a, b) => new Date(b.updatedAt || b.date || 0) - new Date(a.updatedAt || a.date || 0));
}

async function writePosts(posts, sha, message) {
  const content = Buffer.from(JSON.stringify(posts, null, 2) + '\n', 'utf8').toString('base64');
  return request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`, {
    message,
    content,
    sha,
    branch
  });
}

async function createPost({ title, content, image = '', video = '' }) {
  const { posts, sha } = await readCatalog();
  const now = new Date().toISOString();
  const post = {
    id: `post-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(title || '').trim(),
    content: String(content || ''),
    image: image || '',
    video: video || '',
    date: now.slice(0, 10),
    updatedAt: now
  };
  if (!post.title || !post.content.trim()) throw new Error('Title and content are required.');
  posts.push(post);
  await writePosts(posts, sha, `Add blog post: ${post.title}`);
  return post;
}

async function updatePost(id, patch) {
  const { posts, sha } = await readCatalog();
  const index = posts.findIndex(p => String(p.id) === String(id));
  if (index < 0) throw new Error('Blog post not found.');
  const current = posts[index];
  const updated = {
    ...current,
    ...patch,
    id: current.id,
    updatedAt: new Date().toISOString()
  };
  if (!String(updated.title || '').trim() || !String(updated.content || '').trim()) {
    throw new Error('Title and content are required.');
  }
  posts[index] = updated;
  await writePosts(posts, sha, `Update blog post: ${updated.title}`);
  return updated;
}

async function deletePost(id) {
  const { posts, sha } = await readCatalog();
  const index = posts.findIndex(p => String(p.id) === String(id));
  if (index < 0) throw new Error('Blog post not found.');
  const [removed] = posts.splice(index, 1);
  await writePosts(posts, sha, `Delete blog post: ${removed.title || removed.id}`);
  return removed;
}

module.exports = { listPosts, createPost, updatePost, deletePost };
