---
"sedum-cli": patch
---

Read the TypeSafe key from `provider.apiKeyEnv` in `sedum explore`, as `sedum run` and `sedum doctor` do. Before, a project that kept its key in a custom variable such as `TYPESAFE_LOCAL_E2E_API_KEY` failed with "Set TYPESAFE_API_KEY to use the TypeSafe provider." The message now names the configured variable, and a configured name is not backed by `TYPESAFE_API_KEY`. An invalid `sedum.config.yaml` now stops `sedum explore` with its diagnostic.
