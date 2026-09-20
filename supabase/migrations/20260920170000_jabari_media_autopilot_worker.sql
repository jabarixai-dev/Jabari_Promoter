-- Jabari Media: persistent automation worker
-- The Telegram bot creates the worker secret on first startup.
-- The secret is stored only in this private table and is never committed to GitHub.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.media_worker_config (
  id integer primary key check (id = 1),
  worker_secret text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.media_worker_config (id)
values (1)
on conflict (id) do nothing;

revoke all on table public.media_worker_config from anon, authenticated;
grant all on table public.media_worker_config to service_role;

-- Run every minute. The worker itself decides whether it is time to act,
-- based on media_autopilot.enabled, mode and publishing_frequency.
select cron.schedule(
  'jabari-media-autopilot-worker',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://jabari-promoter.onrender.com/automation-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-jabari-worker-secret',
          (select worker_secret from public.media_worker_config where id = 1)
      ),
      body := '{"source":"supabase-cron"}'::jsonb,
      timeout_milliseconds := 10000
    ) as request_id;
  $$
);
