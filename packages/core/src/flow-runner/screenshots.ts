import type { BrowserPage } from "../browser-driver.js";
import type { TargetCheckOptions } from "../locator/target-check.js";
import { safeUrl } from "../report-privacy.js";
import type { AttemptDependencies } from "./contracts.js";

/** Screenshots never leave the machine for a page marked sensitive. */
function allowed(dependencies: AttemptDependencies, page: BrowserPage) {
  const report = dependencies.report;
  return !(report && safeUrl(page.url, report.privacy).sensitive);
}

export function targetCheckOption(
  dependencies: AttemptDependencies,
  page: BrowserPage,
): { readonly targetCheck?: TargetCheckOptions } {
  const checker = dependencies.screenshots?.targetChecker;
  return checker && allowed(dependencies, page)
    ? { targetCheck: { checker } }
    : {};
}

export function judgeScreenshot(
  dependencies: AttemptDependencies,
  page: BrowserPage,
): boolean {
  return (
    Boolean(dependencies.screenshots?.judge) && allowed(dependencies, page)
  );
}
