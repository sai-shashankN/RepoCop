# Repository Summarizer + Auto-Reviewer Bot (n8n)

This project reviews a **GitHub repository** (not pull requests) and posts a structured review to Discord or Slack.

It now also includes a small MCP server so n8n can call repo-review tools over an MCP endpoint instead of keeping all GitHub and OpenAI logic inside a giant Code node.

## Files
- `repo-review-workflow.json`: current workflow export (repository reviewer).
- `pr-review-packet-workflow.json`: legacy filename copy of the same repository-review workflow export.
- `src/server.js`: RepoCop MCP server exposing review tools for n8n and other MCP clients.
- `scripts/run-benchmarks.mjs`: benchmark harness for saved review artifacts.
- `package.json`: Node package manifest for the MCP server.
- `scripts/configure-github-webhook.ps1`: create/update GitHub webhook for automatic runs.
- `TASK.md`: original assignment brief.

## Sample Packet And Benchmarks

You can now inspect the intended review output shape directly:

- [examples/sample-review-packet.json](/C:/Users/LENOVO/Specializations/Agentic%20AI/codexN8N/RepoCop/examples/sample-review-packet.json)

Benchmark artifacts live in:

- [benchmarks/README.md](/C:/Users/LENOVO/Specializations/Agentic%20AI/codexN8N/RepoCop/benchmarks/README.md)
- [benchmarks/benchmark-summary.json](/C:/Users/LENOVO/Specializations/Agentic%20AI/codexN8N/RepoCop/benchmarks/benchmark-summary.json)

Current benchmark state:

- the harness is wired and writes per-target JSON artifacts
- the latest run recorded two intended targets: `openai/openai-node` and `fastapi/fastapi`
- those targets are currently marked `blocked` because the configured GitHub token is invalid and anonymous fallback requests are rate-limited

That blocker is now captured in the benchmark artifacts instead of failing invisibly, so the repo has a concrete benchmark path ready as soon as credentials are refreshed.

## Environment Variables

Required:
- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- `DISCORD_WEBHOOK_URL` (if `DESTINATION_MODE=discord`)
- `SLACK_WEBHOOK_URL` (if `DESTINATION_MODE=slack`)

Optional:
- `GITHUB_WEBHOOK_SECRET`
- `OPENAI_MODEL` (default: `gpt-4.1-mini`)
- `MAX_REPO_FILES` (default: `20`)
- `MAX_REPO_CHARS` (default: `24000`)
- `MAX_REPO_FILE_CHARS` (default: `4000`)
- `MAX_PATCH_CHARS` (default: `20000`)
- `MAX_PATCH_FILE_CHARS` (default: `3500`)
- `HTTP_MAX_ATTEMPTS` (default: `3`)
- `HTTP_RETRY_BASE_MS` (default: `1000`)
- `HTTP_TIMEOUT_MS` (default: `30000`)
- `OPENAI_TIMEOUT_MS` (default: `60000`)
- `MCP_HOST` (default: `127.0.0.1`)
- `MCP_PORT` (default: `8787`)
- `MCP_PATH` (default: `/mcp`)
- `MCP_AUTH_TOKEN` (optional bearer token for MCP clients)

## MCP Server

Install dependencies:

```powershell
npm install
npm run benchmark
```

Start the MCP server:

```powershell
npm start
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

The MCP endpoint defaults to:

```text
http://127.0.0.1:8787/mcp
```

If `MCP_AUTH_TOKEN` is set, connect with:

```text
Authorization: Bearer <your-token>
```

### Exposed MCP Tools

- `analyze_repo`
  - Fetches repository metadata, languages, sampled files, and coverage limits.
- `summarize_changes`
  - Compares two refs and returns changed files, patch excerpts, and missing/truncated diff warnings.
- `generate_review_packet`
  - Runs fresh analysis and returns a strict JSON review packet using OpenAI.

### n8n MCP Client Setup

In n8n, add an `MCP Client` node and point it at the RepoCop endpoint URL. After connecting, n8n should discover the three tools above automatically.

Suggested usage:

1. Use `analyze_repo` for repository-level review packets.
2. Use `summarize_changes` when you have a base/head ref pair from a webhook event.
3. Use `generate_review_packet` when you want the MCP server to do both analysis and packet generation in one tool call.

## Endpoints

Automatic mode:
- `POST /webhook/github-repo-review-auto`
- Intended event: `push`

Manual mode:
- `POST /webhook/github-repo-review-manual`

Manual request body:
```json
{
  "repo_url": "https://github.com/owner/repo"
}
```

Optional manual branch override:
```json
{
  "repo_url": "https://github.com/owner/repo",
  "ref": "main"
}
```

## Configure GitHub Webhook

Use a publicly reachable URL for n8n (GitHub cannot reach localhost directly):
```powershell
powershell -ExecutionPolicy Bypass -File RepoCop\scripts\configure-github-webhook.ps1 `
  -Repo owner/repo `
  -CallbackUrl https://your-public-host/webhook/github-repo-review-auto `
  -Events push
```

## Output

Workflow returns:
- `review_packet` JSON
- `formatted_message`
- `repo_identifier`, `branch`, `commit_sha`
- dedupe/audit metadata

The message sections are:
1. Summary
2. Risk + reasoning
3. Architecture observations
4. Code quality findings
5. Security findings
6. Test coverage gaps
7. Recommended next steps
8. Questions for maintainer
