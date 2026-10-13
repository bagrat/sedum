import type { BrowserSignal } from "./signals.js";

export type DetectionCheck = BrowserSignal["kind"];

/** One suspected bug on one step. Detections flag a step; they never fail it. */
export interface Detection {
  readonly check: DetectionCheck;
  readonly message: string;
  readonly url?: string;
  /** HTTP status, or 0 for a request that failed without a response. */
  readonly status?: number;
}

/**
 * `check:pattern` or `pattern`. A pattern is a substring of the detection's
 * message or URL, or `re:` and a case-sensitive regular expression.
 */
export interface AllowRule {
  readonly check: DetectionCheck | null;
  readonly test: (text: string) => boolean;
  readonly source: string;
}

const CHECKS: readonly DetectionCheck[] = [
  "console_error",
  "uncaught_exception",
  "unhandled_rejection",
  "http_error",
];

/** Noise every app produces; extend per project with `--detect-allow`. */
export const DEFAULT_ALLOW = [
  "http_error:/favicon.ico",
  "console_error:re:^ResizeObserver loop",
] as const;

export function parseAllowRule(text: string): AllowRule {
  const match = /^([a-z_]+):(.+)$/u.exec(text);
  const named = match && CHECKS.includes(match[1] as DetectionCheck);
  const check = named ? (match[1] as DetectionCheck) : null;
  const pattern = named ? match[2]! : text;
  if (!pattern.trim()) throw new Error("An allow rule needs a pattern.");
  if (pattern.startsWith("re:")) {
    const compiled = new RegExp(pattern.slice(3), "u");
    return { check, test: (value) => compiled.test(value), source: text };
  }
  return { check, test: (value) => value.includes(pattern), source: text };
}

export function allowed(
  detection: Detection,
  rules: readonly AllowRule[],
): boolean {
  const text = `${detection.message} ${detection.url ?? ""}`;
  return rules.some(
    (rule) =>
      (rule.check === null || rule.check === detection.check) &&
      rule.test(text),
  );
}

export function signalDetection(signal: BrowserSignal): Detection {
  return {
    check: signal.kind,
    message: signal.message,
    ...(signal.url ? { url: signal.url } : {}),
    ...(signal.status === undefined ? {} : { status: signal.status }),
  };
}

/** One detection per check and message within a step. */
export function uniqueDetections(
  detections: readonly Detection[],
): Detection[] {
  const seen = new Set<string>();
  return detections.filter((detection) => {
    const key = `${detection.check}\u0000${detection.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
