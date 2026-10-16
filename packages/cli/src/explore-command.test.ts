import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { exploreDetect, exploreSafe } from "./cli-arguments.js";
import {
  exploreMode,
  exploreProvider,
  seedValue,
  startUrl,
  watchOrigin,
} from "./explore-command.js";
import { runCli } from "./run-cli.js";

describe("explore arguments", () => {
  it("accepts seeds, modes and absolute web URLs", () => {
    expect(seedValue("0")).toBe(0);
    expect(seedValue("2147483647")).toBe(2147483647);
    expect(exploreMode("random")).toBe("random");
    expect(startUrl("https://example.test/a")).toBe("https://example.test/a");
  });

  it("collects watched origins", () => {
    expect(watchOrigin("https://api.example.test/v1")).toEqual([
      "https://api.example.test",
    ]);
    expect(watchOrigin("https://b.test", ["https://a.test"])).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("rejects malformed values", () => {
    for (const bad of ["-1", "1.5", "2147483648", "x", ""])
      expect(() => seedValue(bad)).toThrow(InvalidArgumentError);
    expect(() => exploreMode("smart")).toThrow(InvalidArgumentError);
    expect(exploreDetect("semantic")).toBe("semantic");
    expect(() => exploreDetect("off")).toThrow(/browser or semantic/u);
    expect(() => startUrl("file:///etc/passwd")).toThrow(InvalidArgumentError);
    expect(() => startUrl("/relative")).toThrow(InvalidArgumentError);
  });

  it("needs a start URL unless it replays a trace", async () => {
    const output = await runCli(["explore", "--mode", "random"], "0.0.0");
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("Missing start URL");
  });

  it("asks for guided mode with --detect semantic", async () => {
    const output = await runCli(
      [
        "explore",
        "https://example.test/",
        "--mode",
        "random",
        "--detect",
        "semantic",
      ],
      "0.0.0",
    );
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("--mode guided");
  });

  it("rejects malformed --detect-allow rules", async () => {
    const output = await runCli(
      [
        "explore",
        "https://example.test/",
        "--detect-allow",
        "console_error:re:(",
      ],
      "0.0.0",
    );
    expect(output.exitCode).not.toBe(0);
  });

  it("takes --safe and --safe strict, and has no --allow-destructive", async () => {
    expect(exploreSafe("strict")).toBe("strict");
    expect(() => exploreSafe("maybe")).toThrow(/--safe strict/u);
    const removed = await runCli(
      ["explore", "https://example.test/", "--allow-destructive"],
      "0.0.0",
    );
    expect(removed.exitCode).not.toBe(0);
    expect(removed.stderr).toContain("unknown option");
  });

  it("reruns only an exploration trace", async () => {
    const output = await runCli(
      ["explore", "--rerun", "package.json"],
      "0.0.0",
    );
    expect(output.exitCode).not.toBe(0);
  });
});

describe("explore provider settings", () => {
  it("reads TYPESAFE_* from the project-root .env, under the shell's values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-explore-env-"));
    try {
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        "browser: chromium\n",
      );
      await writeFile(
        path.join(root, ".env"),
        "TYPESAFE_API_KEY=file-key\nTYPESAFE_DEFAULT_MODEL=file-model\n",
      );
      const nested = path.join(root, "pages");
      await mkdir(nested);
      expect(await exploreProvider(nested, {})).toEqual({
        apiKey: "file-key",
        model: "file-model",
      });
      expect(
        await exploreProvider(nested, { TYPESAFE_API_KEY: "shell-key" }),
      ).toEqual({ apiKey: "shell-key", model: "file-model" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
