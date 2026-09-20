Jabari Media Website v2 patch

Replace these files in the current Netlify website:
- index.html
- category.html
- article.html
- search.html
- about.html
- assets/app.js
- assets/style.css

DO NOT replace assets/config.js. Keep the current Supabase URL and publishable key already configured in your live site.

Fixes:
1. Category tabs now load stories by the actual media category ID instead of fetching all stories and client-filtering them.
2. Category pages no longer depend on a fragile filename/path check; each page declares its page type with data-page.
3. Active navigation tab gets a visible lime indicator.
4. Article pages highlight their category tab.
5. About, Search and Home also show their active tab.
6. Better error messages replace an endless Loading stories state when a request fails.
