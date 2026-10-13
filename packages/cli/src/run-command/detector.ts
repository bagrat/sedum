import { BugDetector } from "@sedum-dev/core";
import type { RunCommandOptions } from "../run-command.js";

/** One detector per run, shared by its lanes. */
export function createDetector(
  options: Pick<RunCommandOptions, "detect" | "detectAllow">,
): BugDetector | undefined {
  if (options.detect !== "browser") return undefined;
  return new BugDetector({ allow: options.detectAllow ?? [] });
}
