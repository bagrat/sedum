import type { BrowserPage } from "../browser-driver.js";
import type { Detection } from "../detector/checks.js";
import type { BugDetector } from "../detector/detector.js";
import { safeText, safeUrl, type ReportPrivacy } from "../report-privacy.js";
import type { ResultDetection } from "../run-result.js";

const STEP_LIMIT = 50;
const SENSITIVE = "Details omitted on a sensitive page.";
/** An absolute URL inside browser text, up to whitespace, a quote, or a bracket. */
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>()[\]{}]+/giu;
/** Sentence punctuation and the collector's clip marker are not part of a URL. */
const URL_TAIL = /[.,;:!?…]+$/u;

/**
 * Every URL in a message is reduced like the step's own URL: origin and path
 * only, or the origin alone on a sensitive origin. Messages can hold URLs the
 * detection's `url` does not: a clipped one, or one Chrome quotes in a console
 * error, such as a request blocked by CORS.
 */
function safeUrls(text: string, privacy: ReportPrivacy): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const tail = URL_TAIL.exec(match)?.[0] ?? "";
    const raw = match.slice(0, match.length - tail.length);
    const safe = safeUrl(raw, privacy).url;
    // A bare origin stays bare; `safeUrl` would add the root path.
    const bare = !/^[a-z]+:\/\/[^/?#]*\//iu.test(raw);
    // A clip inside a query or fragment went with it.
    const rest = /[?#]/u.test(raw) ? tail.replace(/…$/u, "") : tail;
    return (bare ? safe.replace(/\/$/u, "") : safe) + rest;
  });
}

/** Query strings and secrets never reach the report; sensitive pages keep only the check. */
function reportDetection(
  detection: Detection,
  privacy: ReportPrivacy,
  sensitive: boolean,
): ResultDetection {
  const url = detection.url ? safeUrl(detection.url, privacy).url : undefined;
  const message = sensitive ? SENSITIVE : safeUrls(detection.message, privacy);
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
