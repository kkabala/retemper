import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireStateLock, releaseStateLock } from "../lib/install-state.ts";

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
