import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { ValidInstall } from "../install.ts";
import { isMissingPathError } from "./install-manifest.ts";

const LEGACY_GENERATION = "legacy-v0";

type LockOwner = {
  version: 1;
  pid: number;
  hostname: string;
  startedAt: string;
  token: string;
};

export type StateLock = {
  path: string;
  ownerPath: string;
  owner: LockOwner;
  ownerText: string;
  device: string;
  inode: string;
};

export type OwnershipIntent =
  | {
    kind: "install";
    records: ValidInstall[];
  }
  | {
    kind: "update";
    records: ValidInstall[];
    trackingBefore: string | null;
    trackingAfter: string | null;
  };

type StoredOwnershipTransaction = OwnershipIntent & {
  version: 2;
  token: string;
  startedAt: string;
};

export type OwnershipTransaction = {
  path: string;
  value: StoredOwnershipTransaction;
};

function nodeErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function parseLockOwner(text: string): LockOwner | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!plainObject(value) || !exactKeys(value, ["hostname", "pid", "startedAt", "token", "version"])) return null;
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return null;
  if (typeof value.hostname !== "string" || !value.hostname) return null;
  if (!validTimestamp(value.startedAt)) return null;
  if (typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) return null;
  return value as LockOwner;
}

function serializeLockOwner(owner: LockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

function lockRecoveryError(path: string, reason: string): Error {
  return new Error(
    `Retemper state lock at ${path} ${reason}. Verify that no retemper process is running, ` +
    "then remove the lock manually before retrying.",
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") return false;
    if (nodeErrorCode(error) === "EPERM") return true;
    throw error;
  }
}

function recoverDeadStateLock(path: string): void {
  const ownerPath = join(path, "owner");
  let stats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    throw lockRecoveryError(path, `has missing or unreadable owner metadata (${nodeErrorCode(error) || "unknown error"})`);
  }
  if (!stats.isDirectory()) {
    throw lockRecoveryError(path, stats.isSymbolicLink() ? "is a symbolic link" : "is not a directory");
  }
  let ownerText: string;
  try {
    ownerText = readFileSync(ownerPath, "utf8");
  } catch (error) {
    throw lockRecoveryError(path, `has missing or unreadable owner metadata (${nodeErrorCode(error) || "unknown error"})`);
  }
  const owner = parseLockOwner(ownerText);
  if (!owner) throw lockRecoveryError(path, "has malformed owner metadata");
  if (owner.hostname !== hostname()) {
    throw lockRecoveryError(path, `belongs to a different host (${owner.hostname})`);
  }
  if (processIsAlive(owner.pid)) {
    throw lockRecoveryError(path, `is held by live PID ${owner.pid} since ${owner.startedAt}`);
  }
  const children = readdirSync(path);
  if (children.length !== 1 || children[0] !== "owner") {
    throw lockRecoveryError(path, "contains unexpected files and cannot be recovered automatically");
  }
  const currentText = readFileSync(ownerPath, "utf8");
  const currentStats = lstatSync(path, { bigint: true });
  if (
    !currentStats.isDirectory() ||
    currentText !== ownerText ||
    String(currentStats.dev) !== String(stats.dev) ||
    String(currentStats.ino) !== String(stats.ino)
  ) {
    throw lockRecoveryError(path, "changed while dead-owner recovery was in progress");
  }
  unlinkSync(ownerPath);
  rmdirSync(path);
}

export function stateLockPath(stateHome: string): string {
  return join(resolve(stateHome), "state.lock");
}

export function stateGenerationPath(stateHome: string): string {
  return join(resolve(stateHome), "state.generation");
}

export function ownershipTransactionPath(stateHome: string): string {
  return join(resolve(stateHome), "ownership-transaction.json");
}

export function acquireStateLock(stateHome: string): StateLock {
  const home = resolve(stateHome);
  mkdirSync(home, { recursive: true });
  const path = stateLockPath(home);
  try {
    mkdirSync(path);
  } catch (error) {
    if (nodeErrorCode(error) !== "EEXIST") throw error;
    recoverDeadStateLock(path);
    try {
      mkdirSync(path);
    } catch (retryError) {
      if (nodeErrorCode(retryError) === "EEXIST") {
        throw lockRecoveryError(path, "was reacquired while recovery was in progress");
      }
      throw retryError;
    }
  }
  const owner: LockOwner = {
    version: 1,
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
    token: randomBytes(32).toString("hex"),
  };
  const ownerText = serializeLockOwner(owner);
  const ownerPath = join(path, "owner");
  try {
    writeFileSync(ownerPath, ownerText, { flag: "wx", mode: 0o600 });
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isDirectory()) throw lockRecoveryError(path, "was replaced before ownership metadata was recorded");
    return {
      path,
      ownerPath,
      owner,
      ownerText,
      device: String(stats.dev),
      inode: String(stats.ino),
    };
  } catch (error) {
    try {
      unlinkSync(ownerPath);
    } catch {
      // Preserve the original acquisition error.
    }
    try {
      rmdirSync(path);
    } catch {
      // Preserve malformed or foreign state for diagnosis.
    }
    throw error;
  }
}

