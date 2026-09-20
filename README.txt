Jabari Media — Source-Backed AI Writer v4

Replace the current bot.js with the included bot.js.

What changed:
- Keeps the working research + Gemini pipeline.
- Requires factual claims to be supported by supplied research sources.
- Gemini places [1], [2], etc. markers immediately after supported claims.
- Jabari converts those markers into clickable numbered citations.
- A Sources section is appended to the article using only sources actually cited.
- Invalid source numbers are removed.
- Telegram reports how many research sources were found and how many were cited.
- Articles remain Draft; nothing is auto-published.
- Existing Gmail, scanner, campaigns, contacts, Supabase and Gemini retry/fallback features are preserved.
- No new npm dependency is required.
- Do not change or paste any Render secrets.

Test:
1. Replace bot.js in GitHub.
2. Commit and let Render redeploy.
3. Add a fresh queued topic in Jabari Media Admin.
4. Telegram -> /start -> AI Writer -> Generate Draft.
5. Open the draft in Admin and inspect the numbered Sources section.
