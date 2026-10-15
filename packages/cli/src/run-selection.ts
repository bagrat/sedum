import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { minimatch } from "minimatch";
import {
  classifyParsedFlow,
  displayPath,
  FileClassificationCache,
  listTests,
  loadListingEntries,
  NOT_CHECKED_OFFLINE_CODE,
  resolveFlowModules,
  TEST_SUFFIXES,
  walkSuiteFiles,
  type ClassificationCache,
  type InvalidListEntry,
  type ListedDiagnostic,
  type ListedTest,
  type ParsedFlowResult,
  type RunResult,
} from "@sedum-dev/core";
import type { ResolvedProjectConfig } from "./config.js";
import { discoverConfiguredTests } from "./config.js";

export interface RunSelection {
  readonly tests: readonly ListedTest[];
  readonly invalid: readonly InvalidListEntry[];
  readonly problems: NonNullable<RunResult["discoveryProblems"]>;
}

export interface RunFilters {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly labels?: readonly string[];
  readonly names?: readonly string[];
  /** Exact test ids; rerun commands use these to select one test. */
  readonly ids?: readonly string[];
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Metadata selection is pure; every family must match, exclusions win. */
export function selectRunTests(
  tests: readonly ListedTest[],
  filters: RunFilters,
): readonly ListedTest[] {
  const includes = filters.include ?? [];
  const excludes = filters.exclude ?? [];
  const labels = filters.labels ?? [];
  const names = filters.names ?? [];
  const ids = filters.ids ?? [];
  return tests.filter(
    (test) =>
      (includes.length === 0 ||
        includes.some((glob) => minimatch(test.file, glob))) &&
      !excludes.some((glob) => minimatch(test.file, glob)) &&
      labels.every((label) => test.tags.includes(label)) &&
      (ids.length === 0 || ids.includes(test.id)) &&
      (names.length === 0 ||
        names.some((name) =>
          `${test.id}\n${test.description ?? ""}`
            .toLowerCase()
            .includes(name.toLowerCase()),
        )),
  );
}

/** A named symlink is refused before reading so its target cannot change after containment checking. */
export async function discoverRunTests(
  config: ResolvedProjectConfig,
  paths: readonly string[],
  filters: RunFilters = {},
): Promise<RunSelection> {
  const problems: NonNullable<RunResult["discoveryProblems"]>[number][] = [];
  const files = new Set<string>();
  const root = await realpath(config.projectRoot);
  if (paths.length === 0) {
    for (const file of await discoverConfiguredTests(config)) {
      const target = await realpath(file);
      if (contained(root, target)) files.add(target);
      else
        problems.push({
          file: "<outside-project>",
          code: "outside_root",
          message: "A configured test is outside the project root.",
          fix: "Keep the test directory inside the project.",
        });
    }
  } else {
    for (const requested of paths) {
      const candidate = path.resolve(config.projectRoot, requested);
      const namedInside = contained(config.projectRoot, candidate);
      const file = namedInside
        ? path.relative(config.projectRoot, candidate).split(path.sep).join("/")
        : "<outside-project>";
      if (!namedInside) {
        problems.push({
          file,
          code: "outside_root",
          message: "Path is outside the project root.",
          fix: "Choose a path inside the project.",
        });
        continue;
      }
      let info;
      try {
        info = await lstat(candidate);
      } catch {
        problems.push({
          file,
          code: "missing_path",
          message: "Path does not exist.",
          fix: "Check the path and rerun.",
        });
        continue;
      }
      if (info.isSymbolicLink()) {
        problems.push({
          file,
          code: "symlinked_path",
          message: "Symlinked test paths are not supported.",
          fix: "Name the regular file.",
        });
        continue;
      }
      const target = await realpath(candidate).catch(() => candidate);
      if (!contained(root, target)) {
        problems.push({
          file,
          code: "outside_root",
          message: "Path is outside the project root.",
          fix: "Choose a path inside the project.",
        });
        continue;
      }
      if (info.isDirectory()) {
        for (const file of await walkSuiteFiles(
          target,
          TEST_SUFFIXES,
          (folder) => {
            problems.push({
              file: path.relative(root, folder),
              code: "unreadable_directory",
              message: "Directory could not be read.",
              fix: "Check permissions.",
            });
          },
        ))
          files.add(file);
      } else if (
        info.isFile() &&
        TEST_SUFFIXES.some((suffix) => candidate.endsWith(suffix))
      )
        files.add(target);
      else
        problems.push({
          file,
          code: "unsupported_file",
          message: "Expected a *.test.ts or *.test.yaml file, or a directory.",
          fix: "Choose a test path.",
        });
    }
  }
  const parsed = await loadListingEntries([...files].sort(), {
    repoRoot: root,
    rejectSymlinks: true,
  });
  const listing = listTests(parsed, { repoRoot: root });
  return {
    tests: selectRunTests(listing.tests, filters),
    invalid: await withSentenceErrors(listing.invalid, parsed, {
      root,
      cache: await FileClassificationCache.load(
        path.join(root, ".sedum", "classifications.json"),
        config.providerModel,
        config.providerName,
      ),
    }),
    problems,
  };
}

const diagnosticKey = (item: ListedDiagnostic): string =>
  `${item.code}:${item.line}:${item.col}`;

/**
 * A file that failed format can still have sentences that offline validation
 * rejects, such as an unsupported verb or two actions in one step. Report
 * them with the format errors, as `sedum validate` does, so one run names
 * every problem in the file. A sentence only the model can classify is left
 * for the run.
 */
async function withSentenceErrors(
  invalid: readonly InvalidListEntry[],
  parsed: readonly {
    readonly file: string;
    readonly result: ParsedFlowResult;
  }[],
  options: { readonly root: string; readonly cache: ClassificationCache },
): Promise<InvalidListEntry[]> {
  return Promise.all(
    invalid.map(async (entry) => {
      const found = parsed.find(
        (item) =>
          item.result.candidate !== undefined &&
          displayPath(options.root, item.file) === entry.file,
      );
      if (!found) return entry;
      const resolved = await resolveFlowModules(found.result, {
        repoRoot: options.root,
        partial: true,
      });
      const classified = await classifyParsedFlow(resolved, {
        mode: "offline",
        cache: options.cache,
      });
      const seen = new Set(entry.diagnostics.map(diagnosticKey));
      const extra = classified.diagnostics
        .filter(
          (item) =>
            item.severity === "error" &&
            item.code !== NOT_CHECKED_OFFLINE_CODE &&
            item.source.file === found.file,
        )
        .map((item) => ({
          severity: item.severity,
          code: item.code,
          line: item.source.line,
          col: item.source.col,
          message: item.message,
          fix: item.fix,
        }))
        .filter((item) => !seen.has(diagnosticKey(item)));
      return {
        file: entry.file,
        diagnostics: [...entry.diagnostics, ...extra].sort(
          (a, b) => a.line - b.line || a.col - b.col,
        ),
      };
    }),
  );
}
