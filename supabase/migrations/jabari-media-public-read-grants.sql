-- JABARI MEDIA PUBLIC READ GRANTS
-- Allows the public website to read media data through Supabase.
-- Existing RLS policies still control which rows are visible.

grant select on table public.media_articles to anon, authenticated;
grant select on table public.media_categories to anon, authenticated;
grant select on table public.media_authors to anon, authenticated;
grant select on table public.media_tags to anon, authenticated;
grant select on table public.media_article_tags to anon, authenticated;
grant select on table public.media_sources to anon, authenticated;
