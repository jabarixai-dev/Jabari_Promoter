Jabari Autopilot v5 — independent per-article promotion

Replace your current bot.js with this bot.js.

Add the migration:
supabase/migrations/20260920190000_media-independent-promotions.sql

IMPORTANT
- Do not change Render environment variables.
- Do not remove the existing media_worker_config table/migration.
- Do not delete the existing autopilot migration.
- The new migration creates per-article promotion tracking and schedules the worker every minute.
- The worker secret is read by the scheduled SQL from the existing media_worker_config row; you do not need to copy or send any secret.

NEW BEHAVIOR
1. Publishing and promotion are independent.
2. Autopilot publishing can run daily/twice daily/weekly as configured.
3. When an article is published, its own promotion job starts automatically.
4. Each article has a target of 50 successful recipients.
5. Promotion continues independently of the blog publishing schedule.
6. Turning the publishing Autopilot OFF does not stop already-active promotions.
7. Promotion stops automatically at 50 successful recipients.
8. Telegram can manually stop an article's promotion.
9. The same contact is not counted twice for the same article.
10. Failed sends do not count toward the 50 target and can be retried later.
11. Full Auto publishes and starts promotion; the promotion worker handles the actual sending separately.
12. Review mode still stops at a draft.

TELEGRAM
After publishing an article, Telegram shows Promotion Status.
Promotion Status shows:
- active/completed/stopped
- reached count / 50
- failed count
- Stop Promotion button while active

SCHEDULER
Supabase Cron invokes /automation-worker every minute. The worker checks the saved Autopilot state before publishing, but processes active article promotions independently.

Before enabling Full Auto, test with Review mode and one queued topic.
