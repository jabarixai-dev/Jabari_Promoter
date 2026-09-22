// Replace the opportunity email body inside finishPromotion() with this block.
// It intentionally contains only ONE Jabari article link.
const subject = `Worth a look: ${active.title || "A new opportunity from Jabari"}`;
const body = [
  "Hi,",
  "",
  "I found an opportunity that may be relevant to you.",
  "",
  active.title || "New opportunity",
  "",
  active.description || "A new opportunity has been published on Jabari.",
  "",
  "Read the full breakdown:",
  active.blog_url,
  "",
  "Best,",
  "Jabari"
].join("\n");
