import { expect, it } from "vitest";
import type { BrowserPage } from "../browser-driver.js";
import type { BugDetector } from "../detector/detector.js";
import { detectStep } from "./detection.js";

const found = [
  {
    check: "http_error" as const,
    message: "GET https://shop.test/api/orders?token=abc returned 500",
    url: "https://shop.test/api/orders?token=abc",
    status: 500,
  },
  {
    check: "console_error" as const,
    message: "Payment failed for card 4242",
  },
];
const detector = { inspectStep: async () => found } as unknown as BugDetector;
const page = {} as BrowserPage;

it("reports URLs without their query and redacts secrets", async () => {
  const detections = await detectStep(page, detector, {
    privacy: { secretValues: ["4242"], sensitiveOrigins: [] },
    sensitive: false,
  });
  expect(detections).toEqual([
    {
      check: "http_error",
      message: "GET https://shop.test/api/orders returned 500",
      url: "https://shop.test/api/orders",
      status: 500,
    },
    { check: "console_error", message: "Payment failed for card [REDACTED]" },
  ]);
});

it("keeps only the check on a sensitive page", async () => {
  const detections = await detectStep(page, detector, {
    privacy: { secretValues: [], sensitiveOrigins: ["https://shop.test"] },
    sensitive: true,
  });
  expect(detections.map((d) => [d.check, d.message, d.url])).toEqual([
    ["http_error", "Details omitted on a sensitive page.", "https://shop.test"],
    ["console_error", "Details omitted on a sensitive page.", undefined],
  ]);
});

it("does nothing without a detector", async () => {
  expect(
    await detectStep(page, undefined, {
      privacy: { secretValues: [], sensitiveOrigins: [] },
      sensitive: false,
    }),
  ).toEqual([]);
});
