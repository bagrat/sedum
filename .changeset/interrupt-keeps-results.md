---
"@sedum-dev/core": patch
"sedum-cli": patch
---

Keep the final `result.json`, `report.html`, and summary when Ctrl-C interrupts `sedum run`, including under `npx`. Playwright's own SIGINT handler exited the process with code 130 as soon as the browsers closed, before Sedum wrote the interrupted result. `PlaywrightBrowserDriver` accepts `callerHandlesSignals: true` to leave SIGINT and SIGTERM to the caller, and `sedum run` sets it.
