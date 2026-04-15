# SupplyMate Repo Reviewer - Next Session Notes

## What we decided
- Keep the current repo-review n8n workflow as the review engine.
- Move from manual webhooks/localtunnel to an always-on setup.
- Later switch to a Discord bot command flow:
  - User runs a command with a repo URL.
  - Bot sends the repo URL to n8n.
  - n8n returns/posts the full review packet in Discord.

## Why localtunnel is not enough long-term
- Localtunnel URLs change and can go down.
- It is fine for testing, not ideal for reliable daily use.

## Always-on options (pick one later)
1. Host n8n on a VPS/cloud instance (recommended).
2. Host n8n on a managed platform.
3. Put your own domain/subdomain in front of n8n (optional but cleaner).

## Target architecture (later)
1. Discord bot with slash command, e.g. `/reviewrepo repo_url:<url>`.
2. Bot validates URL, calls n8n manual webhook:
   - `POST /webhook/github-repo-review-manual`
3. n8n runs existing workflow.
4. Result is posted back to Discord (chunked messages, no truncation).

## Build checklist for next time
1. Create Discord bot app + invite it to your server.
2. Add slash command definition (`/reviewrepo`).
3. Build bot handler (Node.js or Python) to forward `repo_url` to n8n webhook.
4. Configure env vars in bot project:
   - `DISCORD_BOT_TOKEN`
   - `N8N_MANUAL_WEBHOOK_URL`
   - Optional: `N8N_API_KEY` (if needed)
5. Add response handling:
   - Immediate "processing..." reply
   - Final review packet reply (chunked if long)
6. Deploy bot + n8n on always-on hosting.
7. Replace localtunnel webhook URLs with stable public URL.
8. Test end-to-end from Discord command.

## Current workflow status
- Repo review workflow exists and runs successfully.
- Discord output supports full long review content via chunking.
- Manual route used for repo input:
  - `POST /webhook/github-repo-review-manual`

## Quick reminder
- Do not commit real secrets to repo files.
- Keep tokens only in environment variables.
