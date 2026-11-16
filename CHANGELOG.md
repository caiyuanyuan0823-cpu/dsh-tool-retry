# Changelog

## 1.1.0

- **MCP coverage.** `retryToolPrefixes` (default `["mcp__"]`) makes every MCP-provided tool retryable without listing names; `retryTools` keeps handling exact names.
- **Deny by shape.** New `denyPattern` (default covers `feedback_submit`, `report_issue`, `deepin_shell`, `deepin_hermes_oneshot`, `deepin_cron_action`, `tavily_research`, `schedule_*`, `send_message`) so a prefix cannot sweep in a mutating tool; `denyTools` still denies exact names. Denies always win.
- **Publishable package.** `@deepseek-ai/schemastery` moved from a peer dependency to a real dependency, so a normal install resolves it; MIT `LICENSE`, `CHANGELOG`, bilingual README, `tests` shipped in the tarball.

## 1.0.0

- First working version: `tools/execute` waterfall wrapper, classification-driven retry, jittered exponential backoff, exact-name allowlist, never-retry codes for approvals and cancellations, JSONL audit ledger that never throws, optional `diagnostics` verdict log.
- Retries re-dispatch through `ctx.tools.execute()` without `log`, because the waterfall's `next()` is single-use — the session keeps one `tool/call` / `tool/result` pair.
