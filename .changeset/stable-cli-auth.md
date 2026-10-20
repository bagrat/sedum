---
"sedum-cli": patch
---

Stabilize Cloud authentication cancellation, device polling, HTTP error handling, and refresh-token rotation when access expires during status checks. Terminal EOF and Ctrl-C now release the authentication store lock safely.
