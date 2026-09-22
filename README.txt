Jabari Web3 Automation — corrected replacement

Replace ONLY:
Jabari_Promoter/web3-automation.js

This version:
- resolves Google News RSS links to direct publisher URLs when possible
- refuses to publish an opportunity if a direct publisher URL cannot be verified
- creates substantially more detailed opportunity articles
- creates natural news titles and removes "Web3 News Roundup"
- keeps Google RSS redirect URLs out of generated opportunity articles
- promotes using the Jabari blog URL, not the source URL

Important:
The promotion email text itself is built in bot.js, not web3-automation.js.
So this file does NOT by itself change the email wording. The email must be patched in bot.js so that the email contains only the Jabari blog URL.
