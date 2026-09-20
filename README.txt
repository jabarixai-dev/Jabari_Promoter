Jabari Autopilot v2 — Telegram Control + Persistent Scheduler

WHAT THIS VERSION DOES
- Keeps Telegram as the main control center.
- Adds a persistent private worker secret in Supabase.
- Adds POST /automation-worker to the Render bot.
- Adds a Supabase Cron job that wakes the Render worker every minute.
- The worker checks the saved Autopilot state before doing anything.
- Manual Run Now executes the complete current pipeline when Mode is Full Auto.
- Review mode generates a draft but does not publish it.
- Full Auto publishes and promotes after generation.
- Manual frequency disables scheduled execution.
- Removes the old in-process setInterval scheduler to avoid duplicate runs.

DEPLOY
1. Replace your current bot.js in GitHub with this bot.js.
2. Add the SQL migration file under supabase/migrations/.
3. Commit and push both files.
4. Let Render redeploy the bot.
5. Let your existing Supabase GitHub migration workflow deploy the SQL migration.

IMPORTANT
- Do NOT change or paste any existing secrets.
- The worker secret is generated automatically by the bot on startup and stored in media_worker_config.
- The SQL migration contains no secret.
- The cron job runs every minute, but it does not mean an article is generated every minute. It only wakes the worker; the saved Autopilot frequency controls when a run is actually allowed.

FIRST TEST
1. Telegram → Jabari Media → Autopilot.
2. Set Mode to Full Auto.
3. Set Frequency to Manual first.
4. Press Run Now. It should research → generate → publish → prepare promotion → promote using the existing contacts.
5. Then set Frequency to Daily.
6. Turn Autopilot ON.
7. The next_run_at value will be set and the scheduler will invoke the worker every minute until the scheduled time arrives.

CURRENT LIMITATION
The current automatic pipeline uses the contacts already in the Promoter contacts list. The existing website scanner is still a manual discovery tool. A separate autonomous public-web contact discovery engine should be added before claiming that the system can discover new contacts automatically for every article.
