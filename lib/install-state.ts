import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { isMissingPathError } from "./install-manifest.ts";

const LEGACY_GENERATION = "legacy-v0";

export type StateLock = {
  path: string;
  ownerPath: string;
  token: string;
  device: string;
  inode: string;
};

export function stateLockPath(stateHome: string): string {
  return join(resolve(stateHome), "state.lock");
}

export function stateGenerationPath(stateHome: string): string {
  return join(resolve(stateHome), "state.generation");
}

export function acquireStateLock(stateHome: string): StateLock {
  const home = resolve(stateHome);
  mkdirSync(home, { recursive: true });
  const path = stateLockPath(home);
  try {
    mkdirSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Retemper state lock is already held at ${path}; another retemper operation may be running.`);
    }
    throw error;
  }
  const token = randomBytes(32).toString("hex");
  const ownerPath = join(path, "owner");
  try {
    writeFileSync(ownerPath, `v1 ${token}\n`, { flag: "wx", mode: 0o600 });
    const stats = statSync(path, { bigint: true });
    return {
      path,
      ownerPath,
      token,
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
  let owner: string;
  let stats;
  try {
    owner = readFileSync(lock.ownerPath, "utf8");
    stats = statSync(lock.path, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(`Retemper state lock ownership was lost at ${lock.path}; refusing unsafe continuation.`);
    }
    throw error;
  }
  if (
    owner !== `v1 ${lock.token}\n` ||
    String(stats.dev) !== lock.device ||
    String(stats.ino) !== lock.inode
  ) {
    throw new Error(`Retemper state lock was replaced at ${lock.path}; refusing to remove a foreign lock.`);
  }
  unlinkSync(lock.ownerPath);
  const beforeRemoval = statSync(lock.path, { bigint: true });
  if (String(beforeRemoval.dev) !== lock.device || String(beforeRemoval.ino) !== lock.inode) {
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
