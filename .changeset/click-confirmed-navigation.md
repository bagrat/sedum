---
"@sedum-dev/core": patch
---

Count a click, press or history move as done once it has opened a new document
or route, even if the new page is still loading or changing. Such an action
used to end with `action_uncertain` (the test could not run, with no retry)
when the next page took more than about 4 seconds to load, as a cross-app page
on a busy machine does. Later steps wait for the page as before; the action is
still never replayed, and an unreadable new document is still uncertain.
