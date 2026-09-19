JABARI PROMOTER — BUTTON NAVIGATION UPDATE

1. Open Supabase SQL Editor.
2. Run migration.sql ONCE.
3. Replace your GitHub bot.js with the bot.js in this ZIP.
4. Commit/push to GitHub.
5. Manually deploy the latest commit on Render.
6. Do not change your existing Render environment variables.
7. Test /start.

The new bot keeps commands as backups, but normal navigation uses buttons.
Campaigns are now multiple saved campaigns. Creating a new campaign does NOT
require deleting the active campaign. One campaign can be active at a time.

Main flow:
Main Menu -> Campaigns / Contacts / Promote / Status / Test Email
Campaigns -> Create New / View Campaigns / Active Campaign
Campaign detail -> Make Active / Edit / Delete
Contacts -> Add / View / Delete
Promote -> Review active campaign -> Confirm -> Send
