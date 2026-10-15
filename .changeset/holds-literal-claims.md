---
"@sedum-dev/core": patch
"sedum-cli": patch
---

Run literal `ai.holds` claims such as `ai.holds("the product list is shown")` without asking the model to classify them. The runtime now accepts the same claim shapes as `sedum validate`; before, a claim that validation accepted could stop the test as `invalid_test` because the model answered a bare claim as an unclear step.
