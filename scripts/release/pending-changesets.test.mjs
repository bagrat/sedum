import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pendingChangesets } from "./pending-changesets.mjs";

async function changesetDirectory(files) {
  const directory = await mkdtemp(path.join(tmpdir(), "changesets-"));
  for (const [name, contents] of Object.entries(files))
    await writeFile(path.join(directory, name), contents);
  return directory;
}

describe("pendingChangesets", () => {
  it("lists changesets that pre mode has not applied yet", async () => {
    const directory = await changesetDirectory({
      "config.json": "{}",
      "pre.json": JSON.stringify({ mode: "pre", changesets: ["applied"] }),
      "README.md": "# Changesets",
      "applied.md": "---\n---\n",
      "screenshot-checks.md": "---\n---\n",
      "jev-vision.md": "---\n---\n",
    });
    assert.deepEqual(await pendingChangesets(directory), [
      "jev-vision",
      "screenshot-checks",
    ]);
  });

  it("treats every changeset as pending outside pre mode", async () => {
    const directory = await changesetDirectory({
      "config.json": "{}",
      "fix.md": "---\n---\n",
    });
    assert.deepEqual(await pendingChangesets(directory), ["fix"]);
  });

  it("finds none once the version PR applied them", async () => {
    const directory = await changesetDirectory({
      "pre.json": JSON.stringify({ mode: "pre", changesets: ["fix"] }),
      "fix.md": "---\n---\n",
    });
    assert.deepEqual(await pendingChangesets(directory), []);
  });
});