export function releaseStateLock(lock: StateLock): void {
  let stats;
  try {
    stats = lstatSync(lock.path, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Retemper state lock ownership was lost at ${lock.path}; refusing unsafe continuation.`);
    }
    throw error;
  }
  if (
    !stats.isDirectory() ||
    String(stats.dev) !== lock.device ||
    String(stats.ino) !== lock.inode
  ) {
    throw new Error(`Retemper state lock was replaced at ${lock.path}; refusing to remove a foreign lock.`);
  }
  let owner: string;
  try {
    owner = readFileSync(lock.ownerPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Retemper state lock ownership was lost at ${lock.path}; refusing unsafe continuation.`);
    }
    throw error;
  }
  if (
    owner !== lock.ownerText ||
    String(stats.dev) !== lock.device ||
    String(stats.ino) !== lock.inode
  ) {
    throw new Error(`Retemper state lock was replaced at ${lock.path}; refusing to remove a foreign lock.`);
  }
  unlinkSync(lock.ownerPath);
  const beforeRemoval = lstatSync(lock.path, { bigint: true });
  if (
    !beforeRemoval.isDirectory() ||
    String(beforeRemoval.dev) !== lock.device ||
    String(beforeRemoval.ino) !== lock.inode
  ) {
    throw new Error(`Retemper state lock was replaced at ${lock.path}; refusing to remove a foreign lock.`);
  }
  rmdirSync(lock.path);
}

export function withStateLock<T>(stateHome: string, action: () => T): T {
  const lock = acquireStateLock(stateHome);
  try {
    return action();
  } finally {
    releaseStateLock(lock);
  }
}

function normalizeOwnershipRecords(records: ValidInstall[]): ValidInstall[] {
  const unique = new Map<string, ValidInstall>();
  for (const record of records) {
    const normalized = { platform: record.platform, scope: record.scope, path: resolve(record.path) };
    unique.set(JSON.stringify([normalized.platform, normalized.scope, normalized.path]), normalized);
  }
  return [...unique.values()].sort((left, right) =>
    left.platform.localeCompare(right.platform) ||
    left.scope.localeCompare(right.scope) ||
    left.path.localeCompare(right.path)
  );
}

function parseOwnershipRecord(value: unknown): ValidInstall | null {
  if (!plainObject(value) || !exactKeys(value, ["path", "platform", "scope"])) return null;
  if (typeof value.platform !== "string" || !value.platform) return null;
  if (value.scope !== "user" && value.scope !== "project") return null;
  if (typeof value.path !== "string" || !isAbsolute(value.path)) return null;
  return { platform: value.platform, scope: value.scope, path: value.path };
}

function parseOwnershipTransaction(text: string, path: string): StoredOwnershipTransaction {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Invalid unfinished ownership transaction at ${path}; refusing unsafe state recovery.`);
  }
  if (
    !plainObject(value) ||
    (value.kind !== "install" && value.kind !== "update") ||
    !exactKeys(
      value,
      value.kind === "update"
        ? ["kind", "records", "startedAt", "token", "trackingAfter", "trackingBefore", "version"]
        : ["kind", "records", "startedAt", "token", "version"],
    ) ||
    value.version !== 2 ||
    !Array.isArray(value.records) ||
    !validTimestamp(value.startedAt) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    (value.kind === "update" &&
      !((typeof value.trackingBefore === "string" || value.trackingBefore === null) &&
        (typeof value.trackingAfter === "string" || value.trackingAfter === null)))
  ) {
    throw new Error(`Invalid unfinished ownership transaction at ${path}; refusing unsafe state recovery.`);
  }
  const parsedRecords = value.records.map(parseOwnershipRecord);
  if (parsedRecords.some((record) => record === null)) {
    throw new Error(`Invalid unfinished ownership transaction at ${path}; refusing unsafe state recovery.`);
  }
  const records = parsedRecords as ValidInstall[];
  if (JSON.stringify(records) !== JSON.stringify(normalizeOwnershipRecords(records))) {
    throw new Error(`Invalid unfinished ownership transaction at ${path}; record set is not canonical.`);
  }
  const common = {
    version: 2 as const,
    records,
    startedAt: value.startedAt,
    token: value.token,
  };
  if (value.kind === "update") {
    return {
      ...common,
      kind: "update",
      trackingBefore: value.trackingBefore as string | null,
      trackingAfter: value.trackingAfter as string | null,
    };
  }
  return { ...common, kind: "install" };
}

function readOwnershipTransaction(stateHome: string): StoredOwnershipTransaction | null {
  const path = ownershipTransactionPath(stateHome);
  try {
    return parseOwnershipTransaction(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function sameOwnershipIntent(value: StoredOwnershipTransaction, intent: OwnershipIntent): boolean {
  if (
    value.kind !== intent.kind ||
    JSON.stringify(value.records) !== JSON.stringify(normalizeOwnershipRecords(intent.records))
  ) {
    return false;
  }
  if (value.kind === "update" && intent.kind === "update") {
    return value.trackingBefore === intent.trackingBefore && value.trackingAfter === intent.trackingAfter;
  }
  return true;
}

function normalizeOwnershipIntent(intent: OwnershipIntent): OwnershipIntent {
  const records = normalizeOwnershipRecords(intent.records);
  if (intent.kind === "update") return { ...intent, records };
  return { kind: "install", records };
}

function ownershipIntentDescription(value: OwnershipIntent): string {
  const records = normalizeOwnershipRecords(value.records)
    .map((record) => `${record.platform} ${record.scope} ${record.path}`)
    .join(", ");
  return `${value.kind} for ${records || "(no records)"}`;
}

export function beginOwnershipTransaction(
  stateHome: string,
  intent: OwnershipIntent,
): OwnershipTransaction {
  const path = ownershipTransactionPath(stateHome);
  const canonicalIntent = normalizeOwnershipIntent(intent);
  const existing = readOwnershipTransaction(stateHome);
  if (existing) {
    if (!sameOwnershipIntent(existing, canonicalIntent)) {
      throw new Error(
        `An unfinished ownership transaction requires rerunning the same ${ownershipIntentDescription(existing)}. ` +
        `Refusing unrelated ${ownershipIntentDescription(canonicalIntent)}.`,
      );
    }
    return { path, value: existing };
  }
  const value: StoredOwnershipTransaction = {
    ...canonicalIntent,
    version: 2,
    startedAt: new Date().toISOString(),
    token: randomBytes(32).toString("hex"),
  };
  mkdirSync(resolve(stateHome), { recursive: true });
  const temporary = `${path}.${process.pid}.${value.token}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  return { path, value };
}

