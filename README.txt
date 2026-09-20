Jabari Autopilot v3 — Gemini resilience + retry buttons

Changes:
- Retries transient Gemini failures.
- Tries Gemini 3.8 Flash first, then 3.7 Flash, 3.6 Flash, and 3.5 Flash-Lite when the failure is transient.
- Removes the temperature parameter from the Gemini 3.8 request.
- Returns a topic to queued when a transient Gemini failure occurs.
- Shows a Telegram 🔄 Retry button after transient article-generation failures.
- Selected-topic generation has its own retry button.
- No new npm package is required.
- Do not change or remove existing Render environment variables.
- The existing Supabase migration is included only for reference; do not redeploy it if it is already deployed.

Deploy:
1. Replace the current GitHub bot.js with the included bot.js.
2. Commit and push.
3. Let Render deploy automatically.
4. Do not change Render environment variables.

Test:
🤖 Jabari Media → ✍️ Generate Next

If Gemini is temporarily overloaded, Telegram will show a Retry button and the topic will remain queued.
