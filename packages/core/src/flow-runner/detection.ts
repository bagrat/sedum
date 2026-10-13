import type { BrowserPage } from "../browser-driver.js";
import type { Detection } from "../detector/checks.js";
import type { BugDetector } from "../detector/detector.js";
import { safeText, safeUrl, type ReportPrivacy } from "../report-privacy.js";
import type { ResultDetection } from "../run-result.js";

const STEP_LIMIT = 50;
const SENSITIVE = "Details omitted on a sensitive page.";

/** Query strings and secrets never reach the report; sensitive pages keep only the check. */
function reportDetection(
  detection: Detection,
  privacy: ReportPrivacy,
  sensitive: boolean,
): ResultDetection {
  const url = detection.url ? safeUrl(detection.url, privacy).url : undefined;
  const message = sensitive
    ? SENSITIVE
    : detection.url
      ? detection.message.split(detection.url).join(url)
      : detection.message;
  return {
    ...detection,
    message: safeText(message, privacy, 512),
    ...(url === undefined ? {} : { url }),
  };
}

/** @internal Run the bug detector for the signals a step produced. */
export async function detectStep(
  page: BrowserPage,
  detector: BugDetector | undefined,
  report: { readonly privacy: ReportPrivacy; readonly sensitive: boolean },
  signal?: AbortSignal,
): Promise<readonly ResultDetection[]> {
  if (!detector) return [];
  const found = await detector.inspectStep(page, signal ? { signal } : {});
  return found
    .slice(0, STEP_LIMIT)
    .map((detection) =>
      reportDetection(detection, report.privacy, report.sensitive),
    );
}
