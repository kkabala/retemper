import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import type { InstallPlan, ValidInstall } from "../install.ts";

export type PhysicalRoot = {
  path: string;
  realPath: string;
  device: string;
  inode: string;
};

export type PhysicalDirectory = {
  root: number;
  relativePath: string;
  realPath: string;
  device: string;
  inode: string;
};

export type OwnedFile = {
  root: number;
  relativePath: string;
  realPath: string;
  kind: "file";
  sha256: string;
};

export type OwnedLink = {
  root: number;
  relativePath: string;
  kind: "link";
  target: string;
};

export type OwnedEntry = OwnedFile | OwnedLink;

export type InstallManifest = {
  version: 2;
  record: ValidInstall;
  roots: PhysicalRoot[];
  directories: PhysicalDirectory[];
  entries: OwnedEntry[];
};

type FileCandidate = { source: string; destination: string };

function nodeErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

export function isMissingPathError(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function manifestKey(record: ValidInstall): string {
  return createHash("sha256")
    .update(JSON.stringify([record.platform, record.scope, record.path]))
    .digest("hex");
}

export function manifestPath(stateHome: string, record: ValidInstall): string {
  return join(stateHome, "manifests", `${manifestKey(record)}.json`);
}

export function manifestExpectationPath(stateHome: string, record: ValidInstall): string {
  return join(stateHome, "manifest-expectations", `${manifestKey(record)}.expected`);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function physicalId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value)) return false;
  const normalized = normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith(`..${sep}`);
}

function contained(root: string, relativePath: string): boolean {
  const destination = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return destination.startsWith(prefix);
}

