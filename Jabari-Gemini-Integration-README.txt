JABARI GEMINI INTEGRATION

1. Replace the existing bot.js in the GitHub repo with the included bot.js.
2. Do NOT change or remove any existing Render environment variables.
3. GEMINI_API_KEY must already exist in Render (it does from the setup).
4. No Gemini key is stored in this file.
5. No new npm package is required; this integration uses Node's built-in fetch.
6. After Render deploys, open the Telegram bot and tap /start.
7. A new "🤖 AI Writer" button will appear.
8. Your queued media topic will appear there.
9. Tap "✨ Generate Draft".
10. The bot asks Gemini to generate structured article data and saves it to media_articles with status="draft".
11. The topic is marked used only after the article is successfully saved.
12. The article is NOT published automatically.

Important:
- Do not paste the Gemini API key into GitHub.
- Do not turn Autopilot on yet.
- This first version does not perform live web research/grounding. It is a draft-generation test.
