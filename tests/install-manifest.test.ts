import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  createInstallManifest,
  manifestPath,
  parseInstallManifest,
} from "../lib/install-manifest.ts";
import { apply, planInstall, recordFromPlan } from "../install.ts";

const record = { platform: "cursor", scope: "project", path: "/repo" };

function validManifest() {
  return {
    version: 2,
    record,
    roots: [
      { path: "/repo", realPath: "/repo", device: "1", inode: "2" },
    ],
    directories: [
      {
        root: 0,
        relativePath: ".agents/skills/retemper",
        realPath: "/repo/.agents/skills/retemper",
        device: "1",
        inode: "3",
      },
    ],
    entries: [
      {
        root: 0,
        relativePath: ".agents/skills/retemper/SKILL.md",
        realPath: "/repo/.agents/skills/retemper/SKILL.md",
        kind: "file",
        sha256: "a".repeat(64),
      },
    ],
  };
}

test("parseInstallManifest accepts the strict v2 ownership schema", () => {
  assert.deepEqual(parseInstallManifest(JSON.stringify(validManifest())), validManifest());
  assert.equal(
    manifestPath("/state", record),
    join("/state", "manifests", "7c3a25a7ece6ce8d23376750e98d9c88c64fe5a715e24ce9001d095407fdc0bd.json"),
  );
});

test("parseInstallManifest rejects untrusted paths, versions, and shapes", () => {
  const cases = [
    { ...validManifest(), version: 1 },
    { ...validManifest(), extra: true },
    { ...validManifest(), roots: [{ ...validManifest().roots[0], path: "relative" }] },
    { ...validManifest(), roots: [{ ...validManifest().roots[0], path: "/other" }] },
    { ...validManifest(), roots: [...validManifest().roots, { ...validManifest().roots[0], path: "/external" }] },
    {
      ...validManifest(),
      entries: [{ ...validManifest().entries[0], relativePath: "../outside" }],
    },
    {
      ...validManifest(),
      entries: [{ ...validManifest().entries[0], relativePath: "/absolute" }],
    },
    {
      ...validManifest(),
      entries: [{ ...validManifest().entries[0], root: 2 }],
    },
  ];

  for (const value of cases) {
    assert.throws(() => parseInstallManifest(JSON.stringify(value)), /Invalid install manifest/);
  }
  assert.throws(() => parseInstallManifest("{broken"), /Invalid install manifest/);
});

test("createInstallManifest records actual links and symlink-fallback file hashes", () => {
  const createdAgents = mkdtempSync(join(tmpdir(), "retemper-manifest-agents-"));
  const createdCodex = mkdtempSync(join(tmpdir(), "retemper-manifest-codex-"));
  const previousAgents = process.env.AGENTS_HOME;
  const previousCodex = process.env.CODEX_HOME;
  process.env.AGENTS_HOME = realpathSync(createdAgents);
  process.env.CODEX_HOME = realpathSync(createdCodex);
  try {
    const plan = planInstall({ platform: "codex", scope: "user" });
    apply(plan, { skipDeps: true });
    const fallback = plan.skillLinks.find((link) => basename(link.dest) === "retemper");
    assert.ok(fallback);
    assert.equal(lstatSync(fallback.dest).isSymbolicLink(), true);
    unlinkSync(fallback.dest);
    cpSync(fallback.src, fallback.dest, { recursive: true });

    const manifest = createInstallManifest(plan, recordFromPlan(plan));
    const fallbackSkill = manifest.entries.find((entry) =>
      entry.relativePath === join("skills", "retemper", "SKILL.md")
    );
    assert.ok(fallbackSkill && fallbackSkill.kind === "file");
    assert.equal(
      fallbackSkill.sha256,
      createHash("sha256").update(readFileSync(join(fallback.dest, "SKILL.md"))).digest("hex"),
    );
    const orchestrateLink = manifest.entries.find((entry) =>
      entry.relativePath === join("skills", "orchestrate")
    );
    assert.ok(orchestrateLink && orchestrateLink.kind === "link");
  } finally {
    if (previousAgents === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = previousAgents;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    rmSync(createdAgents, { recursive: true, force: true });
    rmSync(createdCodex, { recursive: true, force: true });
  }
});
