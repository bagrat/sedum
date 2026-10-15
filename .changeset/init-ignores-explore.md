---
"sedum-cli": patch
---

Add `.sedum/explore/` to the `.gitignore` rules `sedum init` writes. `sedum explore` stores traces, reports, and page frames there, which can show private page pixels; before, `git add .` after one exploration committed them. Run `sedum init` again in an existing project to add the rule.
