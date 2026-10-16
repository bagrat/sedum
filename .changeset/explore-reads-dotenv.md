---
"sedum-cli": patch
---

Read `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, and `TYPESAFE_DEFAULT_MODEL` from the project-root `.env` in `sedum explore`, as `sedum run` does; the shell's values still win. Before, a key set in `.env` as `sedum init` suggests failed with "Set TYPESAFE_API_KEY to use the TypeSafe provider."
