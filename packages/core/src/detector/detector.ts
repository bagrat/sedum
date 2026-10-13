import type { BrowserPage } from "../browser-driver.js";
import { quietPage } from "../page-bridge.js";
import {
  DEFAULT_ALLOW,
  allowed,
  parseAllowRule,
  signalDetection,
  uniqueDetections,
  type AllowRule,
  type Detection,
} from "./checks.js";

export interface BugDetectorOptions {
  /** Extra allow rules, added to `DEFAULT_ALLOW`. */
  readonly allow?: readonly string[];
  /** Longest wait for in-flight requests before a step's signals are read. */
  readonly settleMs?: number;
}

const QUIET_MS = 80;
const QUIET_TIMEOUT_MS = 2_000;

/**
 * Flags steps whose page reported a console error, an uncaught exception, an
 * unhandled rejection, or an HTTP error, without authored claims. Signals are
 * drained per step, after the page and its requests settle, so each finding
 * lands on the step that caused it.
 */
export class BugDetector {
  private readonly allow: readonly AllowRule[];
  private readonly settleMs: number;

  constructor(options: BugDetectorOptions = {}) {
    this.allow = [...DEFAULT_ALLOW, ...(options.allow ?? [])].map(
      parseAllowRule,
    );
    this.settleMs = options.settleMs ?? 1_500;
  }

  /** Never throws: a detector fault must not change a step's outcome. */
  async inspectStep(
    page: BrowserPage,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly Detection[]> {
    if (options.signal?.aborted) return [];
    try {
      const source = page.signals?.() ?? null;
      if (!source) return [];
      if (!page.closed) {
        await quietPage(page, QUIET_MS, QUIET_TIMEOUT_MS).catch(
          () => undefined,
        );
        await source.settle({ maxMs: this.settleMs });
      }
      return uniqueDetections(source.drain().map(signalDetection)).filter(
        (detection) => !allowed(detection, this.allow),
      );
    } catch {
      return [];
    }
  }
}
