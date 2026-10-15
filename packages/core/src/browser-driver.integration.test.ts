import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";

const browserIntegration = process.env.SEDUM_BROWSER_INTEGRATION === "1";

describe.skipIf(!browserIntegration)("Playwright browser integration", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><title>Fixture</title><main>fixture page</main>",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("opens, navigates, reads, and isolates contexts", async () => {
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const firstContext = await session.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const firstPage = await firstContext.newPage();
    await firstPage.goto(baseUrl);
    expect(await firstPage.text()).toContain("fixture page");
    await firstPage.evaluate(
      "document.cookie = 'sedum=first'; document.cookie",
    );

    const secondContext = await session.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(baseUrl);
    expect(await secondPage.evaluate<string>("document.cookie")).toBe("");

    await firstContext.close();
    await secondContext.close();
    await session.close();
  });

  // Windows has no SIGINT delivery through kill(): the child is terminated.
  it.skipIf(process.platform === "win32")(
    "lets a caller that handles SIGINT finish its work before exiting",
    async () => {
      // The built driver, as the CLI process loads it.
      const driver = new URL("../dist/index.js", import.meta.url).href;
      const directory = await mkdtemp(path.join(tmpdir(), "sedum-sigint-"));
      const marker = path.join(directory, "finished");
      const script = `
      import { writeFile } from "node:fs/promises";
      import { PlaywrightBrowserDriver } from ${JSON.stringify(driver)};
      const session = await new PlaywrightBrowserDriver({
        callerHandlesSignals: true,
      }).launch({ browser: "chromium" });
      process.on("SIGINT", async () => {
        await session.close();
        // Stand-in for writing the run's final files.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await writeFile(${JSON.stringify(marker)}, "finished");
        process.exit(130);
      });
      process.stdout.write("ready\\n");`;
      try {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        await new Promise<void>((resolve) =>
          child.stdout.once("data", () => resolve()),
        );
        child.kill("SIGINT");
        const code = await new Promise<number | null>((resolve) =>
          child.once("exit", resolve),
        );
        expect(code).toBe(130);
        expect(await readFile(marker, "utf8")).toBe("finished");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
