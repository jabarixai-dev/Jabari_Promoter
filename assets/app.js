const c = window.JABARI_CONFIG || {};
const ready = !!(c.SUPABASE_URL && c.SUPABASE_KEY);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (x) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;"
}[x]));

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "-")
    .replace(/-+/g, "-");
}

async function api(path) {
  if (!ready) throw new Error("Supabase is not configured.");

  const r = await fetch(c.SUPABASE_URL + "/rest/v1/" + path, {
    headers: {
      apikey: c.SUPABASE_KEY,
      Authorization: "Bearer " + c.SUPABASE_KEY
    }
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Supabase request failed (${r.status})${text ? `: ${text}` : ""}`);
  }

  return r.json();
}

function card(a) {
  return `<a class="card" href="article.html?slug=${encodeURIComponent(a.slug)}">
    ${a.featured_image
      ? `<img src="${esc(a.featured_image)}" alt="${esc(a.title)}">`
      : "<div class='ph'>Jabari</div>"}
    <div>
      <small>${esc(a.media_categories?.name || "Jabari")}</small>
      <h3>${esc(a.title)}</h3>
      <p>${esc(a.excerpt || "")}</p>
    </div>
  </a>`;
}

function setActiveNav(page, categoryName = "") {
  const links = document.querySelectorAll("header nav a");
  const currentCategory = String(categoryName || "").trim().toLowerCase();

  links.forEach((link) => {
    link.classList.remove("active");
    link.removeAttribute("aria-current");

    const href = link.getAttribute("href") || "";
    let active = false;

    if (page === "home" && href === "index.html") active = true;
    if (page === "about" && href === "about.html") active = true;
    if (page === "search" && href === "search.html") active = true;

    if (page === "category") {
      const match = href.match(/category=([^&]+)/i);
      if (match && decodeURIComponent(match[1]).toLowerCase() === currentCategory) active = true;
    }

    if (page === "article" && currentCategory) {
      const match = href.match(/category=([^&]+)/i);
      if (match && decodeURIComponent(match[1]).toLowerCase() === currentCategory) active = true;
    }

    if (active) {
      link.classList.add("active");
      link.setAttribute("aria-current", "page");
    }
  });
}

function showGridMessage(message) {
  const grid = document.querySelector("#grid");
  if (grid) grid.innerHTML = `<p class="status-message">${esc(message)}</p>`;
}

async function loadCategory() {
  const params = new URLSearchParams(location.search);
  const cat = params.get("category") || "News";
  const slug = slugify(cat);

  const title = document.querySelector("#title");
  const desc = document.querySelector("#desc");
  if (title) title.textContent = cat;
  if (desc) desc.textContent = "Stories from " + cat + ".";

  setActiveNav("category", cat);

  const categories = await api(`media_categories?select=id,name,slug&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  const category = categories[0];

  if (!category) {
    showGridMessage(`The ${cat} category has not been created yet.`);
    return;
  }

  const articles = await api(
    `media_articles?select=*,media_categories(name)&status=eq.published&category_id=eq.${encodeURIComponent(category.id)}&order=published_at.desc&limit=100`
  );

  const grid = document.querySelector("#grid");
  if (grid) {
    grid.innerHTML = articles.length
      ? articles.map(card).join("")
      : "<p class='status-message'>No published stories in this category yet.</p>";
  }
}

async function loadHome() {
  setActiveNav("home");
  const d = await api("media_articles?select=*,media_categories(name)&status=eq.published&order=published_at.desc&limit=6");
  const latest = document.querySelector("#latest");
  if (latest) latest.innerHTML = d.length ? d.map(card).join("") : "<p>No published stories yet.</p>";
}

async function loadArticle() {
  const slug = new URLSearchParams(location.search).get("slug");
  const el = document.querySelector("#article");
  if (!slug) {
    if (el) el.innerHTML = "<p>Article not found.</p>";
    return;
  }

  const d = await api(
    `media_articles?select=*,media_categories(name),media_authors(name)&status=eq.published&slug=eq.${encodeURIComponent(slug)}&limit=1`
  );
  const a = d[0];

  if (!a) {
    if (el) el.innerHTML = "<p>Article not found.</p>";
    return;
  }

  setActiveNav("article", a.media_categories?.name || "");
  document.title = a.title + " — Jabari";

  if (el) {
    el.innerHTML = `<section class="articlehead">
      <small>${esc(a.media_categories?.name || "Jabari")}</small>
      <h1>${esc(a.title)}</h1>
      <p>${esc(a.excerpt || "")}</p>
    </section>
    ${a.featured_image ? `<img class="articleimg" src="${esc(a.featured_image)}" alt="${esc(a.title)}">` : ""}
    <div class="content">${a.content || ""}</div>`;
  }
}

function setupSearch() {
  setActiveNav("search");
  const form = document.querySelector("#search");
  if (!form) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = document.querySelector("#q").value.trim().toLowerCase();
    const results = document.querySelector("#results");
    if (!q) {
      if (results) results.innerHTML = "<p>Enter a search term.</p>";
      return;
    }

    if (results) results.innerHTML = "<p>Searching…</p>";
    const d = await api("media_articles?select=*,media_categories(name)&status=eq.published&order=published_at.desc&limit=100");
    const matches = d.filter((a) => (a.title + " " + (a.excerpt || "")).toLowerCase().includes(q));
    if (results) results.innerHTML = matches.map(card).join("") || "<p>No matching stories.</p>";
  };
}

async function run() {
  const page = document.body?.dataset?.page || (() => {
    const last = location.pathname.split("/").pop() || "index.html";
    return last.split("?")[0].replace(".html", "") || "index";
  })();

  try {
    if (page === "index") return await loadHome();
    if (page === "category") return await loadCategory();
    if (page === "article") return await loadArticle();
    if (page === "search") return setupSearch();
    if (page === "about") return setActiveNav("about");
  } catch (e) {
    console.error("Jabari Media page error:", e);
    const target = document.querySelector("#grid, #latest, #article, #results");
    if (target) target.innerHTML = `<p class="status-message error-message">Could not load this page right now. Please refresh and try again.</p>`;
  }
}

run();
