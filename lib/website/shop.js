const https = require('https');

const owner = process.env.GITHUB_OWNER || 'jabarixai-dev';
const repo = process.env.GITHUB_REPO || 'Jabari';
const branch = process.env.GITHUB_BRANCH || 'main';
const token = process.env.GITHUB_TOKEN || '';
const catalogPath = 'shop/products.json';

function request(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!token) return reject(new Error('GITHUB_TOKEN is not configured.'));
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: {
        'User-Agent': 'Jabari-Promoter-Shop',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {})
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

async function readCatalog() {
  const r = await request(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${catalogPath}?ref=${encodeURIComponent(branch)}`
  );

  const products = JSON.parse(
    Buffer.from(String(r.content || '').replace(/\n/g, ''), 'base64').toString('utf8')
  );

  if (!Array.isArray(products)) {
    throw new Error('shop/products.json is not a valid array.');
  }

  return { products, sha: r.sha };
}

async function writeCatalog(products, sha, message) {
  return request(
    'PUT',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${catalogPath}`,
    {
      message,
      content: Buffer.from(JSON.stringify(products, null, 2) + '\n', 'utf8').toString('base64'),
      sha,
      branch
    }
  );
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
}

function uniqueSlug(title, products, currentSlug = '') {
  const base = slugify(title) || 'product';
  let slug = base;
  let n = 2;

  while (products.some(p => p.slug === slug && p.slug !== currentSlug)) {
    slug = `${base}-${n++}`;
  }

  return slug;
}

function uniquePdfName(originalName) {
  const base = String(originalName || 'product.pdf')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  const stem = base.toLowerCase().endsWith('.pdf')
    ? base.slice(0, -4)
    : base;

  return `${slugify(stem) || 'product'}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.pdf`;
}

async function listProducts() {
  const { products } = await readCatalog();
  return products;
}

async function uploadPdf(buffer, originalName = 'product.pdf') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('PDF data is empty.');
  }

  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error('PDF is too large. Please send a PDF under 10 MB.');
  }

  const filename = uniquePdfName(originalName);

  await request(
    'PUT',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/shop/files/${encodeURIComponent(filename)}`,
    {
      message: `Add shop product PDF: ${filename}`,
      content: buffer.toString('base64'),
      branch
    }
  );

  return filename;
}

async function saveProduct({
  slug = '',
  title,
  desc,
  priceNaira,
  file = '',
  active = true
}) {
  const { products, sha } = await readCatalog();

  const cleanTitle = String(title || '').trim();
  const cleanDesc = String(desc || '').trim();
  const price = Number(priceNaira);

  if (!cleanTitle || !cleanDesc || !Number.isFinite(price) || price <= 0) {
    throw new Error('Title, description and valid price are required.');
  }

  const newSlug = uniqueSlug(cleanTitle, products, slug);

  if (slug) {
    const index = products.findIndex(p => p.slug === slug);

    if (index < 0) {
      throw new Error('Product not found.');
    }

    const old = products[index];

    products[index] = {
      ...old,
      slug: newSlug,
      title: cleanTitle,
      desc: cleanDesc,
      priceNaira: Math.round(price),
      priceKobo: Math.round(price * 100),
      file: file || old.file,
      contentType: 'application/pdf',
      active
    };
  } else {
    if (!file) {
      throw new Error('A PDF is required for a new product.');
    }

    products.push({
      slug: newSlug,
      title: cleanTitle,
      desc: cleanDesc,
      priceNaira: Math.round(price),
      priceKobo: Math.round(price * 100),
      file,
      contentType: 'application/pdf',
      active
    });
  }

  await writeCatalog(
    products,
    sha,
    slug ? `Update shop product: ${newSlug}` : `Add shop product: ${newSlug}`
  );

  return products.find(p => p.slug === newSlug);
}

async function toggleProduct(slug) {
  const { products, sha } = await readCatalog();
  const product = products.find(p => p.slug === slug);

  if (!product) throw new Error('Product not found.');

  product.active = product.active === false;

  await writeCatalog(
    products,
    sha,
    `${product.active ? 'Activate' : 'Deactivate'} shop product: ${slug}`
  );

  return product;
}

async function deleteProduct(slug) {
  const { products, sha } = await readCatalog();
  const index = products.findIndex(p => p.slug === slug);

  if (index < 0) throw new Error('Product not found.');

  const [removed] = products.splice(index, 1);

  await writeCatalog(
    products,
    sha,
    `Delete shop product: ${slug}`
  );

  return removed;
}

module.exports = {
  listProducts,
  uploadPdf,
  saveProduct,
  toggleProduct,
  deleteProduct
};
