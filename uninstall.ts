#!/usr/bin/env node
/** Retemper uninstaller with verified, file-level ownership. */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import {
  agentsHome,
  formatInstalls,
  grokHome,
  installsPath,
  NAME,
  parseInstalls,
  planInstall,
  retemperHome,
  SUPPORTED_PLATFORMS,
  SUPPORTED_SCOPES,
} from "./install.ts";
import type { InstallEntry, InstallPlan, ValidInstall } from "./install.ts";
import {
  createLegacyInstallManifest,
  finalizeInstallManifestRemoval,
  isMissingPathError,
  ownedEntryKey,
  readInstallManifest,
  removeInstallManifest,
} from "./lib/install-manifest.ts";
import type { InstallManifest, OwnedEntry, PhysicalDirectory, PhysicalRoot } from "./lib/install-manifest.ts";
import {
  acquireStateLock,
  assertNoOwnershipTransaction,
  assertStateGeneration,
  readStateGeneration,
  releaseStateLock,
  rotateStateGeneration,
} from "./lib/install-state.ts";

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

type LoadedInstall = { record: ValidInstall; manifest: InstallManifest; legacy: boolean };
type RemovalState = "remove" | "missing" | "modified" | "shared";
type RemovalJob = {
  owner: LoadedInstall;
  entry: OwnedEntry;
  path: string;
  key: string;
  state: RemovalState;
};
type TrackingSnapshot = {
  filePath: string;
  text: string | null;
  entries: InstallEntry[];
  valid: ValidInstall[];
};
type UninstallPlan = {
  generation: string;
  snapshot: TrackingSnapshot;
  selected: Set<ValidInstall>;
  installs: LoadedInstall[];
  jobs: RemovalJob[];
};

function nodeErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function supportedPlatformList(): string {
  if (SUPPORTED_PLATFORMS.length < 2) return SUPPORTED_PLATFORMS.join("");
  return `${SUPPORTED_PLATFORMS.slice(0, -1).join(", ")}, or ${SUPPORTED_PLATFORMS.at(-1)}`;
}

function splitPlatformList(value: unknown): string[] {
  return String(value).split(",").map((name) => name.trim()).filter(Boolean);
}

function takePlatforms(rest: string[], index: number, token: string): { names: string[]; index: number } {
  const names: string[] = [];
  if (token.startsWith("--platform=")) {
    names.push(...splitPlatformList(token.slice("--platform=".length)));
    if (!names.length) throw new Error("--platform requires a value.");
    return { names, index };
  }
  let next = index;
  while (next + 1 < rest.length && !rest[next + 1].startsWith("-")) {
    names.push(...splitPlatformList(rest[next + 1]));
    next += 1;
  }
  if (!names.length) throw new Error("--platform requires a value.");
  return { names, index: next };
}

