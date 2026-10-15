---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/provider-typesafe": minor
---

Send screenshots to TypeSafe, on by default for the direct TypeSafe API. After the text model picks an element, Sedum outlines it in a screenshot and stops the step as ambiguous when several elements fit equally well, instead of clicking a guess. `verify` and `measure` steps send a screenshot with the page text, so claims about colors, icons, images and disabled controls can be judged. Screenshots use TypeSafe's images preview with `jev-1.14.0`, are never sent for `--sensitive-origin` pages, and fail open to text. Turn them off with `screenshots: false` or `sedum run --no-screenshots`.
