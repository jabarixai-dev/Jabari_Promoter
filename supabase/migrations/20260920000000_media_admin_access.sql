-- JABARI MEDIA ADMIN ACCESS V1
-- Authenticated admins can manage media content.
-- Public visitors remain read-only for published content.

create table if not exists public.media_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.media_admins enable row level security;
revoke all on table public.media_admins from anon, authenticated;
grant select on table public.media_admins to authenticated;

drop policy if exists "Admins can read their own admin record" on public.media_admins;
create policy "Admins can read their own admin record"
on public.media_admins for select to authenticated
using ((select auth.uid()) = user_id);

grant select, insert, update, delete on table public.media_articles to authenticated;

drop policy if exists "Admins can read articles" on public.media_articles;
create policy "Admins can read articles" on public.media_articles for select to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can insert articles" on public.media_articles;
create policy "Admins can insert articles" on public.media_articles for insert to authenticated
with check (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can update articles" on public.media_articles;
create policy "Admins can update articles" on public.media_articles for update to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())))
with check (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can delete articles" on public.media_articles;
create policy "Admins can delete articles" on public.media_articles for delete to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

grant select, insert, update, delete on table public.media_categories to authenticated;
grant select, insert, update, delete on table public.media_authors to authenticated;
grant select, insert, update, delete on table public.media_topics to authenticated;
grant select, update on table public.media_autopilot to authenticated;
grant select on table public.media_automation_logs to authenticated;

drop policy if exists "Admins can manage categories" on public.media_categories;
create policy "Admins can manage categories" on public.media_categories for all to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())))
with check (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can manage authors" on public.media_authors;
create policy "Admins can manage authors" on public.media_authors for all to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())))
with check (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can manage topics" on public.media_topics;
create policy "Admins can manage topics" on public.media_topics for all to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())))
with check (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can read autopilot" on public.media_autopilot;
create policy "Admins can read autopilot" on public.media_autopilot for select to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can update autopilot" on public.media_autopilot;
create policy "Admins can update autopilot" on public.media_autopilot for update to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())))
with check (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));

drop policy if exists "Admins can read automation logs" on public.media_automation_logs;
create policy "Admins can read automation logs" on public.media_automation_logs for select to authenticated
using (exists (select 1 from public.media_admins m where m.user_id=(select auth.uid())));