function physicalDescendant(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return Boolean(path && path !== "." && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function parseRecord(value: unknown): ValidInstall | null {
  if (!plainObject(value) || !exactKeys(value, ["path", "platform", "scope"])) return null;
  if (typeof value.platform !== "string" || !value.platform) return null;
  if (value.scope !== "user" && value.scope !== "project") return null;
  if (typeof value.path !== "string" || !isAbsolute(value.path)) return null;
  return { platform: value.platform, scope: value.scope, path: value.path };
}

function parseRoot(value: unknown): PhysicalRoot | null {
  if (!plainObject(value) || !exactKeys(value, ["device", "inode", "path", "realPath"])) return null;
  if (typeof value.path !== "string" || !isAbsolute(value.path)) return null;
  if (typeof value.realPath !== "string" || !isAbsolute(value.realPath)) return null;
  if (!physicalId(value.device) || !physicalId(value.inode)) return null;
  return value as PhysicalRoot;
}

function validRootIndex(value: unknown, roots: PhysicalRoot[]): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < roots.length;
}

function parseDirectory(value: unknown, roots: PhysicalRoot[]): PhysicalDirectory | null {
  if (!plainObject(value)) return null;
  if (!exactKeys(value, ["device", "inode", "realPath", "relativePath", "root"])) return null;
  if (!validRootIndex(value.root, roots) || !safeRelativePath(value.relativePath)) return null;
  if (!contained(roots[value.root].path, value.relativePath)) return null;
  if (typeof value.realPath !== "string" || !isAbsolute(value.realPath)) return null;
  if (!physicalDescendant(roots[value.root].realPath, value.realPath)) return null;
  if (!physicalId(value.device) || !physicalId(value.inode)) return null;
  return value as PhysicalDirectory;
}

function parseEntry(value: unknown, roots: PhysicalRoot[]): OwnedEntry | null {
  if (!plainObject(value) || !validRootIndex(value.root, roots)) return null;
  if (!safeRelativePath(value.relativePath) || !contained(roots[value.root].path, value.relativePath)) return null;
  if (value.kind === "file") {
    if (!exactKeys(value, ["kind", "realPath", "relativePath", "root", "sha256"])) return null;
    if (typeof value.realPath !== "string" || !isAbsolute(value.realPath)) return null;
    if (!physicalDescendant(roots[value.root].realPath, value.realPath)) return null;
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
    return value as OwnedFile;
  }
  if (value.kind === "link") {
    if (!exactKeys(value, ["kind", "relativePath", "root", "target"])) return null;
    if (typeof value.target !== "string" || !isAbsolute(value.target)) return null;
    return value as OwnedLink;
  }
  return null;
}

function uniqueLocations(values: { root: number; relativePath: string }[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const key = `${value.root}\0${value.relativePath}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function parseInstallManifest(text: string): InstallManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid install manifest: expected strict v2 JSON ownership metadata.");
  }
  if (!plainObject(value) || !exactKeys(value, ["directories", "entries", "record", "roots", "version"])) {
    throw new Error("Invalid install manifest: unexpected top-level shape.");
  }
  if (value.version !== 2 || !Array.isArray(value.roots) || !Array.isArray(value.directories) || !Array.isArray(value.entries)) {
    throw new Error("Invalid install manifest: unsupported version or collection shape.");
  }
  const record = parseRecord(value.record);
  const roots = value.roots.map(parseRoot);
  if (!record || !roots.length || roots.some((root) => root === null)) {
    throw new Error("Invalid install manifest: record or root identity is invalid.");
  }
  const validRoots = roots as PhysicalRoot[];
  if (validRoots[0].path !== record.path) {
    throw new Error("Invalid install manifest: primary root does not match the tracking record.");
  }
  if (validRoots.length > 1 && (record.platform !== "codex" || record.scope !== "user" || validRoots.length !== 2)) {
    throw new Error("Invalid install manifest: external roots are only valid for Codex user compatibility links.");
  }
  const directories = value.directories.map((directory) => parseDirectory(directory, validRoots));
  const entries = value.entries.map((entry) => parseEntry(entry, validRoots));
  if (directories.some((directory) => directory === null) || entries.some((entry) => entry === null)) {
    throw new Error("Invalid install manifest: an owned path is invalid.");
  }
  const validDirectories = directories as PhysicalDirectory[];
  const validEntries = entries as OwnedEntry[];
  if (!uniqueLocations(validDirectories) || !uniqueLocations(validEntries)) {
    throw new Error("Invalid install manifest: duplicate owned paths.");
  }
  return { version: 2, record, roots: validRoots, directories: validDirectories, entries: validEntries };
}

function sameRecord(left: ValidInstall, right: ValidInstall): boolean {
  return left.platform === right.platform && left.scope === right.scope && left.path === right.path;
}

export function ownedEntryKey(manifest: InstallManifest, entry: OwnedEntry): string {
  if (entry.kind === "file") return `file:${entry.realPath}`;
  const parent = dirname(entry.relativePath);
  const directory = manifest.directories.find(
    (candidate) => candidate.root === entry.root && candidate.relativePath === parent,
  );
  const realParent = parent === "." ? manifest.roots[entry.root].realPath : directory?.realPath;
  if (!realParent) {
    throw new Error(`Invalid install manifest: link parent identity is missing for ${entry.relativePath}.`);
  }
  const basename = entry.relativePath.slice(parent === "." ? 0 : parent.length + 1);
  return `link:${join(realParent, basename)}`;
}

export function readInstallManifest(stateHome: string, record: ValidInstall): InstallManifest | null {
  const path = manifestPath(stateHome, record);
  const expectedPath = manifestExpectationPath(stateHome, record);
  let expectedDigest: string | null = null;
  try {
    const expected = readFileSync(expectedPath, "utf8").match(/^v2 ([a-f0-9]{64})\n$/);
    if (!expected) throw new Error(`Invalid install manifest expectation at ${expectedPath}.`);
    expectedDigest = expected[1];
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      if (expectedDigest) {
        throw new Error(
          `Install manifest mismatch for ${record.platform} ${record.scope} ${record.path}: ` +
          "ownership metadata is missing. Reinstall or update this destination to migrate safely.",
        );
      }
      return null;
    }
    throw error;
  }
  if (!expectedDigest) {
    throw new Error(
      `Install manifest mismatch for ${record.platform} ${record.scope} ${record.path}: ` +
      "the v2 expectation marker is missing. Reinstall or update this destination to migrate safely.",
    );
  }
  const actualDigest = createHash("sha256").update(text).digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error(
      `Install ownership metadata integrity mismatch at ${path}; reinstall or update this destination to migrate safely.`,
    );
  }
  const manifest = parseInstallManifest(text);
  if (!sameRecord(manifest.record, record)) {
    throw new Error(`Invalid install manifest at ${path}: tracking record does not match ownership metadata.`);
  }
  return manifest;
}

export function writeInstallManifest(stateHome: string, manifest: InstallManifest): void {
  const path = manifestPath(stateHome, manifest.record);
  const expectedPath = manifestExpectationPath(stateHome, manifest.record);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(temporary, serialized);
  renameSync(temporary, path);
  mkdirSync(dirname(expectedPath), { recursive: true });
  const expectedTemporary = `${expectedPath}.${process.pid}.tmp`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  writeFileSync(expectedTemporary, `v2 ${digest}\n`);
  renameSync(expectedTemporary, expectedPath);
}

const SHARED_SKILL_PLATFORMS = new Set(["codex", "copilot", "cursor"]);

function samePhysicalIdentity(left: PhysicalRoot, right: PhysicalRoot): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function sharesPrimaryPayload(manifest: InstallManifest, current: InstallManifest): boolean {
  if (!SHARED_SKILL_PLATFORMS.has(manifest.record.platform)) return false;
  if (!SHARED_SKILL_PLATFORMS.has(current.record.platform)) return false;
  if (manifest.record.scope !== current.record.scope) return false;
  const previousRoot = manifest.roots[0];
  const currentRoot = current.roots[0];
  const sameNamedRoot = resolve(previousRoot.path) === resolve(currentRoot.path) ||
    previousRoot.realPath === currentRoot.realPath;
  if (sameNamedRoot && !samePhysicalIdentity(previousRoot, currentRoot)) {
    throw new Error(`Shared install root identity changed at ${previousRoot.path}; refusing to merge ownership.`);
  }
  return samePhysicalIdentity(previousRoot, currentRoot);
}

function refreshSharedEntries(manifest: InstallManifest, current: InstallManifest): InstallManifest | null {
  if (!sharesPrimaryPayload(manifest, current)) return null;
  const primaryDirectories = new Map(
    manifest.directories.filter((directory) => directory.root === 0).map((directory) => [directory.relativePath, directory]),
  );
  const primaryEntries = new Map(
    manifest.entries.filter((entry) => entry.root === 0).map((entry) => [entry.relativePath, entry]),
  );
  const directories = [...manifest.directories];
  const entries = [...manifest.entries];

  for (const directory of current.directories.filter((candidate) => candidate.root === 0)) {
    if (primaryEntries.has(directory.relativePath)) {
      throw new Error(`Shared ownership kind conflict at ${directory.relativePath}.`);
    }
    const existing = primaryDirectories.get(directory.relativePath);
    if (existing) {
      if (
        existing.realPath !== directory.realPath ||
        existing.device !== directory.device ||
        existing.inode !== directory.inode
      ) {
        throw new Error(`Shared directory identity conflict at ${directory.relativePath}.`);
      }
      continue;
    }
    const added = { ...directory, root: 0 };
    primaryDirectories.set(added.relativePath, added);
    directories.push(added);
  }

  for (const currentEntry of current.entries.filter((candidate) => candidate.root === 0)) {
    if (primaryDirectories.has(currentEntry.relativePath)) {
      throw new Error(`Shared ownership kind conflict at ${currentEntry.relativePath}.`);
    }
    const existing = primaryEntries.get(currentEntry.relativePath);
    const replacement = { ...currentEntry, root: 0 };
    if (!existing) {
      primaryEntries.set(replacement.relativePath, replacement);
      entries.push(replacement);
      continue;
    }
    if (existing.kind !== replacement.kind) {
      throw new Error(`Shared ownership kind conflict at ${currentEntry.relativePath}.`);
    }
    const index = entries.indexOf(existing);
    entries[index] = replacement;
    primaryEntries.set(replacement.relativePath, replacement);
  }

  const refreshed: InstallManifest = {
    ...manifest,
    directories: directories.sort((left, right) =>
      left.root - right.root || left.relativePath.localeCompare(right.relativePath)
    ),
    entries: entries.sort((left, right) =>
      left.root - right.root || left.relativePath.localeCompare(right.relativePath)
    ),
  };
  return JSON.stringify(refreshed) === JSON.stringify(manifest) ? null : refreshed;
}

export function writeCoherentInstallManifests(
  stateHome: string,
  current: InstallManifest,
  trackedRecords: ValidInstall[],
): void {
  const refreshed: InstallManifest[] = [];
  for (const record of trackedRecords) {
    if (sameRecord(record, current.record)) continue;
    const existing = readInstallManifest(stateHome, record);
    if (!existing) continue;
    const next = refreshSharedEntries(existing, current);
    if (next) refreshed.push(next);
  }
  writeInstallManifest(stateHome, current);
  for (const manifest of refreshed) writeInstallManifest(stateHome, manifest);
}

export function removeInstallManifest(stateHome: string, record: ValidInstall): void {
  rmSync(manifestPath(stateHome, record), { force: true });
}

export function finalizeInstallManifestRemoval(stateHome: string, record: ValidInstall): void {
  rmSync(manifestExpectationPath(stateHome, record), { force: true });
}

function addFile(candidates: FileCandidate[], source: string | null, destination: string | null): void {
  if (source && destination) candidates.push({ source, destination });
}

function addTree(candidates: FileCandidate[], sourceRoot: string, destinationRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    if (entry.isDirectory()) addTree(candidates, source, destination);
    else if (entry.isFile()) addFile(candidates, source, destination);
  }
}

export function installedFileCandidates(plan: InstallPlan): FileCandidate[] {
  const candidates: FileCandidate[] = [];
  addFile(candidates, plan.workflowSrc, plan.workflowDest);
  if (plan.skillSrc && plan.skillDest) addTree(candidates, plan.skillSrc, plan.skillDest);
  addTree(candidates, plan.refsSrc, plan.refsDest);
  addTree(candidates, plan.orchestrateSrc, plan.orchestrateDest);
  addFile(
    candidates,
    join(plan.refsSrc, "orchestrator.md"),
    join(plan.orchestrateDest, "references", "orchestrator.md"),
  );
  for (let index = 0; index < plan.skillDests.length; index += 1) {
    addTree(candidates, plan.vendorSkills[index], plan.skillDests[index]);
  }
  const unique = new Map<string, FileCandidate>();
  for (const candidate of candidates) unique.set(resolve(candidate.destination), candidate);
  return [...unique.values()];
}

function prospectiveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    try {
      lstatSync(path);
    } catch (lstatError) {
      if (!isMissingPathError(lstatError)) throw lstatError;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(prospectiveRealPath(parent), basename(path));
    }
    throw new Error(`Cannot authorize dangling install root: ${path}`);
  }
}

function assertDestinationPhysicallyContained(root: string, destination: string): void {
  const absoluteRoot = resolve(root);
  const absoluteDestination = resolve(destination);
  const relativePath = rootContains(absoluteRoot, absoluteDestination);
  if (!relativePath) {
    throw new Error(`Install destination escapes its target root: ${absoluteDestination}`);
  }
  const physicalRoot = prospectiveRealPath(absoluteRoot);
  let current = absoluteRoot;
  for (const component of relativePath.split(sep)) {
    current = join(current, component);
    try {
      lstatSync(current);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    let physicalPath: string;
    try {
      physicalPath = realpathSync(current);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new Error(`Install destination has a dangling physical alias: ${current}`);
      }
      throw error;
    }
    if (!physicalDescendant(physicalRoot, physicalPath)) {
      throw new Error(
        `Install destination escapes the authorized physical target root ${physicalRoot}: ${current} -> ${physicalPath}`,
      );
    }
  }
}

export function assertInstallPlanPhysicalContainment(plan: InstallPlan): void {
  for (const candidate of installedFileCandidates(plan)) {
    assertDestinationPhysicallyContained(plan.targetRoot, candidate.destination);
  }
  if (plan.standardsDest) assertDestinationPhysicallyContained(plan.targetRoot, plan.standardsDest);
  assertInstallLinkParentPhysicalContainment(plan);
}

export function assertInstallLinkParentPhysicalContainment(plan: InstallPlan): void {
  for (const link of plan.skillLinks) {
    const externalRoot = externalLinkRoot(link.dest);
    assertDestinationPhysicallyContained(externalRoot, dirname(link.dest));
  }
}

function identity(path: string): { realPath: string; device: string; inode: string } {
  const realPath = realpathSync(path);
  const stats = statSync(path, { bigint: true });
  return { realPath, device: String(stats.dev), inode: String(stats.ino) };
}

function rootContains(root: string, destination: string): string | null {
  const result = relative(root, destination);
  if (!result || result === ".") return null;
  if (isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) return null;
  return result;
}

function rootForDestination(roots: PhysicalRoot[], destination: string): { index: number; relativePath: string } {
  let match: { index: number; relativePath: string; length: number } | null = null;
  for (let index = 0; index < roots.length; index += 1) {
    const relativePath = rootContains(roots[index].path, destination);
    if (relativePath && (!match || roots[index].path.length > match.length)) {
      match = { index, relativePath, length: roots[index].path.length };
    }
  }
  if (!match) throw new Error(`Installed path is outside its recorded roots: ${destination}`);
  return { index: match.index, relativePath: match.relativePath };
}

function captureFile(roots: PhysicalRoot[], destination: string): OwnedFile | null {
  let stats;
  try {
    stats = lstatSync(destination);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
  if (!stats.isFile()) return null;
  const location = rootForDestination(roots, resolve(destination));
  return {
    root: location.index,
    relativePath: location.relativePath,
    realPath: realpathSync(destination),
    kind: "file",
    sha256: sha256File(destination),
  };
}

function externalLinkRoot(destination: string): string {
  return dirname(dirname(resolve(destination)));
}

function samePhysicalPath(left: string, right: string): boolean {
  try {
    const leftStats = statSync(left, { bigint: true });
    const rightStats = statSync(right, { bigint: true });
    return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
  } catch (error) {
    if (isMissingPathError(error) || nodeErrorCode(error) === "ELOOP") return false;
    throw error;
  }
}

function addRoot(roots: PhysicalRoot[], path: string): number {
  const absolute = resolve(path);
  const existing = roots.findIndex((root) => root.path === absolute);
  if (existing >= 0) return existing;
  const physical = identity(absolute);
  roots.push({ path: absolute, ...physical });
  return roots.length - 1;
}

function parentPaths(relativePath: string): string[] {
  const paths: string[] = [];
  let current = dirname(relativePath);
  while (current && current !== ".") {
    paths.push(current);
    current = dirname(current);
  }
  return paths;
}

function captureDirectories(roots: PhysicalRoot[], entries: OwnedEntry[]): PhysicalDirectory[] {
  const directories = new Map<string, PhysicalDirectory>();
  for (const entry of entries) {
    for (const relativePath of parentPaths(entry.relativePath)) {
      const key = `${entry.root}\0${relativePath}`;
      if (directories.has(key)) continue;
      const path = join(roots[entry.root].path, relativePath);
      const physical = identity(path);
      directories.set(key, { root: entry.root, relativePath, ...physical });
    }
  }
  return [...directories.values()].sort((left, right) =>
    left.root - right.root || left.relativePath.localeCompare(right.relativePath)
  );
}

function fallbackCandidates(
  candidates: FileCandidate[],
  sourceRoot: string,
  destinationRoot: string,
): FileCandidate[] {
  const fallback: FileCandidate[] = [];
  for (const candidate of candidates) {
    const relativePath = rootContains(resolve(sourceRoot), resolve(candidate.destination));
    if (relativePath) fallback.push({ source: candidate.source, destination: join(destinationRoot, relativePath) });
  }
  return fallback;
}

function createManifest(
  plan: InstallPlan,
  record: ValidInstall,
  requirePackagedFileMatch: boolean,
): InstallManifest {
  const roots: PhysicalRoot[] = [];
  addRoot(roots, plan.targetRoot);
  const candidates = installedFileCandidates(plan);
  const links: { destination: string; target: string }[] = [];

  for (const link of plan.skillLinks) {
    let stats;
    try {
      stats = lstatSync(link.dest);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      const target = resolve(dirname(link.dest), readlinkSync(link.dest));
      if (target === resolve(link.src)) {
        addRoot(roots, externalLinkRoot(link.dest));
        links.push({ destination: resolve(link.dest), target });
      }
    } else if (stats.isDirectory() && !samePhysicalPath(link.src, link.dest)) {
      addRoot(roots, externalLinkRoot(link.dest));
      candidates.push(...fallbackCandidates(candidates, link.src, link.dest));
    }
  }

  const entries = new Map<string, OwnedEntry>();
  for (const candidate of candidates) {
    const entry = captureFile(roots, candidate.destination);
    if (entry && (!requirePackagedFileMatch || entry.sha256 === sha256File(candidate.source))) {
      entries.set(`${entry.root}\0${entry.relativePath}`, entry);
    }
  }
  for (const link of links) {
    const location = rootForDestination(roots, link.destination);
    entries.set(`${location.index}\0${location.relativePath}`, {
      root: location.index,
      relativePath: location.relativePath,
      kind: "link",
      target: link.target,
    });
  }
  const ownedEntries = [...entries.values()].sort((left, right) =>
    left.root - right.root || left.relativePath.localeCompare(right.relativePath)
  );
  return {
    version: 2,
    record,
    roots,
    directories: captureDirectories(roots, ownedEntries),
    entries: ownedEntries,
  };
}

export function createInstallManifest(plan: InstallPlan, record: ValidInstall): InstallManifest {
  return createManifest(plan, record, false);
}

export function createLegacyInstallManifest(plan: InstallPlan, record: ValidInstall): InstallManifest {
  return createManifest(plan, record, true);
}