function takeOptionValue(
  rest: string[],
  index: number,
  token: string,
  option: string,
): { value: string; index: number } {
  const prefix = `${option}=`;
  if (token.startsWith(prefix)) {
    const value = token.slice(prefix.length);
    if (!value) throw new Error(`${option} requires a value.`);
    return { value, index };
  }
  const value = rest[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value.`);
  return { value, index: index + 1 };
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
  let filterSeen = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--dry-run") out.dryRun = true;
    else if (token === "--yes" || token === "-y") out.yes = true;
    else if (token === "--all") out.allExplicit = true;
    else if (token === "--platform" || token.startsWith("--platform=")) {
      filterSeen = true;
      const taken = takePlatforms(rest, index, token);
      out.platforms.push(...taken.names);
      index = taken.index;
    } else if (token === "--scope" || token.startsWith("--scope=")) {
      filterSeen = true;
      const taken = takeOptionValue(rest, index, token, "--scope");
      out.scope = taken.value;
      index = taken.index;
    } else if (token === "--target" || token.startsWith("--target=")) {
      filterSeen = true;
      const taken = takeOptionValue(rest, index, token, "--target");
      out.target = taken.value;
      index = taken.index;
    } else throw new Error(`Unknown argument: ${token}`);
  }
  out.platforms = [...new Set(out.platforms)];
  out.all = !filterSeen;
  return out;
}

export function validateUninstallArgs(opts: ParsedUninstallArgs): void {
  const filtered = Boolean(opts.platforms.length || opts.scope || opts.target);
  if (opts.allExplicit && filtered) {
    throw new Error("Use either --all or explicit --platform/--scope/--target filters, not both.");
  }
  if (opts.all) return;
  if (!opts.platforms.length) throw new Error(`Unsupported platform "(missing)". Pick ${supportedPlatformList()}.`);
  for (const platform of opts.platforms) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(`Unsupported platform "${platform}". Pick ${supportedPlatformList()}.`);
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
    ...plan.skillLinks.map((link) => link.dest),
  ];
  return [...new Set(candidates.filter((path): path is string => Boolean(path)))]
    .sort((left, right) => right.length - left.length);
}

function sameRecordDestination(left: ValidInstall, right: ValidInstall): boolean {
  if (left.platform !== right.platform || left.scope !== right.scope) return false;
  if (left.scope === "user") return true;
  return resolve(left.path) === resolve(right.path);
}

export function matchedEntries(entries: InstallEntry[], records: { record: ValidInstall }[]): ValidInstall[] {
  return entries.filter(
    (entry): entry is ValidInstall =>
      !entry.invalid && records.some(({ record }) => sameRecordDestination(entry, record)),
  );
}

function readTracking(filePath: string): TrackingSnapshot {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { filePath, text: null, entries: [], valid: [] };
    throw error;
  }
  const entries = parseInstalls(text);
  return {
    filePath,
    text,
    entries,
    valid: entries.filter((entry): entry is ValidInstall => !entry.invalid),
  };
}

function selectedRecords(snapshot: TrackingSnapshot, opts: ParsedUninstallArgs): ValidInstall[] {
  if (opts.all) return snapshot.valid;
  const requested = opts.platforms.map((platform) => ({
    record: { platform, scope: opts.scope, path: resolve(opts.target || ".") },
  }));
  return matchedEntries(snapshot.entries, requested);
}

function legacyMigrationError(record: ValidInstall, reason: string): Error {
  return new Error(
    `Legacy install record cannot be safely uninstalled (${record.platform} ${record.scope} ${record.path}): ${reason}. ` +
    "Restore the recorded homes, then reinstall or run update to migrate ownership metadata.",
  );
}

function expectedLegacyHome(record: ValidInstall): string | null {
  if (record.scope !== "user") return null;
  return record.platform === "grok" ? grokHome() : agentsHome();
}

function assertUnaliasedRoot(record: ValidInstall, path: string): void {
  if (!isAbsolute(path)) throw legacyMigrationError(record, "the recorded root is not absolute");
  try {
    if (realpathSync(path) !== resolve(path)) {
      throw legacyMigrationError(record, `the root is an unverified filesystem alias: ${path}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) throw legacyMigrationError(record, `the recorded root is missing: ${path}`);
    throw error;
  }
}

function assertLegacyDirectoriesUnaliased(record: ValidInstall, manifest: InstallManifest): void {
  for (const directory of manifest.directories) {
    const path = join(manifest.roots[directory.root].path, directory.relativePath);
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissingPathError(error)) throw legacyMigrationError(record, `an expected directory is missing: ${path}`);
      throw error;
    }
    if (stats.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
      throw legacyMigrationError(record, `an intermediate path is an unverified filesystem alias: ${path}`);
    }
  }
}

function loadLegacyInstall(record: ValidInstall): LoadedInstall {
  const expectedHome = expectedLegacyHome(record);
  if (expectedHome && resolve(expectedHome) !== resolve(record.path)) {
    throw legacyMigrationError(record, "current homes differ from the recorded destination");
  }
  if (record.platform === "codex" && record.scope === "user") {
    throw legacyMigrationError(record, "the Codex compatibility home was not recorded");
  }
  assertUnaliasedRoot(record, record.path);
  const plan = planInstall({ platform: record.platform, scope: record.scope, target: record.path });
  const manifest = createLegacyInstallManifest(plan, record);
  for (const root of manifest.roots) assertUnaliasedRoot(record, root.path);
  assertLegacyDirectoriesUnaliased(record, manifest);
  return { record, manifest, legacy: true };
}

function loadInstall(record: ValidInstall): LoadedInstall {
  const manifest = readInstallManifest(retemperHome(), record);
  return manifest ? { record, manifest, legacy: false } : loadLegacyInstall(record);
}

