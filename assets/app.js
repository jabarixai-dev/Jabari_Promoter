const config = window.JABARI_CONFIG || {};

const SUPABASE_URL = config.SUPABASE_URL;
const SUPABASE_KEY = config.SUPABASE_KEY;

const supabaseReady = Boolean(SUPABASE_URL && SUPABASE_KEY);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));

async function api(path) {
  if (!supabaseReady) {
    throw new Error("Supabase is not configured.");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: SUPABASE_KEY
      }
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Supabase request failed: ${response.status} ${errorText}`
    );
  }

  return response.json();
}

function card(article) {
  const category = article.media_categories?.name || "Jabari";

  return `
    <a class="card" href="article.html?slug=${encodeURIComponent(article.slug)}">
      ${
        article.featured_image
          ? `<img src="${esc(article.featured_image)}" alt="${esc(article.title)}">`
          : `<div class="ph">Jabari</div>`
      }

      <div>
        <small>${esc(category)}</small>
        <h3>${esc(article.title)}</h3>
        <p>${esc(article.excerpt || "")}</p>
      </div>
    </a>
  `;
}

async function loadHome() {
  const latest = document.querySelector("#latest");

  if (!latest) return;

  latest.innerHTML = "<p>Loading stories…</p>";

  const articles = await api(
    "media_articles" +
    "?select=*,media_categories(name)" +
    "&status=eq.published" +
    "&order=published_at.desc" +
    "&limit=6"
  );

  latest.innerHTML = articles.length
    ? articles.map(card).join("")
    : "<p>No published stories yet.</p>";
}

async function loadCategory() {
  const title = document.querySelector("#title");
  const description = document.querySelector("#desc");
  const grid = document.querySelector("#grid");

  if (!grid) return;

  const category =
    new URLSearchParams(location.search).get("category") || "News";

  if (title) {
    title.textContent = category;
  }

  if (description) {
    description.textContent = `Stories from ${category}.`;
  }

  grid.innerHTML = "<p>Loading stories…</p>";

  const articles = await api(
    "media_articles" +
    "?select=*,media_categories(name)" +
    "&status=eq.published" +
    "&order=published_at.desc" +
    "&limit=100"
  );

  const filtered = articles.filter(
    (article) =>
      (article.media_categories?.name || "").toLowerCase() ===
      category.toLowerCase()
  );

  grid.innerHTML = filtered.length
    ? filtered.map(card).join("")
    : "<p>No published stories yet.</p>";
}

async function loadArticle() {
  const articleContainer = document.querySelector("#article");

  if (!articleContainer) return;

  const slug = new URLSearchParams(location.search).get("slug");

  if (!slug) {
    articleContainer.innerHTML = "<p>Article not found.</p>";
    return;
  }

  articleContainer.innerHTML = "<p>Loading article…</p>";

  const articles = await api(
    "media_articles" +
    "?select=*,media_categories(name),media_authors(name)" +
    "&status=eq.published" +
    `&slug=eq.${encodeURIComponent(slug)}`
  );

  const article = articles[0];

  if (!article) {
    articleContainer.innerHTML = "<p>Article not found.</p>";
    return;
  }

  document.title = `${article.title} — Jabari`;

  articleContainer.innerHTML = `
    <section class="articlehead">
      <small>${esc(article.media_categories?.name || "Jabari")}</small>

      <h1>${esc(article.title)}</h1>

      <p>${esc(article.excerpt || "")}</p>

      ${
        article.media_authors?.name
          ? `<small>By ${esc(article.media_authors.name)}</small>`
          : ""
      }
    </section>

    ${
      article.featured_image
        ? `
          <img
            class="articleimg"
            src="${esc(article.featured_image)}"
            alt="${esc(article.title)}"
          >
        `
        : ""
    }

    <div class="content">
      ${article.content || ""}
    </div>
  `;
}

async function setupSearch() {
  const searchForm = document.querySelector("#search");

  if (!searchForm) return;

  searchForm.onsubmit = async (event) => {
    event.preventDefault();

    const input = document.querySelector("#q");
    const results = document.querySelector("#results");

    if (!input || !results) return;

    const query = input.value.trim().toLowerCase();

    if (!query) {
      results.innerHTML = "<p>Enter something to search.</p>";
      return;
    }

    results.innerHTML = "<p>Searching…</p>";

    const articles = await api(
      "media_articles" +
      "?select=*,media_categories(name)" +
      "&status=eq.published" +
      "&order=published_at.desc" +
      "&limit=100"
    );

    const matches = articles.filter((article) => {
      const searchableText = [
        article.title,
        article.excerpt,
        article.content,
        article.media_categories?.name
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return searchableText.includes(query);
    });

    results.innerHTML = matches.length
      ? matches.map(card).join("")
      : "<p>No matching stories.</p>";
  };
}

async function run() {
  try {
    const page =
      location.pathname.split("/").pop() || "index.html";

    if (!supabaseReady) {
      throw new Error("Supabase configuration is missing.");
    }

    if (page === "index.html") {
      await loadHome();
    }

    if (page === "category.html") {
      await loadCategory();
    }

    if (page === "article.html") {
      await loadArticle();
    }

    if (page === "search.html") {
      await setupSearch();
    }
  } catch (error) {
    console.error("Jabari Media error:", error);

    document
      .querySelectorAll(".grid, .article, #latest, #grid, #results")
      .forEach((element) => {
        element.innerHTML = `
          <p>
            Unable to load stories right now.
            Please try again shortly.
          </p>
        `;
      });
  }
}

run();
