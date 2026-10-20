---
"@sedum-dev/core": patch
---

Keep polling a text check while the page is still loading. A `verify` or
`wait until the text … is shown` step that starts during a full page load no
longer stops at once with `text_unreadable` before Sedum's page script is in the
new document; it keeps reading until its deadline. Text that stays unreadable
now fails the step, so `--retries` applies, instead of marking the test unable
to run.
