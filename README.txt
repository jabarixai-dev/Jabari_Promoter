Jabari Gemini Integration v2

What changed:
- Added automatic retry for temporary Gemini 429/500/503/504 errors.
- Retry delays: 3s, 7s, 15s.
- Added automatic model fallback if the primary model remains unavailable.
- Fallback order: GEMINI_MODEL -> GEMINI_FALLBACK_MODEL (default gemini-3.7-flash) -> gemini-3.6-flash.
- No new npm package is required.
- Existing Telegram, Gmail, Supabase, campaigns, contacts, and scanner code is preserved.

Deployment:
1. Replace the existing bot.js in the GitHub repository with this bot.js.
2. Commit the change.
3. Let Render redeploy.
4. Do not change or delete existing environment variables.
5. GEMINI_FALLBACK_MODEL is optional; you do not need to add it.
6. Test Telegram -> /start -> AI Writer -> Generate Draft.

The article is still saved as a draft and is NOT automatically published.
