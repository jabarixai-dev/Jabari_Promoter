JABARI WEBSITE HOME MANAGER

This update adds Website Home management to Telegram and connects the public website to the same GitHub Home data.

TELEGRAM BOT
------------
Repository: jabarixai-dev/Jabari_Promoter
Files to upload/replace:
- bot.js
- lib/website/home.js

The bot keeps the existing Website Blog, Shop, Reviews and About managers and adds:
- 🏠 Website Home
- Edit Home Text
- Social Links
- Home Buttons
- Change Logo
- Preview

WEBSITE REPOSITORY
------------------
Repository: jabarixai-dev/Jabari
Files to upload/replace:
- index.html
- home/content.json

The public website now reads Home content from:
home/content.json

The embedded Home content remains as the immediate fallback, so the page does not wait for GitHub before displaying.

LOGO
----
The current embedded logo remains the fallback. Telegram's Change Logo option uploads a new logo to home-media/ and then updates home/content.json.

ENVIRONMENT VARIABLES
---------------------
No new environment variables are required. The bot uses the existing:
- GITHUB_TOKEN
- GITHUB_OWNER
- GITHUB_REPO
- GITHUB_BRANCH

IMPORTANT
---------
Do not create another GitHub repository.
Do not remove the existing Blog, Shop, Reviews or About files.
Upload home/content.json to the website repo before testing public Home editing.
