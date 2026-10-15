import type { BrowserPage } from "../browser-driver.js";
import { sameVersion } from "./candidates.js";
import type { LocatorDiagnostic, LocatorResult } from "../locator.js";
import { pageVersion } from "../page-bridge.js";
import type { Candidate, CandidatePage } from "../page-protocol.js";
import {
  isRunWideProviderError,
  ProviderError,
  unknownCostCall,
  type ProviderCall,
  type ProviderErrorCode,
} from "../provider.js";
import {
  captureVisionObservation,
  type VisionFailure,
  type VisionResolver,
} from "../vision.js";

type VisionDiagnostic = NonNullable<LocatorDiagnostic["vision"]>;

const FAILURES: Partial<Record<ProviderErrorCode, VisionFailure>> = {
  timeout: "timeout",
  connection: "connection",
  "retry-exhausted": "connection",
  "invalid-input": "invalid_input",
  "unsupported-input": "invalid_input",
  "invalid-response": "invalid_response",
};

export interface VisionFallbackContext {
  readonly page: BrowserPage;
  readonly resolver?: VisionResolver | undefined;
  readonly sentence: string;
  readonly source: CandidatePage;
  readonly candidates: readonly Candidate[];
  readonly calls: ProviderCall[];
  readonly signal: AbortSignal;
  readonly projectText?: ((text: string) => string) | undefined;
  readonly clickOperation: boolean;
  readonly ensureActive: () => void;
  readonly unresolved: (reason: "ambiguous" | "stale") => LocatorResult;
  readonly refresh: (
    candidate: Candidate,
    visual: true,
  ) => Promise<LocatorResult>;
  readonly gate: () => string | undefined;
  readonly updateGate: (gate: string) => void;
  readonly updateDiagnostic: (diagnostic: VisionDiagnostic) => void;
}

function suffixedGate(context: VisionFallbackContext, suffix: string): string {
  return `${context.gate()}:${suffix}`;
}

export class VisionFallback {
  constructor(private readonly context: VisionFallbackContext) {}

  async resolve(members: readonly Candidate[]): Promise<LocatorResult> {
    if (!this.available(members)) return this.context.unresolved("ambiguous");
    try {
      return await this.captureAndResolve();
    } catch (error) {
      if (isRunWideProviderError(error)) throw error;
      return this.captureFailure("vision_unavailable");
    }
  }

  private available(members: readonly Candidate[]): boolean {
    if (!this.context.resolver) return false;
    if (!this.context.clickOperation) return false;
    return members.length >= 2;
  }

  private async captureAndResolve(): Promise<LocatorResult> {
    const context = this.context;
    context.ensureActive();
    const captured = await captureVisionObservation(
      context.page,
      context.candidates,
      context.source.version,
      context.sentence,
      context.projectText,
    );
    context.ensureActive();
    if (!captured) return this.captureFailure();
    const response = await this.request(captured.observation);
    if ("result" in response) return response.result;
    return this.validateResponse(captured, response.answer, response.started);
  }

  private async request(
    observation: Parameters<VisionResolver["chooseFromScreenshot"]>[0],
  ) {
    const context = this.context;
    const started = performance.now();
    try {
      const answer = await context.resolver!.chooseFromScreenshot(observation, {
        signal: context.signal,
      });
      context.calls.push({ ...answer.call, modality: "vision" });
      return { answer, started };
    } catch (error) {
      context.calls.push({ ...unknownCostCall(error), modality: "vision" });
      // A rejected key or exhausted rate limit hits every later request too.
      if (isRunWideProviderError(error)) throw error;
      context.updateDiagnostic(this.requestFailure(error, started));
      context.updateGate(suffixedGate(context, "vision_error"));
      return { result: context.unresolved("ambiguous") };
    }
  }

  private requestFailure(error: unknown, started: number): VisionDiagnostic {
    const failure = this.context.signal.aborted
      ? "canceled"
      : error instanceof ProviderError
        ? (FAILURES[error.code] ?? "unknown")
        : "unknown";
    return {
      elapsedMs: performance.now() - started,
      failure,
      outcome: "failed",
      reason: this.context.gate() ?? "ambiguous",
    };
  }

  private async validateResponse(
    captured: Awaited<ReturnType<typeof captureVisionObservation>> & {},
    answer: Awaited<ReturnType<VisionResolver["chooseFromScreenshot"]>>,
    started: number,
  ): Promise<LocatorResult> {
    const context = this.context;
    let diagnostic: VisionDiagnostic = {
      elapsedMs: performance.now() - started,
      outcome: "failed",
      reason: context.gate() ?? "ambiguous",
    };
    context.updateDiagnostic(diagnostic);
    context.ensureActive();
    if (await this.pageChanged()) return this.staleAnswer(diagnostic);
    if (answer.decision.kind !== "candidate") {
      diagnostic = {
        ...diagnostic,
        outcome: "abstained",
        abstentionReason: answer.decision.reason,
      };
      context.updateDiagnostic(diagnostic);
      context.updateGate(suffixedGate(context, "vision_abstained"));
      return context.unresolved("ambiguous");
    }
    const selectedId = answer.decision.id;
    const index = captured.observation.candidates.findIndex(
      (candidate) => candidate.id === selectedId,
    );
    const target = captured.candidates[index];
    if (!target || target.disabled) return context.unresolved("ambiguous");
    context.updateGate(suffixedGate(context, "vision_selected"));
    return this.refreshVisual(target, diagnostic);
  }

  private staleAnswer(diagnostic: VisionDiagnostic): LocatorResult {
    this.context.updateDiagnostic({ ...diagnostic, failure: "stale_page" });
    this.context.updateGate(suffixedGate(this.context, "vision_stale"));
    return this.context.unresolved("ambiguous");
  }

  private async refreshVisual(
    target: Candidate,
    diagnostic: VisionDiagnostic,
  ): Promise<LocatorResult> {
    const result = await this.context.refresh(target, true);
    if (result.kind !== "resolved") {
      this.context.updateDiagnostic({ ...diagnostic, failure: "stale_page" });
      return this.context.unresolved("ambiguous");
    }
    const selected = { ...diagnostic, outcome: "selected" as const };
    this.context.updateDiagnostic(selected);
    return {
      ...result,
      diagnostic: { ...result.diagnostic, vision: selected },
    };
  }

  private async captureFailure(
    stableSuffix?: "vision_unavailable",
  ): Promise<LocatorResult> {
    if (await this.pageChanged()) {
      this.context.updateGate(
        suffixedGate(this.context, "vision_stale_capture"),
      );
      return this.context.unresolved("stale");
    }
    if (stableSuffix)
      this.context.updateGate(suffixedGate(this.context, stableSuffix));
    return this.context.unresolved("ambiguous");
  }

  private async pageChanged(): Promise<boolean> {
    return !sameVersion(
      await pageVersion(this.context.page),
      this.context.source.version,
    );
  }
}
