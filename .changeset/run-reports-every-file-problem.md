---
"sedum-cli": patch
---

Name every problem in an invalid test file in `sedum run`, as `sedum validate` does. A file with an unknown placeholder used to report only that error; the run now also lists sentences that offline validation rejects, such as an unsupported action or two actions in one step, so one run shows everything to fix.
