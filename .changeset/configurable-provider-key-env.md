---
"sedum-cli": patch
---

Support `provider.apiKeyEnv` and `vision.apiKeyEnv` to read provider credentials
from custom environment variable names, with named environment overrides.
Use configured names in diagnostics, doctor checks, and init templates while
preserving existing defaults and aliases when no setting is supplied.