function verifyPhysicalIdentity(
  path: string,
  expected: Pick<PhysicalRoot | PhysicalDirectory, "realPath" | "device" | "inode">,
): boolean {
  let realPath: string;
  let stats;
  try {
    realPath = realpathSync(path);
    stats = statSync(path, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  if (realPath !== expected.realPath || String(stats.dev) !== expected.device || String(stats.ino) !== expected.inode) {
    throw new Error(`Recorded physical identity changed at ${path}; refusing a possibly retargeted removal.`);
  }
  return true;
}

function verifyManifestIdentity(manifest: InstallManifest): void {
  for (const root of manifest.roots) verifyPhysicalIdentity(root.path, root);
  for (const directory of manifest.directories) {
    verifyPhysicalIdentity(join(manifest.roots[directory.root].path, directory.relativePath), directory);
  }
}

function entryPath(manifest: InstallManifest, entry: OwnedEntry): string {
  return join(manifest.roots[entry.root].path, entry.relativePath);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inspectEntry(manifest: InstallManifest, entry: OwnedEntry): "remove" | "missing" | "modified" {
  const path = entryPath(manifest, entry);
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return "missing";
    throw error;
  }
  if (entry.kind === "file") {
    if (!stats.isFile() || realpathSync(path) !== entry.realPath) return "modified";
    return sha256File(path) === entry.sha256 ? "remove" : "modified";
  }
  if (!stats.isSymbolicLink()) return "modified";
  return resolve(dirname(path), readlinkSync(path)) === entry.target ? "remove" : "modified";
}

function preflight(all: LoadedInstall[], selected: Set<ValidInstall>): RemovalJob[] {
  for (const install of all) verifyManifestIdentity(install.manifest);
  const protectedEntries = new Set<string>();
  for (const install of all) {
    if (selected.has(install.record)) continue;
    for (const entry of install.manifest.entries) protectedEntries.add(ownedEntryKey(install.manifest, entry));
  }
  const jobs = new Map<string, RemovalJob>();
  for (const install of all) {
    if (!selected.has(install.record)) continue;
    for (const entry of install.manifest.entries) {
      const key = ownedEntryKey(install.manifest, entry);
      const state = protectedEntries.has(key) ? "shared" : inspectEntry(install.manifest, entry);
      const candidate = { owner: install, entry, path: entryPath(install.manifest, entry), key, state };
      const existing = jobs.get(key);
      if (!existing || (existing.state !== "remove" && state === "remove")) jobs.set(key, candidate);
    }
  }
  return [...jobs.values()].sort((left, right) => right.path.length - left.path.length);
}

function loadUninstallPlan(opts: ParsedUninstallArgs): UninstallPlan {
  const generation = readStateGeneration(retemperHome());
  const snapshot = readTracking(installsPath());
  const selectedRecordsList = selectedRecords(snapshot, opts);
  const selected = new Set(selectedRecordsList);
  if (!selected.size) return { generation, snapshot, selected, installs: [], jobs: [] };
  const installs = snapshot.valid.map(loadInstall);
  return { generation, snapshot, selected, installs, jobs: preflight(installs, selected) };
}

function describeRemoval(
  installs: LoadedInstall[],
  selected: Set<ValidInstall>,
  jobs: RemovalJob[],
  filePath: string,
  opts: ParsedUninstallArgs,
): string {
  const lines = ["retemper uninstall — planned removals", ""];
  const jobsByRecord = new Map<ValidInstall, RemovalJob[]>();
  for (const job of jobs) {
    const listed = jobsByRecord.get(job.owner.record) || [];
    listed.push(job);
    jobsByRecord.set(job.owner.record, listed);
  }
  for (const install of installs) {
    if (!selected.has(install.record)) continue;
    lines.push(`${install.record.platform} ${install.record.scope}${install.legacy ? " legacy" : ""} (root: ${install.record.path})`);
    for (const job of jobsByRecord.get(install.record) || []) {
      if (job.state === "remove") lines.push(`  [present] remove ${job.path}`);
      else if (job.state === "missing") lines.push(`  [missing] ${job.path}`);
      else lines.push(`  [${job.state}] keep ${job.path}`);
    }
  }
  if (!jobs.length) lines.push("  (no files found)");
  lines.push("");
  lines.push("kept: CODING_STANDARDS.md and unowned or modified contents are never removed.");
  lines.push(`tracking: ${selected.size} record(s) will be dropped from ${filePath}`);
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

function sameRemovalSet(before: RemovalJob[], after: RemovalJob[]): boolean {
  const keys = (jobs: RemovalJob[]) => jobs.filter((job) => job.state === "remove").map((job) => job.key).sort();
  return JSON.stringify(keys(before)) === JSON.stringify(keys(after));
}

function applyRemovals(jobs: RemovalJob[]): void {
  for (const job of jobs) {
    if (job.state !== "remove") continue;
    verifyManifestIdentity(job.owner.manifest);
    if (inspectEntry(job.owner.manifest, job.entry) !== "remove") {
      throw new Error(`Owned entry changed after confirmation; nothing further was removed: ${job.path}`);
    }
    unlinkSync(job.path);
  }
}

function pruneEmptyOwnedDirectories(installs: LoadedInstall[], selected: Set<ValidInstall>): void {
  const directories = new Map<string, { manifest: InstallManifest; directory: PhysicalDirectory }>();
  const protectedDirectories = new Set<string>();
  for (const install of installs) {
    if (selected.has(install.record)) continue;
    for (const directory of install.manifest.directories) protectedDirectories.add(directory.realPath);
  }
  for (const install of installs) {
    if (!selected.has(install.record)) continue;
    for (const directory of install.manifest.directories) {
      if (protectedDirectories.has(directory.realPath)) continue;
      const path = join(install.manifest.roots[directory.root].path, directory.relativePath);
      directories.set(path, { manifest: install.manifest, directory });
    }
  }
  for (const [path, { manifest, directory }] of [...directories].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    const root = manifest.roots[directory.root];
    if (!verifyPhysicalIdentity(root.path, root) || !verifyPhysicalIdentity(path, directory)) continue;
    try {
      rmdirSync(path);
    } catch (error) {
      const code = nodeErrorCode(error);
      if (["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(code || "")) continue;
      throw error;
    }
  }
}

function writeTracking(entries: InstallEntry[], filePath: string): void {
  if (!entries.length) {
    rmSync(filePath, { force: true });
    return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, formatInstalls(entries));
  renameSync(temporary, filePath);
}

function cleanupStateDirectories(): void {
  for (const path of [join(retemperHome(), "manifests"), join(retemperHome(), "manifest-expectations"), retemperHome()]) {
    try {
      rmdirSync(path);
    } catch {
      // Best-effort cleanup never changes the uninstall result.
    }
  }
}

export function helpText(): string {
  return [
    "retemper uninstaller",
    "",
    "Removes only unchanged files and links recorded as installer-owned.",
    "Every path is shown before the confirmation gate.",
    "",
    "Usage:",
    "  node uninstall.ts [--all] [--dry-run] [--yes]",
    "  node uninstall.ts --platform codex --scope user [--dry-run] [--yes]",
    "  node uninstall.ts --platform codex,cursor --scope project --target <repo>",
    "  node retemper.ts uninstall [same flags]",
    "",
    "Options:",
    "  --all                     Remove every recorded install; Default when no filter is given",
    "                            Records are read from ~/.retemper/installs.txt ($RETEMPER_HOME).",
    `  --platform ${SUPPORTED_PLATFORMS.join("|")}[,...]`,
    "                            Repeat the flag, commas, or spaces",
    "  --scope user|project      Select one scope",
    "  --target <dir>            Required with --scope project",
    "  --dry-run                 Print the paths, remove nothing, never prompts",
    "  --yes, -y                 Skip the confirmation prompt",
    "  --help                    This text",
    "",
    "Notes:",
    "  CODING_STANDARDS.md is never removed; modified files and unowned children are kept.",
    "  Shared Codex, Copilot, and Cursor files remain until their last owner is removed.",
    "  Legacy records are accepted only when current destinations can be verified safely;",
    "  reinstall or update first when the command reports migration is required.",
    "  The prompt accepts y or yes; anything else, including EOF, aborts.",
  ].join("\n");
}

export async function uninstallMain(argv: string[] = process.argv): Promise<number> {
  const opts = parseUninstallArgs(argv);
  if (opts.help) {
    console.log(helpText());
    return 0;
  }
  validateUninstallArgs(opts);
  const stateHome = retemperHome();
  const planningLock = acquireStateLock(stateHome);
  let planned: UninstallPlan;
  try {
    assertNoOwnershipTransaction(stateHome);
    planned = loadUninstallPlan(opts);
  } finally {
    releaseStateLock(planningLock);
  }
  if (!planned.selected.size) {
    console.log("retemper uninstall — planned removals\n\n  (no files found)\n");
    console.log("Nothing to uninstall.");
    return 0;
  }

  console.log(describeRemoval(planned.installs, planned.selected, planned.jobs, planned.snapshot.filePath, opts));
  if (opts.dryRun) return 0;
  if (!opts.yes && !(await confirmRemoval())) {
    console.log("Aborted. Nothing was removed.");
    return 0;
  }

  const mutationLock = acquireStateLock(stateHome);
  try {
    assertNoOwnershipTransaction(stateHome);
    assertStateGeneration(stateHome, planned.generation);
    const current = loadUninstallPlan(opts);
    if (current.snapshot.text !== planned.snapshot.text) {
      throw new Error("Install tracking changed after the uninstall plan was shown; rerun to review the new plan.");
    }
    if (!sameRemovalSet(planned.jobs, current.jobs)) {
      throw new Error("Owned paths changed after the uninstall plan was shown; rerun to review the new plan.");
    }
    rotateStateGeneration(stateHome, planned.generation);
    applyRemovals(current.jobs);
    pruneEmptyOwnedDirectories(current.installs, current.selected);

    const kept = current.snapshot.entries.filter((entry) => entry.invalid || !current.selected.has(entry));
    writeTracking(kept, current.snapshot.filePath);
    for (const install of current.installs) {
      if (current.selected.has(install.record) && !install.legacy) {
        removeInstallManifest(stateHome, install.record);
        finalizeInstallManifestRemoval(stateHome, install.record);
      }
    }
    cleanupStateDirectories();
  } finally {
    releaseStateLock(mutationLock);
  }
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
    if (code !== 0) process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
