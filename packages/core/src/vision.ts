import type { BrowserPage } from "./browser-driver.js";
import { pageVersion, quietPage, visualCandidates } from "./page-bridge.js";
import type { Candidate, PageVersion } from "./page-protocol.js";
import type { ProviderCall, ProviderCallOptions } from "./provider.js";

export interface VisionObservation {
  readonly instruction: string;
  /** PNG of the viewport with each candidate boxed and labelled by its ID. */
  readonly image: Uint8Array;
  readonly candidates: readonly { id: string; name: string; role: string }[];
}
export interface VisionResolver {
  chooseFromScreenshot(
    observation: VisionObservation,
    options?: ProviderCallOptions,
  ): Promise<{
    decision:
      { kind: "candidate"; id: string } | { kind: "abstain"; reason: string };
    call: ProviderCall;
  }>;
}

/** Why a vision request produced no decision; run-wide errors stop the run instead. */
export type VisionFailure =
  "timeout" | "canceled" | "connection" | "invalid_input" | "invalid_response";

export function sameVisualVersion(a: PageVersion, b: PageVersion): boolean {
  return (
    a.document === b.document &&
    a.route === b.route &&
    a.revision === b.revision
  );
}

/** Labels are drawn in image memory, never inserted into the live DOM. */
export async function captureVisionObservation(
  page: BrowserPage,
  candidates: readonly Candidate[],
  version: PageVersion,
  instruction: string,
  projectText: (text: string) => string = (text) => text,
): Promise<{
  observation: VisionObservation;
  candidates: readonly Candidate[];
} | null> {
  if (!page.captureFrame) return null;
  // Navigation can look ready while delayed UI work (for example a closing
  // menu) is still pending. Settle before spending the single vision request,
  // using the same bounded quiet period as the runner's stale re-observation.
  // Never relabel an old candidate set against a newer page revision.
  const settled = await quietPage(page, 1_000, 4_000);
  if (!settled.quiet || !sameVisualVersion(settled.version, version))
    return null;
  const visual = await visualCandidates(page);
  if (!sameVisualVersion(visual.version, version)) return null;
  const boxes = visual.boxes.filter((box) =>
    candidates.some((candidate) => candidate.ref === box.ref),
  );
  if (boxes.length < 2 || boxes.length > 40) return null;
  const image = await page.captureFrame();
  if (!sameVisualVersion(await pageVersion(page), version)) return null;
  const { default: sharp } = await import("sharp");
  const metadata = await sharp(image).metadata();
  if (metadata.width !== visual.width || metadata.height !== visual.height)
    return null;
  const labels = boxes
    .map(
      (box, index) =>
        `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="#e11d48" stroke-width="3"/><rect x="${box.x}" y="${Math.max(0, box.y - 22)}" width="42" height="22" fill="#e11d48"/><text x="${box.x + 3}" y="${Math.max(0, box.y - 22) + 16}" fill="white" font-size="15" font-family="sans-serif">C${index + 1}</text>`,
    )
    .join("");
  const annotated = await sharp(image)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${visual.width}" height="${visual.height}" xmlns="http://www.w3.org/2000/svg">${labels}</svg>`,
        ),
      },
    ])
    .png()
    .toBuffer();
  const visible = boxes.map((box) =>
    candidates.find((candidate) => candidate.ref === box.ref)!,
  );
  return {
    candidates: visible,
    observation: {
      instruction: projectText(instruction),
      image: annotated,
      candidates: visible.map((candidate, index) => ({
        id: `C${index + 1}`,
        name: projectText(candidate.name),
        role: candidate.role,
      })),
    },
  };
}
