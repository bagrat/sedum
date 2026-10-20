import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "../browser-driver.js";
import { PAGE_PROTOCOL } from "../page-protocol.js";
import type { TextClaim } from "../step-operands.js";
import type { SentenceAssertionContext } from "./assertion-support.js";
import { executeTextAssertion } from "./assertion-text.js";

/** A page whose script is missing for its first `unreadableReads` text reads, as mid-navigation. */
function loadingPage(unreadableReads: number): BrowserPage {
  let textReads = 0;
  const values: Record<string, unknown> = {
    pageVersion: { revision: 1, document: "next", route: "/next" },
    quiet: {
      version: { revision: 1, document: "next", route: "/next" },
      quiet: true,
    },
    visibleText: { complete: true, text: "Arrived" },
  };
  return {
    url: "http://127.0.0.1/next",
    evaluate: async (script: string) => {
      const method = /bridge\["(\w+)"\]/u.exec(script)?.[1] ?? "";
      if (method === "visibleText") textReads++;
      if (textReads <= unreadableReads) return { installed: false };
      return {
        installed: true,
        protocol: PAGE_PROTOCOL,
        value: values[method],
      };
    },
  } as unknown as BrowserPage;
}

function context(page: BrowserPage) {
  const record = vi.fn(async (outcome: unknown) => outcome);
  const value = {
    page,
    data: {},
    dependencies: {},
    step: { source: { file: "flow.test.yaml", line: 1, col: 1 } },
    record,
  } as unknown as SentenceAssertionContext;
  return { value, record };
}

const arrived: TextClaim = {
  text: "Arrived",
  expect: { kind: "present", present: true },
};

describe("text assertions", () => {
  it("keeps polling while the page text cannot be read yet", async () => {
    const { value, record } = context(loadingPage(3));
    await executeTextAssertion(value, arrived, 5_000);
    expect(record).toHaveBeenCalledWith("continue");
  });

  it("fails, and so can be retried, when the text stays unreadable to the deadline", async () => {
    const { value, record } = context(loadingPage(Number.POSITIVE_INFINITY));
    const started = performance.now();
    await executeTextAssertion(value, arrived, 600);
    expect(performance.now() - started).toBeGreaterThanOrEqual(500);
    expect(record).toHaveBeenCalledWith("failed", {
      error: {
        code: "text_unreadable",
        message: "The page text could not be read.",
      },
    });
  });
});
