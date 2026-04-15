# RepoCop Benchmarks

This folder stores repeatable benchmark outputs for RepoCop's repository-analysis path.

## Current Status

The benchmark harness is now wired through [scripts/run-benchmarks.mjs](/C:/Users/LENOVO/Specializations/Agentic%20AI/codexN8N/RepoCop/scripts/run-benchmarks.mjs) and writes per-target artifacts plus a roll-up summary.

Current summary artifact:

- [benchmark-summary.json](/C:/Users/LENOVO/Specializations/Agentic%20AI/codexN8N/RepoCop/benchmarks/benchmark-summary.json)

Current targets:

- `openai/openai-node`
- `fastapi/fastapi`

## Recorded Blocker

The latest run completed in a documented blocked state instead of failing hard:

- the configured GitHub token returns `401 Bad credentials`
- anonymous fallback requests then hit GitHub API rate limiting with `403 API rate limit exceeded`

That blocker is now preserved in the benchmark artifacts themselves, which is better than silently having no benchmark story at all.

## Rerun

From the project root:

```powershell
npm run benchmark
```

Once a valid `GITHUB_TOKEN` is configured, the same harness should begin writing completed benchmark artifacts for each target without further code changes.
