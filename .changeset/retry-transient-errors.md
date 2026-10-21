---
"@sedum-dev/core": patch
---

Let `--retries` repeat a test whose step hit a transient problem: a target that
went stale before it was clicked, or one failed model call while finding the
target. Such a step now fails, instead of marking the test unable to run, which
no retry repeated. A click that may already have started is still never
repeated.
