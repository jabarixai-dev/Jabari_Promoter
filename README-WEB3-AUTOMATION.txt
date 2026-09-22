JABARI WEB3 AUTOMATION — PHASE 2

This package adds the first working automation layer without creating a new repository.

WHAT IT DOES
1. Opportunity discovery runs hourly.
   - Searches public Web3/crypto opportunity headlines.
   - Classifies candidates as alpha, bounty or money_making.
   - Stores candidates in Supabase promoter_opportunities.

2. News runs every 5 hours.
   - Searches current Web3 news.
   - Gemini compiles one article.
   - Publishes it to the existing Jabari blog/posts.json.
   - News is NOT automatically promoted.

3. Opportunity publishing runs in three daily slots.
   - Morning: 09:00 Africa/Lagos
   - Afternoon: 15:00 Africa/Lagos
   - Night: 21:00 Africa/Lagos
   - Publishes one stored opportunity per slot.
   - If automation promotion is enabled and the bot is in LIVE mode, it can promote the published opportunity to the existing consented email contacts.

4. Every automated article receives a stable hash share URL:
   SITE/#blog/<article-slug>

5. Blog now has an article detail view with Share Article and Copy Link buttons.
   Advertisement placeholders exist ONLY on the article view, so ads can later be connected to Blog pages without putting ads on Home/About/Shop/Reviews.

IMPORTANT ENVIRONMENT VARIABLE
Add this to the Render Jabari Promoter service:
JABARI_SITE_URL=https://YOUR-ACTUAL-JABARI-NETLIFY-SITE

Keep the existing variables. No new Supabase project is needed.

REQUIRED EXISTING VARIABLES
PROMOTER_SUPABASE_URL
PROMOTER_SUPABASE_SERVICE_ROLE_KEY
GITHUB_TOKEN
GITHUB_OWNER=jabarixai-dev
GITHUB_REPO=Jabari
GITHUB_BRANCH=main
GEMINI_API_KEY
TELEGRAM_BOT_TOKEN
BOT_OWNER_ID
MODE=dry-run or live

DEPLOY
Replace bot.js in the existing Jabari_Promoter repository and add web3-automation.js beside it.
Do NOT create another repository.

WEBSITE
Replace the website's current index.html with the included index.html only if it is the same current version you have been using. This version adds the article route/share UI while preserving the existing Shop/Home/Blog structure from the supplied current file.

AUTOMATION CONTROL
Telegram main menu now includes: 🤖 Web3 Automation
From there you can:
- Turn automation ON/OFF
- Run opportunity scan now
- Publish news now
- Publish an opportunity now
- Refresh status

SAFETY / EDITORIAL
The discovery layer only uses publicly accessible search/RSS results. Gemini is instructed not to invent rewards, eligibility, deadlines or income claims. Opportunity articles should tell readers to verify details at the original source when the supplied research does not establish them.

NOTE
The Supabase foundation migration already created promoter_automation_settings, promoter_opportunities and promoter_automation_runs. The latest migration also adds last_opportunity_publish_slot for daily-slot deduplication.
