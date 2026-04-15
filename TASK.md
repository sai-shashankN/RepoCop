# TASK: PR Summarizer + Auto-Reviewer Bot (Codex × n8n)

## 1) Goal
Build an automation that generates a high-quality **PR Review Packet** for GitHub pull requests. The system should:
- Trigger automatically when a PR is opened or updated, and/or run manually when given a PR URL.
- Fetch PR metadata + changed files + available diff patches.
- Produce a **strict JSON** review output (machine-parseable).
- Render and post a clean human-readable summary to a messaging destination (Discord or Slack).

The review should feel like a senior engineer doing a fast first-pass review: practical, specific, and focused on risk, correctness, edge cases, and test coverage.

---

## 2) Supported Run Modes

### 2.1 Automatic Mode (Webhook)
When a PR is:
- **opened**
- **synchronized** (new commits pushed)
the workflow should run and post the review packet.

### 2.2 Manual Mode (PR URL)
Provide a lightweight way to run the summarizer by submitting a PR URL to an endpoint (webhook) or form input.

Both modes are allowed. If implementing only one for MVP, implement **Automatic Mode** first.

---

## 3) Inputs (What the system may use)
From GitHub:
- PR title
- PR description/body
- PR author
- base branch + head branch
- PR URL
- list of changed files (filename, status, additions/deletions/changes)
- diff patch hunks when available (note: patches may be missing or truncated)

Optional (nice-to-have):
- linked issue references in PR body (e.g., “Fixes #123”)
- labels
- requested reviewers

---

## 4) Outputs (Required)
The workflow must generate a single **PR Review Packet** with:
- a strict JSON object (for parsing)
- a formatted message posted to a messaging destination (Discord/Slack/etc.)

### 4.1 Required JSON Output Schema
The model output must match this schema exactly (no extra keys):

- `summary` (string)
- `risk` ("low" | "medium" | "high")
- `risk_reasoning` (array of strings)
- `key_changes` (array of strings)
- `files_of_interest` (array of strings)
- `suggested_review_comments` (array of strings)
- `test_checklist` (array of strings)
- `questions_for_author` (array of strings)

Notes:
- Arrays must contain concise items (not paragraphs).
- If something is unclear due to missing/truncated diffs, the output must say so (especially in `risk_reasoning` and/or `questions_for_author`).

### 4.2 Human-Readable Message
Render the JSON into a clean review message with sections in this order:
1) Summary
2) Risk + reasoning
3) Key changes
4) Files of interest
5) Suggested review comments
6) Test checklist
7) Questions for author

---

## 5) Behavioral Requirements (Quality Rules)

### 5.1 No Hallucination
The system must NOT invent:
- file contents not present in diffs
- functions/classes not shown
- test results not run
- dependencies not confirmed

If the diff is missing/truncated, it must explicitly state that review confidence is limited.

### 5.2 Practical Code Review Focus
The review must prioritize:
- correctness and edge cases
- error handling and failure modes
- security footguns (secrets, auth, injection, unsafe logging)
- performance risks (hot paths, N+1, heavy loops)
- migrations/config changes
- test gaps and missing coverage
- backwards compatibility / API changes

Avoid generic fluff like “LGTM” or “Looks good”.

### 5.3 Consistency
- Always output the same keys in the JSON.
- Always output sections in the same order in the human message.
- Keep the tone concise, strict, and actionable.

---

## 6) GitHub Diff Handling Requirements

### 6.1 Patch Size Limits
Diff patches can be large. The workflow must:
- limit the number of files sent to the model (e.g., top N changed files)
- limit total patch characters/tokens
- still include metadata for all files (even if patch omitted)

### 6.2 Missing Patches
GitHub may omit patch data (binary files, huge diffs, etc.). The workflow must:
- detect missing patch fields
- mention missing/truncated coverage in the review output

---

## 7) Safety Guardrails

### 7.1 High-Risk PR Behavior
If `risk` is `high`, the message must:
- strongly recommend human review
- highlight rollback/testing steps
- avoid any “approve/ship” language

### 7.2 Secret/Token Exposure
If the diff appears to contain secrets (API keys, tokens, private keys, passwords):
- set risk to `high`
- include explicit warning in `risk_reasoning`
- include recommended remediation steps in `suggested_review_comments` (e.g., remove secret, rotate key, purge from history if needed)
- do NOT automatically rotate keys or push changes without explicit human approval

---

## 8) Reliability Requirements (n8n / Workflow)

### 8.1 Idempotency
If the same PR event triggers multiple times:
- avoid spamming duplicates
- implement a simple dedupe strategy (e.g., store last reviewed commit SHA per PR)

### 8.2 Retries and Rate Limits
- handle GitHub API rate limits gracefully
- implement retries with backoff for transient failures
- fail loudly with an actionable error message if persistent

### 8.3 Logging / Audit
Keep an audit log entry per run containing:
- timestamp
- PR identifier (owner/repo/number)
- commit SHA reviewed
- risk level
- link to posted message (if available)

---

## 9) Deliverables

### 9.1 n8n Workflow Export
Provide an n8n workflow JSON export that implements the automation.

### 9.2 Helper Code (if needed)
If any helper scripts/services are needed (e.g., small node script to normalize diffs), include them in the repo.

### 9.3 README
Include setup and run instructions:
- required environment variables (GitHub token, OpenAI key, destination webhook)
- how to import workflow into n8n
- how to test locally (manual mode)
- troubleshooting section

---

## 10) MVP Acceptance Checklist
MVP is complete when:
- [ ] Automatic trigger works on PR opened (and ideally synchronize)
- [ ] Manual mode works by submitting a PR URL (optional for MVP)
- [ ] System fetches PR data + changed files + available patches
- [ ] Model output is strict JSON with the exact schema keys
- [ ] A formatted message is posted to the chosen destination
- [ ] Missing/truncated diffs are explicitly handled
- [ ] Dedupe prevents repeated spam for the same commit
- [ ] Basic logging/audit record exists per run
- [ ] Tested successfully on at least 5 different PRs

---

## 11) Stretch Goals (Optional)
- PR type classifier: `bugfix | feature | refactor | infra | docs | tests`
- PR size warning + suggested split plan
- Auto-suggest test commands based on repo stack
- Post summary as a GitHub PR comment as well as chat
- “Executive summary” + “Deep review” dual output modes
- Repo-specific style memory (learn conventions from prior PRs)

---

## 12) Default Assumptions (Unless Implementer Chooses Otherwise)
- Use GitHub REST API to fetch PR metadata and changed files.
- Post final message to a webhook-based destination (Discord webhook is simplest).
- Prefer implementing Automatic Mode first.
- Use structured output enforcement to guarantee strict JSON.

If any of these assumptions conflict with the environment, document changes in README.