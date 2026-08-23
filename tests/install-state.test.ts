import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  acquireStateLock,
  assertNoOwnershipTransaction,
  beginOwnershipTransaction,
  finishOwnershipTransaction,
  ownershipTransactionPath,
  releaseStateLock,
} from "../lib/install-state.ts";

test("releaseStateLock leaves a replacement lock in place and fails closed", () => {
  const home = mkdtempSync(join(tmpdir(), "retemper-state-lock-owner-"));
  try {
    const lock = acquireStateLock(home);
    rmSync(lock.path, { recursive: true });
    mkdirSync(lock.path);

    assert.throws(() => releaseStateLock(lock), /ownership|replaced|lost/i);
    assert.equal(existsSync(lock.path), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireStateLock records actionable owner metadata", () => {
  const home = mkdtempSync(join(tmpdir(), "retemper-state-lock-metadata-"));
  try {
    const lock = acquireStateLock(home);
    const owner = JSON.parse(readFileSync(lock.ownerPath, "utf8"));
    assert.equal(owner.version, 1);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.hostname, hostname());
    assert.match(owner.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(owner.token, /^[a-f0-9]{64}$/);
    releaseStateLock(lock);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function writeLockOwner(home: string, owner: Record<string, unknown>): string {
  const lockPath = join(home, "state.lock");
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, "owner"), `${JSON.stringify(owner)}\n`);
  return lockPath;
}

test("acquireStateLock safely recovers a dead same-host owner", () => {
  const home = mkdtempSync(join(tmpdir(), "retemper-state-lock-dead-"));
  const exited = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(exited.pid);
  try {
    writeLockOwner(home, {
      version: 1,
      pid: exited.pid,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
      token: "a".repeat(64),
    });

    const recovered = acquireStateLock(home);
    releaseStateLock(recovered);
    assert.equal(existsSync(join(home, "state.lock")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("acquireStateLock never steals live, foreign-host, or malformed locks", () => {
  const cases = [
    {
      name: "live",
      owner: {
        version: 1,
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
        token: "b".repeat(64),
      },
      pattern: /live|running/i,
    },
    {
      name: "foreign",
      owner: {
        version: 1,
        pid: process.pid,
        hostname: `${hostname()}-elsewhere`,
        startedAt: new Date().toISOString(),
        token: "c".repeat(64),
      },
      pattern: /foreign|different host/i,
    },
  ];
  for (const fixture of cases) {
    const home = mkdtempSync(join(tmpdir(), `retemper-state-lock-${fixture.name}-`));
    try {
      const lockPath = writeLockOwner(home, fixture.owner);
      assert.throws(() => acquireStateLock(home), fixture.pattern);
      assert.equal(existsSync(lockPath), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  const malformedHome = mkdtempSync(join(tmpdir(), "retemper-state-lock-malformed-"));
  try {
    const lockPath = join(malformedHome, "state.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner"), "not json\n");
    assert.throws(() => acquireStateLock(malformedHome), /malformed.*manual|manual.*malformed/i);
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(malformedHome, { recursive: true, force: true });
  }
});

test("ownership recovery accepts only the exact unfinished intent and token", () => {
  const home = mkdtempSync(join(tmpdir(), "retemper-ownership-intent-"));
  const updateIntent = {
    kind: "update" as const,
    records: [{ platform: "cursor", scope: "project" as const, path: join(home, "project") }],
  };
  try {
    const transaction = beginOwnershipTransaction(home, updateIntent);
    assert.throws(() => assertNoOwnershipTransaction(home), /unfinished.*update/i);
    assert.throws(
      () => beginOwnershipTransaction(home, { ...updateIntent, kind: "install" }),
      /same update|unrelated install/i,
    );
    const retry = beginOwnershipTransaction(home, updateIntent);
    assert.equal(retry.value.token, transaction.value.token);
    finishOwnershipTransaction(retry);
    assert.equal(existsSync(ownershipTransactionPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("malformed ownership recovery metadata fails closed", () => {
  const home = mkdtempSync(join(tmpdir(), "retemper-ownership-malformed-"));
  try {
    writeFileSync(ownershipTransactionPath(home), "{}\n");
    assert.throws(() => assertNoOwnershipTransaction(home), /invalid unfinished ownership transaction/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