export function assertOwnershipIntentAllowed(stateHome: string, intent: OwnershipIntent): void {
  const existing = readOwnershipTransaction(stateHome);
  if (existing && !sameOwnershipIntent(existing, intent)) {
    throw new Error(
      `An unfinished ownership transaction requires rerunning the same ${ownershipIntentDescription(existing)}. ` +
      `Refusing unrelated ${ownershipIntentDescription(intent)}.`,
    );
  }
}

export function hasOwnershipTransaction(stateHome: string): boolean {
  return readOwnershipTransaction(stateHome) !== null;
}

export function recoverCommittedUpdateTransaction(
  stateHome: string,
  currentTracking: string | null,
): boolean {
  const transaction = readOwnershipTransaction(stateHome);
  if (!transaction || transaction.kind !== "update") return false;
  if (
    transaction.trackingBefore !== transaction.trackingAfter &&
    currentTracking === transaction.trackingAfter
  ) {
    finishOwnershipTransaction({ path: ownershipTransactionPath(stateHome), value: transaction });
    return true;
  }
  if (currentTracking !== transaction.trackingBefore) {
    throw new Error(
      `Install tracking no longer matches either side of the unfinished ${ownershipIntentDescription(transaction)}; ` +
      "refusing unsafe recovery.",
    );
  }
  return false;
}

export function finishOwnershipTransaction(transaction: OwnershipTransaction): void {
  const current = readOwnershipTransaction(dirname(transaction.path));
  if (!current || !sameOwnershipIntent(current, transaction.value) || current.token !== transaction.value.token) {
    throw new Error(`Ownership transaction changed at ${transaction.path}; refusing to clear foreign recovery state.`);
  }
  unlinkSync(transaction.path);
}

export function assertNoOwnershipTransaction(stateHome: string): void {
  const transaction = readOwnershipTransaction(stateHome);
  if (!transaction) return;
  throw new Error(
    `An unfinished ownership transaction blocks uninstall. Rerun the same ${ownershipIntentDescription(transaction)} ` +
    "to repair manifests and tracking before uninstalling.",
  );
}

export function readStateGeneration(stateHome: string): string {
  const path = stateGenerationPath(stateHome);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return LEGACY_GENERATION;
    throw error;
  }
  if (!/^v1 [a-f0-9]{64}\n$/.test(text)) {
    throw new Error(`Invalid retemper state generation at ${path}; refusing concurrent state changes.`);
  }
  return text.trim();
}

export function assertStateGeneration(stateHome: string, expected: string): void {
  if (readStateGeneration(stateHome) !== expected) {
    throw new Error("Retemper state changed after the uninstall plan was shown; the stale plan was not applied.");
  }
}

export function rotateStateGeneration(stateHome: string, expected?: string): string {
  const current = readStateGeneration(stateHome);
  if (expected !== undefined && current !== expected) {
    throw new Error("Retemper state changed after the uninstall plan was shown; the stale plan was not applied.");
  }
  const path = stateGenerationPath(stateHome);
  const generation = `v1 ${randomBytes(32).toString("hex")}`;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${generation}\n`);
  renameSync(temporary, path);
  return generation;
}
