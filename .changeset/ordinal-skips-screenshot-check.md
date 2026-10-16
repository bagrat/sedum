---
"@sedum-dev/core": patch
---

Ordinal clicks such as `click the first Start fact find button` no longer fail as `ambiguous` when screenshots are on. When Sedum picks among same-named elements by an ordinal or price rank ("the first", "the last", "the cheapest"), it uses the element at that position in document order and skips the screenshot check, which counted the siblings that the step had already told apart. Clicks without an ordinal are still checked.
