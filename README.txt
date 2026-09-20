JABARI TELEGRAM MEDIA CONTROL v1

This version makes Telegram the primary control center for Jabari Media.

FEATURES
- 🤖 Jabari Media menu in Telegram
- Add topics from Telegram
- View topics
- Generate next article manually
- Generate a selected topic manually
- Research topic before generation using public Google News RSS results
- Save researched article as a draft in media_articles
- View drafts from Telegram
- Publish drafts from Telegram
- Delete drafts from Telegram
- Prepare a published article for promotion from Telegram
- Autopilot ON/OFF stored in Supabase media_autopilot
- Manual Run Now button
- Review/full_auto mode toggle
- Manual/daily/twice_daily/weekly frequency toggle
- Persistent automation state in Supabase
- Automatic worker checks the persisted state every minute
- Full Auto: research -> generate -> publish -> prepare promotion -> promote

IMPORTANT
1. Replace your existing bot.js with this file.
2. Do NOT remove or change existing Render environment variables.
3. GEMINI_API_KEY is read from Render environment variables. It is not stored in this file.
4. No new npm package is required; the code uses Node's built-in fetch.
5. Keep the existing package.json because the bot still needs googleapis and the other existing dependencies.
6. After Render deploys, open Telegram and press /start.
7. Choose 🤖 Jabari Media.

AUTOPILOT SAFETY
- Default database mode remains review unless you change it.
- Turning ON does not publish immediately unless mode is full_auto and a queued topic is available.
- Run Now always performs one manual article-generation cycle.
- Full Auto publishes and promotes only after successful generation.
- Turning OFF persists immediately in media_autopilot.enabled.

AUTOMATIC SCHEDULING NOTE
The Render worker checks every minute while the Render service is running. Render free-tier services can sleep when idle, so truly continuous 24/7 automation may later need an external scheduler or a non-sleeping worker. The Telegram controls and persisted ON/OFF state are already in place.

NO DASHBOARD REQUIRED FOR NORMAL OPERATION
The Jabari Media dashboard can remain available for deep editing, but normal topic entry, generation, publishing, promotion, and Autopilot control can now be done from Telegram.
