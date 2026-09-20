(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const config = window.JABARI_CONFIG || {};
  let supabase = null;
  let categories = [];
  let autopilot = null;

  function showLogin(message = "", isError = false) {
    const el = $("loginMsg");
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? "#b42318" : "#16794c";
  }

  function showStatus(message = "", isError = false) {
    const el = $("statusMsg");
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? "#b42318" : "#16794c";
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[char]));
  }

  function slugify(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "-")
      .replace(/-+/g, "-");
  }

  function setLoginBusy(busy) {
    const button = document.querySelector('#loginForm button[type="submit"]');
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? "Signing in…" : "Sign in";
  }

  function setPanels(loggedIn) {
    const loginPanel = $("loginPanel");
    const adminPanel = $("adminPanel");
    if (loginPanel) loginPanel.hidden = loggedIn;
    if (adminPanel) adminPanel.hidden = !loggedIn;
  }

  function dependencyCheck() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("Supabase JavaScript library did not load. Please refresh the page and try again.");
    }

    if (!config.SUPABASE_URL || !config.SUPABASE_KEY) {
      throw new Error("Supabase configuration is missing. Check assets/config.js.");
    }
  }

  function createSupabaseClient() {
    dependencyCheck();
    return window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    });
  }

  async function getCurrentUser() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    return data?.user || null;
  }

  async function isAdmin(user) {
    if (!user?.id) return false;

    const { data, error } = await supabase
      .from("media_admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) throw error;
    return !!data;
  }

  async function loadCategories() {
    const { data, error } = await supabase
      .from("media_categories")
      .select("id,name,slug")
      .order("name");

    if (error) throw error;

    categories = data || [];
    const options = categories
      .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
      .join("");

    $("articleCategory").innerHTML = options;
    $("topicCategory").innerHTML = `<option value="">No category</option>${options}`;
  }

  async function loadArticles() {
    const { data, error } = await supabase
      .from("media_articles")
      .select("id,title,slug,status,article_type,published_at,updated_at,media_categories(name)")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const articles = data || [];
    $("publishedCount").textContent = articles.filter((x) => x.status === "published").length;
    $("draftCount").textContent = articles.filter((x) => x.status === "draft" || x.status === "review").length;

    $("articles").innerHTML = articles.length
      ? articles.map((article) => `
          <div class="articleRow">
            <div class="articleMeta">
              <strong>${esc(article.title)}</strong>
              <small>${esc(article.media_categories?.name || "Uncategorised")} · ${esc(article.status)}</small>
            </div>
            <div class="articleActions">
              <button class="secondary editArticle" data-id="${article.id}">Edit</button>
              ${article.status === "draft" || article.status === "review" ? `<button class="danger deleteDraft" data-id="${article.id}">Delete</button>` : ""}
            </div>
          </div>
        `).join("")
      : "<p class='muted'>No articles yet.</p>";

    document.querySelectorAll(".editArticle").forEach((button) => {
      button.onclick = () => editArticle(button.dataset.id);
    });

    document.querySelectorAll(".deleteDraft").forEach((button) => {
      button.onclick = () => deleteDraft(button.dataset.id);
    });
  }

  async function loadTopics() {
    const { data, error } = await supabase
      .from("media_topics")
      .select("id,topic,status,priority,media_categories(name)")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const topics = data || [];
    $("topicCount").textContent = topics.filter((x) => x.status === "queued").length;

    $("topics").innerHTML = topics.length
      ? topics.map((topic) => `
          <div class="topic">
            <div>
              <strong>${esc(topic.topic)}</strong>
              <div class="muted">${esc(topic.media_categories?.name || "No category")} · ${esc(topic.status)}</div>
            </div>
            <button class="secondary deleteTopic" data-id="${topic.id}">Delete</button>
          </div>
        `).join("")
      : "<p class='muted'>No topics yet.</p>";

    document.querySelectorAll(".deleteTopic").forEach((button) => {
      button.onclick = () => deleteTopic(button.dataset.id);
    });
  }

  async function loadAutopilot() {
    const { data, error } = await supabase
      .from("media_autopilot")
      .select("*")
      .eq("id", 1)
      .single();

    if (error) throw error;
    autopilot = data;
    renderAutopilot();
  }

  function renderAutopilot() {
    const on = !!autopilot?.enabled;
    $("autoState").textContent = on ? "ON" : "OFF";
    $("autoLabel").textContent = on ? "Autopilot is ON" : "Autopilot is OFF";
    $("autoDescription").textContent = on
      ? "Automation is allowed to run."
      : "No automatic publishing will run.";
    $("autoBtn").textContent = on ? "Turn OFF" : "Turn ON";
    $("autoBtn").className = on ? "secondary" : "danger";
    $("autoMode").value = autopilot?.mode || "review";
    $("autoFrequency").value = autopilot?.publishing_frequency || "daily";
  }

  async function editArticle(id) {
    const { data, error } = await supabase
      .from("media_articles")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      showStatus(error.message, true);
      return;
    }

    $("articleId").value = data.id;
    $("articleTitle").value = data.title || "";
    $("articleSlug").value = data.slug || "";
    $("articleExcerpt").value = data.excerpt || "";
    $("articleCategory").value = data.category_id || categories[0]?.id || "";
    $("articleType").value = data.article_type || "article";
    $("articleImage").value = data.featured_image || "";
    $("articleContent").value = data.content || "";
    $("seoTitle").value = data.seo_title || "";
    $("metaDescription").value = data.meta_description || "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetArticle() {
    $("articleId").value = "";
    $("articleTitle").value = "";
    $("articleSlug").value = "";
    $("articleExcerpt").value = "";
    $("articleCategory").value = categories[0]?.id || "";
    $("articleType").value = "article";
    $("articleImage").value = "";
    $("articleContent").value = "";
    $("seoTitle").value = "";
    $("metaDescription").value = "";
  }

  async function handleLogin(event) {
    event.preventDefault();
    showLogin("");
    setLoginBusy(true);

    try {
      dependencyCheck();

      const email = $("email").value.trim();
      const password = $("password").value;

      if (!email || !password) {
        throw new Error("Enter your admin email and password.");
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;
      if (!data?.user) throw new Error("Supabase did not return a signed-in user.");

      const authorized = await isAdmin(data.user);

      if (!authorized) {
        await supabase.auth.signOut();
        throw new Error("Login succeeded, but this account is not authorized as a Jabari Media admin.");
      }

      showLogin("Login successful. Loading dashboard…");
      await boot();
    } catch (error) {
      console.error("Jabari Media admin login error:", error);
      showLogin(error?.message || String(error), true);
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleArticleSubmit(event) {
    event.preventDefault();

    try {
      const status = event.submitter?.dataset.status || "draft";
      const title = $("articleTitle").value.trim();

      if (!title) {
        showStatus("Enter an article title.", true);
        return;
      }

      const payload = {
        title,
        slug: slugify($("articleSlug").value) || slugify(title),
        excerpt: $("articleExcerpt").value.trim(),
        content: $("articleContent").value,
        category_id: $("articleCategory").value || null,
        author_id: null,
        featured_image: $("articleImage").value.trim() || null,
        status,
        article_type: $("articleType").value,
        seo_title: $("seoTitle").value.trim() || title,
        meta_description: $("metaDescription").value.trim() || $("articleExcerpt").value.trim(),
        published_at: status === "published" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };

      showStatus("Saving…");

      const result = $("articleId").value
        ? await supabase.from("media_articles").update(payload).eq("id", $("articleId").value)
        : await supabase.from("media_articles").insert(payload);

      if (result.error) throw result.error;

      showStatus(status === "published" ? "Article published." : "Draft saved.");
      resetArticle();
      await loadArticles();
    } catch (error) {
      console.error(error);
      showStatus(error?.message || String(error), true);
    }
  }

  async function deleteDraft(id) {
    const article = await supabase
      .from("media_articles")
      .select("id,title,status")
      .eq("id", id)
      .maybeSingle();

    if (article.error) {
      showStatus(article.error.message, true);
      return;
    }

    if (!article.data) {
      showStatus("Draft not found.", true);
      return;
    }

    if (article.data.status !== "draft" && article.data.status !== "review") {
      showStatus("Only drafts can be deleted here.", true);
      return;
    }

    if (!confirm(`Delete this draft?\n\n${article.data.title}`)) return;

    const { error } = await supabase
      .from("media_articles")
      .delete()
      .eq("id", id)
      .in("status", ["draft", "review"]);

    if (error) {
      showStatus(error.message, true);
      return;
    }

    if ($("articleId").value === String(id)) resetArticle();
    showStatus("Draft deleted.");
    await loadArticles();
  }

  async function handleTopicSubmit(event) {
    event.preventDefault();

    try {
      const topic = $("topicInput").value.trim();
      if (!topic) return;

      const { error } = await supabase.from("media_topics").insert({
        topic,
        category_id: $("topicCategory").value || null,
        status: "queued"
      });

      if (error) throw error;

      $("topicInput").value = "";
      showStatus("Topic added.");
      await loadTopics();
    } catch (error) {
      showStatus(error?.message || String(error), true);
    }
  }

  async function deleteTopic(id) {
    if (!confirm("Delete this topic?")) return;

    const { error } = await supabase
      .from("media_topics")
      .delete()
      .eq("id", id);

    if (error) {
      showStatus(error.message, true);
      return;
    }

    await loadTopics();
  }

  async function toggleAutopilot() {
    try {
      const { data, error } = await supabase
        .from("media_autopilot")
        .update({
          enabled: !autopilot.enabled,
          updated_at: new Date().toISOString()
        })
        .eq("id", 1)
        .select("*")
        .single();

      if (error) throw error;

      autopilot = data;
      renderAutopilot();
      showStatus(autopilot.enabled ? "Autopilot turned ON." : "Autopilot turned OFF.");
    } catch (error) {
      showStatus(error?.message || String(error), true);
    }
  }

  async function updateAuto(field, value) {
    try {
      const { data, error } = await supabase
        .from("media_autopilot")
        .update({
          [field]: value,
          updated_at: new Date().toISOString()
        })
        .eq("id", 1)
        .select("*")
        .single();

      if (error) throw error;
      autopilot = data;
      renderAutopilot();
      showStatus("Autopilot settings saved.");
    } catch (error) {
      showStatus(error?.message || String(error), true);
    }
  }

  async function boot() {
    try {
      dependencyCheck();

      const user = await getCurrentUser();

      if (!user) {
        setPanels(false);
        return;
      }

      const authorized = await isAdmin(user);

      if (!authorized) {
        setPanels(false);
        showLogin("This account is signed in but is not an authorized Jabari Media admin.", true);
        return;
      }

      setPanels(true);
      showLogin("");

      await loadCategories();
      await loadArticles();
      await loadTopics();
      await loadAutopilot();
    } catch (error) {
      console.error("Jabari Media admin boot error:", error);
      setPanels(false);
      showLogin(error?.message || String(error), true);
    }
  }

  function wireEvents() {
    $("loginForm")?.addEventListener("submit", handleLogin);
    $("logoutBtn")?.addEventListener("click", async () => {
      try {
        await supabase.auth.signOut();
      } finally {
        location.reload();
      }
    });
    $("newArticleBtn")?.addEventListener("click", resetArticle);
    $("articleForm")?.addEventListener("submit", handleArticleSubmit);
    $("topicForm")?.addEventListener("submit", handleTopicSubmit);
    $("autoBtn")?.addEventListener("click", toggleAutopilot);
    $("autoMode")?.addEventListener("change", (event) => updateAuto("mode", event.target.value));
    $("autoFrequency")?.addEventListener("change", (event) => updateAuto("publishing_frequency", event.target.value));
  }

  async function start() {
    try {
      dependencyCheck();
      supabase = createSupabaseClient();
      wireEvents();
      await boot();
    } catch (error) {
      console.error("Jabari Media admin startup error:", error);
      setPanels(false);
      showLogin(error?.message || String(error), true);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
