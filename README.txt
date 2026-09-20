JABARI AUTOPILOT v6 — CITATION GUARD

This version keeps the existing Autopilot v5 architecture and adds a citation guard for AI-generated media articles.

WHAT CHANGED
1. Gemini is told to use source numbers only and NOT create its own Sources section.
2. Jabari validates every [N] citation before saving the draft.
3. Invalid citation numbers cause generation to fail; the topic remains retryable/failed according to the existing logic.
4. Jabari renumbers sparse source references itself. Example: [1], [2], [5], [8] becomes [1], [2], [3], [4] while preserving the underlying source mapping.
5. Jabari builds the Sources section from the exact sources actually cited.
6. Google News RSS links are followed when possible so the saved source can use the direct publisher URL instead of the Google News redirect.
7. Saving media_sources now throws if Supabase rejects a source insert, instead of silently continuing.

DEPLOYMENT
- Replace the current bot.js with the bot.js in this package.
- Do NOT change your existing Render environment variables.
- Do NOT replace your Supabase service-role key or any other secret.
- Keep Autopilot in Review mode while testing.

IMPORTANT
This fixes citation numbering/assembly. It does not prove that every cited sentence is substantively supported by the linked source. The next stage for that would be claim-level source verification.
