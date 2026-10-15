import path from "node:path";
import {
  loadProjectConfig,
  ProjectConfigError,
  type ResolvedProjectConfig,
} from "../config.js";
import type { BrowserKind } from "@sedum-dev/core";
import type { RunCommandOptions } from "../run-command.js";

const SUPPORTED_BROWSERS = new Set(["chrome", "chromium"]);

export async function resolveRunConfig(
  invocationRoot: string,
  options: RunCommandOptions,
): Promise<ResolvedProjectConfig> {
  validateBrowser(invocationRoot, options.browser);
  validateUrlOverride(invocationRoot, options.urlOverride);
  const config = await loadProjectConfig(invocationRoot, process.env, {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.browser ? { browser: options.browser as BrowserKind } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {}),
    ...(options.reporterDir ? { reporterDir: options.reporterDir } : {}),
    ...visionOverride(options),
    ...(options.screenshots === undefined
      ? {}
      : { screenshots: options.screenshots }),
  });
  validateVision(config);
  return config;
}

function validateBrowser(invocationRoot: string, browser?: string): void {
  if (!browser) return;
  if (SUPPORTED_BROWSERS.has(browser)) return;
  throw new ProjectConfigError([
    {
      code: "invalid_browser",
      file: path.join(invocationRoot, "sedum.config.yaml"),
      line: 1,
      col: 1,
      key: "browser",
      message: "Browser must be chrome or chromium.",
      fix: "Use --browser chrome or --browser chromium.",
    },
  ]);
}

function validateUrlOverride(invocationRoot: string, override?: string): void {
  if (!override) return;
  if (isValidOverride(override)) return;
  throw new ProjectConfigError([
    {
      code: "invalid_url_override",
      file: path.join(invocationRoot, "sedum.config.yaml"),
      line: 1,
      col: 1,
      key: "urlOverride",
      message:
        "The URL override must be an absolute HTTP(S) URL without credentials.",
      fix: "Use --url-override https://preview.example.com.",
    },
  ]);
}

function isValidOverride(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function visionOverride(options: RunCommandOptions): object {
  return options.vision === undefined
    ? {}
    : { vision: { enabled: options.vision } };
}

/** Vision reads a screenshot, so it needs the screenshots that a run may send. */
function validateVision(config: ResolvedProjectConfig): void {
  if (!config.vision.enabled || config.screenshots) return;
  throw new ProjectConfigError([
    {
      code: "vision_needs_screenshots",
      file:
        config.configPath ?? path.join(config.projectRoot, "sedum.config.yaml"),
      line: 1,
      col: 1,
      key: "vision.enabled",
      message:
        "Vision fallback sends screenshots to the provider, but screenshots are off for this run.",
      fix: "Use the TypeSafe API with screenshots on (the default there), or turn vision off with --no-vision.",
    },
  ]);
}
