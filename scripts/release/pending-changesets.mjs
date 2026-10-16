import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Changesets not yet applied to the package versions. In pre mode, applied
 * changesets stay in the directory and are listed in pre.json.
 */
export async function pendingChangesets(directory = ".changeset") {
  const files = await readdir(directory);
  let applied = [];
  if (files.includes("pre.json")) {
    const pre = JSON.parse(
      await readFile(path.join(directory, "pre.json"), "utf8"),
    );
    applied = pre.changesets ?? [];
  }
  return files
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => file.slice(0, -".md".length))
    .filter((name) => !applied.includes(name))
    .sort();
}
