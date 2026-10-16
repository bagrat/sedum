---
"@sedum-dev/core": patch
"@sedum-dev/reporters": patch
"sedum-cli": patch
---

Show each `sedum explore` finding with the frame of the page it was seen on. A page check (`--detect semantic`) judges the page before the step's action, but `report.html` and `report.md` showed the page after it: a "stuck_loading on /checkout" finding showed the Orders page the step clicked through to. Findings in `result.json` now carry that `frame`.
