import type { BrowserPage } from "../browser-driver.js";
import type { Operation } from "../page-protocol.js";
import {
  isRunWideProviderError,
  ProviderError,
  type ProviderCall,
  type TargetChecker,
} from "../provider.js";

/** At or above this probability of "several elements fit", the pick is refused. */
export const DEFAULT_MAX_SEVERAL = 0.5;
const OUTLINE_PAD = 4;

export interface TargetCheckOptions {
  readonly checker: TargetChecker;
  /** Defaults to DEFAULT_MAX_SEVERAL. */
  readonly maxSeveral?: number;
}

export type TargetCheckOutcome =
  | { readonly kind: "accepted" | "skipped" }
  | { readonly kind: "ambiguous"; readonly several: number };

interface TargetBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/**
 * Bring the target into view the way an action would, and return its box in
 * viewport pixels. Scrolling changes no DOM, so the page version holds.
 */
function targetBox(page: BrowserPage, ref: string): Promise<TargetBox | null> {
  return page.evaluate<TargetBox | null>(
    `((ref) => {
      const find = (root) => {
        for (const element of root.querySelectorAll("[data-sedum-ref]"))
          if (element.getAttribute("data-sedum-ref") === ref) return element;
        for (const element of root.querySelectorAll("*"))
          if (element.shadowRoot) {
            const inner = find(element.shadowRoot);
            if (inner) return inner;
          }
        return null;
      };
      const element = find(document);
      if (!element) return null;
      let rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.left < 0 || rect.bottom > innerHeight || rect.right > innerWidth) {
        element.scrollIntoView({ block: "center", inline: "center" });
        rect = element.getBoundingClientRect();
      }
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    })(${JSON.stringify(ref)})`,
  );
}

async function outlined(
  frame: Uint8Array,
  box: TargetBox,
): Promise<Buffer | null> {
  const x = Math.max(0, box.x - OUTLINE_PAD);
  const y = Math.max(0, box.y - OUTLINE_PAD);
  const width = Math.min(box.viewportWidth - x, box.width + 2 * OUTLINE_PAD);
  const height = Math.min(box.viewportHeight - y, box.height + 2 * OUTLINE_PAD);
  if (width < 1 || height < 1) return null;
  const { default: sharp } = await import("sharp");
  const image = sharp(frame);
  const metadata = await image.metadata();
  // captureFrame is CSS-scaled; refuse a frame that does not match the box.
  if (
    metadata.width !== box.viewportWidth ||
    metadata.height !== box.viewportHeight
  )
    return null;
  return image
    .composite([
      {
        input: Buffer.from(
          `<svg width="${box.viewportWidth}" height="${box.viewportHeight}" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="#ff00ff" stroke-width="3"/></svg>`,
        ),
      },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Ask the checker whether the resolved target is the only element the
 * sentence can mean. Fails open: a missing frame or a provider failure keeps
 * the pick, since the text resolver already accepted it. Run-wide provider
 * errors still stop the run.
 */
export async function checkTarget(input: {
  readonly page: BrowserPage;
  readonly ref: string;
  readonly sentence: string;
  readonly operation: Operation;
  readonly options: TargetCheckOptions;
  readonly calls: ProviderCall[];
  readonly signal: AbortSignal;
}): Promise<TargetCheckOutcome> {
  const { page, options } = input;
  if (!page.captureFrame) return { kind: "skipped" };
  try {
    const box = await targetBox(page, input.ref);
    if (!box || box.width < 1 || box.height < 1) return { kind: "skipped" };
    const image = await outlined(await page.captureFrame(), box);
    if (!image) return { kind: "skipped" };
    const decision = await options.checker.checkTarget(
      { sentence: input.sentence, operation: input.operation, image },
      { signal: input.signal },
    );
    input.calls.push(decision.call);
    const several = decision.several;
    return several >= (options.maxSeveral ?? DEFAULT_MAX_SEVERAL)
      ? { kind: "ambiguous", several }
      : { kind: "accepted" };
  } catch (error) {
    if (isRunWideProviderError(error)) throw error;
    if (error instanceof ProviderError && error.failedCall)
      input.calls.push(error.failedCall);
    return { kind: "skipped" };
  }
}
