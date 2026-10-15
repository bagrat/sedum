---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/provider-typesafe": minor
"@sedum-dev/reporters": patch
---

The opt-in vision fallback (`vision.enabled`, `sedum run --vision`) now asks Jev (`jev-1.14.0`, TypeSafe images preview) with the run's TypeSafe key, instead of Gemini over OpenRouter. It needs screenshots, so it runs on the direct TypeSafe API; a run with vision on and screenshots off stops with `vision_needs_screenshots`. Removed: `OpenRouterVisionResolver`, `probeOpenRouterKey`, `VisionRequestError` and `DEFAULT_VISION_MODEL` from `@sedum-dev/core`; the `--vision-model` run flag; the `vision.model` and `vision.timeoutMs` config keys, which now fail with a fix; `OPEN_ROUTER_API_KEY` for vision; and `sedum doctor --vision` with its `vision_key` and `vision_auth` checks, replaced by a `vision` check. `VisionResolver.choose` is renamed `chooseFromScreenshot`, which `TypeSafeAdapter` implements. A rejected key or exhausted rate limit during a vision request now stops the run.
