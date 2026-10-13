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

const privacy = {
  secretValues: [],
  sensitiveOrigins: ["https://auth.test"],
} as const;
const reported = async (message: string, url?: string) =>
  (
    await detectStep(
      page,
      {
        inspectStep: async () => [
          { check: "http_error", message, ...(url ? { url } : {}) },
        ],
      } as unknown as BugDetector,
      { privacy: { ...privacy, secretValues: [] }, sensitive: false },
    )
  )[0]!;

it("strips the query from a URL the collector clipped", async () => {
  const url = `https://bucket.test/report.pdf?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=${"f".repeat(400)}`;
  const clipped = `GET ${url.slice(0, 299)}… returned 403 Forbidden`;
  const detection = await reported(clipped, url);
  expect(detection.message).toBe(
    "GET https://bucket.test/report.pdf returned 403 Forbidden",
  );
  expect(detection.url).toBe("https://bucket.test/report.pdf");
  // A clip inside the path is still marked.
  expect(
    (await reported("GET https://bucket.test/rep… returned 404")).message,
  ).toBe("GET https://bucket.test/rep… returned 404");
});

it("strips queries from every URL Chrome quotes in a message", async () => {
  const detection = await reported(
    "Access to fetch at 'https://api.test/me?access_token=t0k3n' from origin 'https://app.test' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
  );
  expect(detection.message).toBe(
    "Access to fetch at 'https://api.test/me' from origin 'https://app.test' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
  );
});

it("keeps sentence punctuation and reduces sensitive origins in messages", async () => {
  expect(
    (await reported("Failed to load https://cdn.test/app.js?v=2. Retrying."))
      .message,
  ).toBe("Failed to load https://cdn.test/app.js. Retrying.");
  expect(
    (await reported("GET https://auth.test/session/42?code=abc returned 500"))
      .message,
  ).toBe("GET https://auth.test returned 500");
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
