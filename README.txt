Jabari Gemini Research + Writer v3

WHAT THIS VERSION ADDS
- Keeps the working Gemini retry + fallback system.
- Adds a free public-web research layer using Google News RSS.
- Finds up to 6 recent public news/search results for each topic.
- Attempts to fetch each source page and extracts readable text when available.
- Sends the research material to Gemini before writing the article.
- Saves the discovered source records into media_sources.
- Saves generated tags into media_tags and media_article_tags.
- Keeps the article as DRAFT. It is not auto-published.
- Marks the topic as used only after the article is saved.

IMPORTANT
- No new npm package is required.
- Do not change or remove your existing Render environment variables.
- Do not add your Gemini API key to the code.
- Do not turn Autopilot on yet.
- Research is not a guarantee that every source page can be fetched; some sites block automated requests. The bot still keeps the RSS title/summary/source URL when available.
- The research layer uses public RSS/search results rather than Gemini Google Search grounding, so it does not require enabling a paid Gemini grounding feature.

INSTALL
1. Replace your current bot.js in GitHub with the bot.js in this ZIP.
2. Commit the change.
3. Let Render redeploy.
4. Telegram -> /start -> AI Writer -> Generate Draft.

EXPECTED RESULT
The bot should show:
- Draft created
- Status: Draft
- Research sources saved: N

Then open the Jabari Media Admin dashboard and review the article and its sources before publishing.
