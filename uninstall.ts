#!/usr/bin/env node
/**
 * Retemper uninstaller — removes what install.ts wrote.
 *
 *   node uninstall.ts --help
 *   node uninstall.ts                          # --all: every recorded install
 *   node uninstall.ts --all --dry-run
 *   node uninstall.ts --yes                    # skip the confirmation prompt
 *   node uninstall.ts --platform grok --scope user
 *   node uninstall.ts --platform grok,codex --scope user
 *   node uninstall.ts --platform codex --scope project --target /path/to/repo
 *
 * Every planned path is printed first; nothing is removed before you accept
 * the y/N prompt (or pass --yes). CODING_STANDARDS.md is never removed.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import {
  formatInstalls,
  installsPath,
  NAME,
  parseInstalls,
  planInstall,
  retemperHome,
  SUPPORTED_PLATFORMS,
  SUPPORTED_SCOPES,
} from "./install.ts";
import type { InstallEntry, InstallPlan, ValidInstall } from "./install.ts";

export type ParsedUninstallArgs = {
  help: boolean;
  dryRun: boolean;
  yes: boolean;
  allExplicit: boolean;
  all: boolean;
  platforms: string[];
  scope: string;
  target: string;
};

export type RemovalGroup = {
  record: ValidInstall;
  plan: InstallPlan;
  paths: string[];
};

function splitPlatformList(value: unknown): string[] {
  return String(value)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function takePlatforms(
  rest: string[],
  index: number,
  token: string,
): { names: string[]; index: number } {
  const names: string[] = [];
  if (token.startsWith("--platform=")) {
    names.push(...splitPlatformList(token.slice("--platform=".length)));
    return { names, index };
  }
  let i = index;
  while (i + 1 < rest.length && !String(rest[i + 1]).startsWith("-")) {
    names.push(...splitPlatformList(rest[i + 1]));
    i += 1;
  }
  return { names, index: i };
}

export function parseUninstallArgs(argv: string[]): ParsedUninstallArgs {
  const out: ParsedUninstallArgs = {
    help: false,
    dryRun: false,
    yes: false,
    allExplicit: false,
    all: false,
    platforms: [],
    scope: "",
    target: "",
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--dry-run") out.dryRun = true;
    else if (token === "--yes" || token === "-y") out.yes = true;
    else if (token === "--all") out.allExplicit = true;
    else if (token === "--platform" || token.startsWith("--platform=")) {
      const taken = takePlatforms(rest, i, token);
      out.platforms.push(...taken.names);
      i = taken.index;
    } else if (token === "--scope") out.scope = String(rest[++i] || "");
    else if (token === "--target") out.target = String(rest[++i] || "");
    else throw new Error(`Unknown argument: ${token}`);
  }
  out.platforms = uniqueNames(out.platforms);
  const hasFilters = Boolean(out.platforms.length || out.scope || out.target);
  out.all = !hasFilters;
  return out;
}

export function validateUninstallArgs(opts: ParsedUninstallArgs): void {
  const filtered = Boolean(opts.platforms.length || opts.scope || opts.target);
  if (opts.allExplicit && filtered) {
    throw new Error("Use either --all or explicit --platform/--scope/--target filters, not both.");
  }
  if (opts.all) return;
  if (!opts.platforms.length) {
    throw new Error(
      'Unsupported platform "(missing)". Pick platform=grok, platform=codex, or platform=copilot.',
    );
  }
  for (const platform of opts.platforms) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(
        `Unsupported platform "${platform}". Pick platform=grok, platform=codex, or platform=copilot.`,
      );
    }
  }
  if (!SUPPORTED_SCOPES.includes(opts.scope)) {
    throw new Error(`Unsupported scope "${opts.scope || "(missing)"}". Pick scope=user or scope=project.`);
  }
  if (opts.scope === "project" && !opts.target) {
    throw new Error("--target <dir> is required with --scope project for safe removal.");
  }
}

export function removalPaths(plan: InstallPlan): string[] {
  const candidates = [
    plan.workflowDest,
    plan.skillDest,
    plan.orchestrateDest,
    plan.refsDest,
    ...plan.skillDests,
    ...(plan.skillLinks || []).map((link) => link.dest),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const path of candidates) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  paths.sort((a, b) => b.length - a.length);
  return paths;
}

export function buildGroups(records: ValidInstall[], opts: ParsedUninstallArgs): RemovalGroup[] {
  if (opts.all) {
    return records.map((record) => {
      const plan = planInstall({
        platform: record.platform,
        scope: record.scope,
        target: record.path,
      });
      return { record, plan, paths: removalPaths(plan) };
    });
  }
  const groups: RemovalGroup[] = [];
  for (const platform of opts.platforms) {
    const plan = planInstall({ platform, scope: opts.scope, target: opts.target });
    groups.push({
      record: { platform, scope: opts.scope, path: plan.targetRoot },
      plan,
      paths: removalPaths(plan),
    });
  }
  return groups;
}

function matchesRecord(entry: ValidInstall, record: ValidInstall): boolean {
  if (entry.platform !== record.platform || entry.scope !== record.scope) return false;
  if (entry.scope === "user") return true;
  try {
    return resolve(entry.path) === resolve(record.path);
  } catch {
    return entry.path === record.path;
  }
}

export function matchedEntries(entries: InstallEntry[], groups: RemovalGroup[]): ValidInstall[] {
  return entries.filter(
    (entry): entry is ValidInstall =>
      !entry.invalid && groups.some((group) => matchesRecord(entry, group.record)),
  );
}

function pathState(path: string): "present" | "missing" {
  try {
    lstatSync(path);
    return "present";
  } catch {
    return "missing";
  }
}

export function describeRemoval(
  groups: RemovalGroup[],
  filePath: string,
  forgetCount: number,
  opts: { dryRun?: boolean },
): string {
  const lines: string[] = ["retemper uninstall — planned removals", ""];
  let total = 0;
  let present = 0;
  for (const group of groups) {
    lines.push(`${group.plan.platform} ${group.plan.scope} (root: ${group.plan.targetRoot})`);
    for (const path of group.paths) {
      const state = pathState(path);
      if (state === "present") present += 1;
      total += 1;
      lines.push(`  [${state}] remove ${path}`);
    }
  }
  if (!present) lines.push("  (no files found)");
  lines.push("");
  lines.push("kept: CODING_STANDARDS.md is never removed.");
  lines.push(`tracking: ${forgetCount} record(s) will be dropped from ${filePath}`);
  lines.push("");
  if (opts.dryRun) lines.push("dry-run: no files removed, no prompt");
  return lines.join("\n");
}

function confirmRemoval(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolvePrompt) => {
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolvePrompt(Boolean(answer && /^(y|yes)$/i.test(answer.trim())));
    };
    rl.on("close", () => finish(null));
    rl.question("Proceed with removal? [y/N] ").then(
      (answer: string) => finish(answer),
      () => finish(null),
    );
  });
}

function withinRoot(path: string, root: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix);
}

function pruneEmptyParents(removedPaths: string[], root: string): void {
  for (const path of removedPaths) {
    let current = dirname(path);
    while (withinRoot(current, root) && current !== root) {
      try {
        rmdirSync(current);
      } catch {
        break;
      }
      current = dirname(current);
    }
  }
}

function applyRemovals(groups: RemovalGroup[]): number {
  const jobs: { path: string; root: string }[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const path of group.paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      jobs.push({ path, root: group.plan.targetRoot });
    }
  }
  let removed = 0;
  for (const job of jobs) {
    if (pathState(job.path) === "missing") continue;
    rmSync(job.path, { recursive: true, force: true });
    removed += 1;
    pruneEmptyParents([job.path], job.root);
  }
  return removed;
}

function writeTracking(entries: InstallEntry[], filePath: string): void {
  if (!entries.length) {
    rmSync(filePath, { force: true });
    try {
      rmdirSync(retemperHome());
    } catch {
      return;
    }
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, formatInstalls(entries));
  renameSync(tmp, filePath);
}

function applyTrackingUpdates(filePath: string, groups: RemovalGroup[], opts: ParsedUninstallArgs): void {
  if (opts.dryRun) return;
  if (!existsSync(filePath)) return;
  const entries = parseInstalls(readFileSync(filePath, "utf8"));
  const matched = matchedEntries(entries, groups);
  if (!matched.length) return;
  const matchedSet = new Set(matched);
  const kept = entries.filter((entry) => entry.invalid || !matchedSet.has(entry));
  writeTracking(kept, filePath);
}

function readValidRecords(filePath: string): { entries: InstallEntry[]; valid: ValidInstall[] } | null {
  if (!existsSync(filePath)) return null;
  const entries = parseInstalls(readFileSync(filePath, "utf8"));
  return {
    entries,
    valid: entries.filter((entry): entry is ValidInstall => !entry.invalid),
  };
}

export function helpText(): string {
  return [
    "retemper uninstaller",
    "",
    "Removes the files the installer wrote. Prints every path first;",
    "nothing is deleted until you accept.",
    "",
    "Usage:",
    "  node uninstall.ts [--all] [--dry-run] [--yes]",
    "  node uninstall.ts --platform grok --scope user [--dry-run] [--yes]",
    "  node uninstall.ts --platform grok,codex --scope user",
    "  node uninstall.ts --platform codex --scope project --target <repo> [--yes]",
    "  node retemper.ts uninstall [same flags]",
    "",
    "Options:",
    "  --all                     Remove every install recorded in ~/.retemper/installs.txt",
    "                            ($RETEMPER_HOME/installs.txt). Default when no filter is given.",
    "  --platform grok|codex|copilot[,...]",
    "                            Only these platforms; repeat the flag, commas, or spaces",
    "  --scope user|project      Only this scope",
    "  --target <dir>            Required with --scope project",
    "  --dry-run                 Print the paths, remove nothing, never prompts",
    "  --yes, -y                 Skip the confirmation prompt",
    "  --help                    This text",
    "",
    "Notes:",
    "  CODING_STANDARDS.md is never removed.",
    "  grill-me, grilling, and orchestrate skills installed alongside retemper go with it,",
    "  including $CODEX_HOME/skills symlinks for user-scope installs.",
    "  The prompt accepts y or yes; anything else, including EOF, aborts.",
    "  Empty folders left behind are cleaned up; install roots themselves stay.",
  ].join("\n");
}

export async function uninstallMain(argv: string[] = process.argv): Promise<number> {
  const opts = parseUninstallArgs(argv);
  if (opts.help) {
    console.log(helpText());
    return 0;
  }
  validateUninstallArgs(opts);

  const filePath = installsPath();
  let groups: RemovalGroup[] = [];
  let forgetCount = 0;

  if (opts.all) {
    const records = readValidRecords(filePath);
    if (records === null || records.valid.length === 0) {
      console.log(describeRemoval([], filePath, 0, opts));
      console.log("Nothing to uninstall.");
      return 0;
    }
    forgetCount = records.valid.length;
    groups = buildGroups(records.valid, opts);
  } else {
    groups = buildGroups([], opts);
    if (existsSync(filePath)) {
      forgetCount = matchedEntries(parseInstalls(readFileSync(filePath, "utf8")), groups).length;
    }
  }

  console.log(describeRemoval(groups, filePath, forgetCount, opts));
  if (opts.dryRun) {
    return 0;
  }

  if (!opts.yes) {
    const accepted = await confirmRemoval();
    if (!accepted) {
      console.log("Aborted. Nothing was removed.");
      return 0;
    }
  }

  applyRemovals(groups);
  applyTrackingUpdates(filePath, groups, opts);
  console.log(`uninstalled ${NAME}`);
  return 0;
}

function invokedAsThisModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

if (invokedAsThisModule(import.meta.url)) {
  try {
    const code = await uninstallMain();
    if (typeof code === "number" && code !== 0) process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
