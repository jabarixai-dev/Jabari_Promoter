const fs = require("fs");

function replaceOnce(file, oldText, newText) {
  const path = file;
  const src = fs.readFileSync(path, "utf8");
  if (!src.includes(oldText)) {
    throw new Error(`Expected block was not found in ${path}. The file may already be fixed or has changed.`);
  }
  fs.writeFileSync(path, src.replace(oldText, newText), "utf8");
  console.log(`Updated ${path}`);
}

// 1) Fix the Telegram/Web3 promotion handler so scraped opportunity summaries
// never become the email body.
replaceOnce(
  "bot.js",
`web3Automation.setPromotionHandler(async ({ title, description, url }) => {
  if (mode !== "live") return { sent: 0, dryRun: true };
  const previous = await getActiveCampaign();
  const campaign = await createCampaign(title, description || "Web3 opportunity available on Jabari.", url);`,
`web3Automation.setPromotionHandler(async ({ title, description, url }) => {
  if (mode !== "live") return { sent: 0, dryRun: true };
  const previous = await getActiveCampaign();
  const campaign = await createCampaign(title, "", url);`
);

// 2) Replace the old long/duplicated email with the short action-focused version.
replaceOnce(
  "bot.js",
`  const subject = \`Worth a look: \${active.title || "A new opportunity from Jabari"}\`;
  const body = [
    "Hi,",
    "",
    "I found something that may be worth your attention.",
    "",
    active.title || "New opportunity",
    "",
    active.description || "A new opportunity has been published on Jabari.",
    "",
    "If this is relevant to you, take a look now:",
    active.blog_url,
    "",
    "Before you act, check the current eligibility, deadline, requirements and reward terms on the original source.",
    "",
    "Read the full breakdown:",
    active.blog_url,
    "",
    "Best,",
    "Jabari"
  ].join("\\n");`,
`  const subject = \`💰 \${active.title || "New opportunity on Jabari"}\`;
  const body = [
    "Hi,",
    "",
    "A new opportunity has been found on Jabari.",
    "",
    active.title || "New opportunity",
    "",
    "If you're interested, see the opportunity details and participation steps here:",
    "",
    \`👉 \${active.blog_url}\`,
    "",
    "Check the original opportunity for the latest requirements, eligibility, deadline and reward terms.",
    "",
    "Best,",
    "Jabari"
  ].join("\\n");`
);

// 3) Make the article publisher pass no scraped summary into the promotion email.
replaceOnce(
  "web3-automation.js",
`promotion=await promotionHandler({title:a.title,description:chosen.summary||'',url});`,
`promotion=await promotionHandler({title:a.title,url});`
);

// 4) Make the original opportunity link mandatory and canonical.
// Gemini output is allowed to contain the article text, but we remove its
// "Open Original Opportunity" anchor and append one exact, verified link.
replaceOnce(
  "web3-automation.js",
`const a=await gemini(prompt,title(chosen.title,'Web3 Opportunity'),fallback);if(!String(a.content).includes(direct))a.content+=\`\\n<p><a href="\${esc(direct)}" target="_blank" rel="noopener noreferrer"><strong>🔗 Open Original Opportunity →</strong></a></p>\`;return a;`,
`const a=await gemini(prompt,title(chosen.title,'Web3 Opportunity'),fallback);
let content=String(a.content||'')
  .replace(/<a\\b[^>]*>[\\s\\S]*?Open Original Opportunity[\\s\\S]*?<\\/a>/gi,'')
  .replace(/<p>\\s*<\\/p>/gi,'')
  .trim();
content+=\`\\n<p><a href="\${esc(direct)}" target="_blank" rel="noopener noreferrer"><strong>🔗 Open Original Opportunity →</strong></a></p>\`;
return {...a,content};`
);

// 5) Strengthen the Gemini prompt against scraped-page dumps.
replaceOnce(
  "web3-automation.js",
`Do not invent facts, rewards, deadlines or eligibility. Do not promise earnings. Finish with a prominent Open Original Opportunity link`,
`Do not invent facts, rewards, deadlines or eligibility. Do not promise earnings. Never copy navigation menus, account controls, unrelated page sections, participant lists, or large blocks of scraped webpage text. Use only the facts needed to explain this specific opportunity. Finish with a prominent Open Original Opportunity link`
);

console.log("\\nOpportunity email/article fix applied successfully.");
console.log("Run: node --check bot.js && node --check web3-automation.js");
