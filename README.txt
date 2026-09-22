JABARI PROMOTER — RESTORE WEBSITE BUTTONS + KEEP WEB3 AUTOMATION

The deployed bot had Web3 Automation but the Website Home/About/Shop/Reviews buttons disappeared because the deployed bot.js was from a Web3-only integration and no longer contained the earlier website-management menu.

This bot.js restores:
- Website Blog
- Website Shop
- Website Reviews
- Website About
- Website Home
- Web3 Automation
- Existing Campaigns, Contacts, Promote, Scanner, Status, Test Email

IMPORTANT:
1. Replace ONLY bot.js in jabarixai-dev/Jabari_Promoter with this bot.js.
2. The root web3-automation.js is included too; replace it only if your existing root file is missing/different.
3. Do not delete lib/website/.
4. Do not change your existing Render environment variables.
5. Keep JABARI_SITE_URL configured.
6. Commit to main and let Render deploy.

Expected root structure:
Jabari_Promoter/
  bot.js
  web3-automation.js
  lib/website/
    blog.js
    shop.js
    reviews.js
    about.js
    home.js

The website-management modules are already in the repository and are not removed by this fix.
