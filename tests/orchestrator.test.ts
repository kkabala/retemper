import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PHASE_BANDS, PHASES } from "../lib/cycle.ts";
import { planInstall } from "../install.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installPath = join(root, "install.ts");
const orchestratorPath = join(root, "references", "orchestrator.md");
const architectPath = join(root, "references", "architect.md");
const retemperSkillPath = join(root, ".agents", "skills", "retemper", "SKILL.md");
const orchestrateSkillPath = join(root, ".agents", "skills", "orchestrate", "SKILL.md");
const rhaiPath = join(root, ".grok", "workflows", "retemper.rhai");

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [installPath, ...args], {
    encoding: "utf8" as const,
    cwd: root,
    env: { ...process.env, ...env },
  });
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "retemper-orch-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("acceptance: shared orchestrator role exists and is not the retemper cycle", () => {
  assert.equal(existsSync(orchestratorPath), true);
  const body = read(orchestratorPath);

  assert.match(body, /language-agnostic/i);
  assert.match(body, /Stay available/i);
  assert.match(body, /delegat/i);
  assert.match(body, /spawn/i);
  assert.match(body, /yourself/i);
  assert.match(body, /leaf/i);
  assert.match(body, /integrat/i);
  assert.match(body, /\bfast\b/);
  assert.match(body, /\bstandard\b/);
  assert.match(body, /\bdeep\b/);
  assert.match(body, /inherit/i);
  assert.match(body, /questions/i);
  assert.match(body, /one worker per/i);
  assert.match(body, /parallel/i);
  assert.match(body, /wave/i);
  assert.match(body, /must dispatch/i);
  assert.match(body, /only when you cannot spawn/i);
  assert.match(body, /Do not cancel required work because it is slow/);
  assert.match(body, /not a verdict/);
  assert.match(body, /produced the work under judgment/);
  assert.doesNotMatch(body, /\bdeveloper\b/i);
  assert.doesNotMatch(body, /\barchitect\b/i);
  assert.doesNotMatch(body, /Final QA Review/);
  assert.doesNotMatch(body, /Pipeline monitoring/);
  assert.doesNotMatch(body, /Acceptance tests/);
  assert.doesNotMatch(body, /no-skip replay/);
  assert.doesNotMatch(body, /max-cycles/);
  assert.doesNotMatch(body, /\$retemper/);
  assert.doesNotMatch(body, /\/workflow resume/);
  assert.doesNotMatch(body, /gpt-5/);
  assert.doesNotMatch(body, /claude-opus/);
  assert.doesNotMatch(body, /grok-4/);
  assert.doesNotMatch(body, /Jira/);
  assert.doesNotMatch(body, /React Native/);
});

test("acceptance: thin orchestrate skill loads the role and is not the cycle", () => {
  assert.equal(existsSync(orchestrateSkillPath), true);
  const body = read(orchestrateSkillPath);
  assert.match(body, /^---\r?\n/);
  assert.match(body, /^name:\s*orchestrate\s*$/m);
  assert.match(body, /^license:\s*MIT\s*$/m);
  assert.match(body, /^description:/m);
  assert.match(body, /references\/orchestrator\.md/);
  assert.match(body, /Stay available/i);
  assert.match(body, /delegat/i);
  assert.match(body, /retemper/);
  assert.match(body, /must dispatch/i);
  assert.match(body, /Do not cancel required work because it is slow/);
  assert.match(body, /\/workflow retemper/);
  assert.match(body, /more work in this run/);
  assert.doesNotMatch(body, /no-skip replay/);
  assert.doesNotMatch(body, /--no-grill/);
  assert.doesNotMatch(body, /Final QA Review/);
  assert.doesNotMatch(body, /\/workflow resume/);
});

test("acceptance: retemper skill starts as orchestrator then walks the cycle", () => {
  const body = read(retemperSkillPath);
  const orchAt = body.indexOf("references/orchestrator.md");
  const planningAt = body.indexOf("**Planning**");
  assert.ok(orchAt >= 0, "retemper skill must load orchestrator.md");
  assert.ok(planningAt > orchAt, "orchestrator.md must be loaded before the cycle walk");
  for (const title of PHASES) {
    assert.match(body, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(body, /compute band/i);
  for (const [phase, band] of Object.entries(PHASE_BANDS)) {
    const escaped = phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      body,
      new RegExp("\\*\\*" + escaped + "\\*\\*[\\s\\S]{0,160}compute band \\*\\*" + band + "\\*\\*", "i"),
      `${phase} should declare compute band ${band}`,
    );
  }
  assert.match(body, /synthesiz/i);
  assert.match(body, /grill-me/);
  assert.match(body, /spawn/i);
  assert.match(body, /one developer per ready/i);
  assert.match(body, /parallel batch/i);
});

test("acceptance: architect proposes questions and does not interview", () => {
  const body = read(architectPath);
  assert.match(body, /Do not interview/i);
  assert.match(body, /questions/);
  assert.match(body, /grill_open/);
  assert.match(body, /work-item/i);
  assert.match(body, /depends_on/);
  assert.doesNotMatch(body, /Run a grilling interview/);
});

test("acceptance: phase compute bands match the settled defaults", () => {
  assert.deepEqual(Object.keys(PHASE_BANDS), PHASES);
  assert.equal(PHASE_BANDS.Planning, "deep");
  assert.equal(PHASE_BANDS["Code review"], "deep");
  assert.equal(PHASE_BANDS["Final QA Review"], "deep");
  assert.equal(PHASE_BANDS["Acceptance tests"], "standard");
  assert.equal(PHASE_BANDS.Development, "standard");
  assert.equal(PHASE_BANDS.Cleaner, "standard");
  assert.equal(PHASE_BANDS.Testing, "standard");
  assert.equal(PHASE_BANDS["Pipeline monitoring"], "standard");
  assert.equal(PHASE_BANDS.Standards, "standard");
});

test("acceptance: Grok workflow names compute bands and does not invent model ids", () => {
  const source = read(rhaiPath);
  assert.match(source, /compute_band\("deep"\)/);
  assert.match(source, /compute_band\("standard"\)/);
  assert.match(source, /Compute band: /);
  assert.doesNotMatch(source, /model:\s*"gpt-/);
  assert.doesNotMatch(source, /model:\s*"claude-/);
  assert.doesNotMatch(source, /model:\s*"grok-/);
  assert.match(source, /Do not interview the user/);
  assert.match(source, /present your questions as-is/i);
  assert.match(source, /work_items/);
  assert.match(source, /parallel\(/);
});

test("acceptance: Codex install writes orchestrate next to retemper with the role file", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-orch-codex-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      const orchestrateDest = join(target, ".agents", "skills", "orchestrate");
      const retemperDest = join(target, ".agents", "skills", "retemper");
      assert.equal(existsSync(join(orchestrateDest, "SKILL.md")), true);
      assert.equal(existsSync(join(orchestrateDest, "references", "orchestrator.md")), true);
      assert.equal(existsSync(join(retemperDest, "SKILL.md")), true);
      assert.equal(existsSync(join(retemperDest, "references", "orchestrator.md")), true);
      assert.equal(
        read(join(orchestrateDest, "references", "orchestrator.md")),
        read(orchestratorPath),
      );
      assert.match(read(join(orchestrateDest, "SKILL.md")), /^name:\s*orchestrate\s*$/m);
      assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: Grok install writes orchestrate under skills and keeps the workflow", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-orch-grok-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "grok", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), true);
      assert.equal(existsSync(join(target, ".grok", "skills", "orchestrate", "SKILL.md")), true);
      assert.equal(
        existsSync(join(target, ".grok", "skills", "orchestrate", "references", "orchestrator.md")),
        true,
      );
      assert.equal(existsSync(join(target, ".grok", "retemper", "references", "orchestrator.md")), true);
      assert.equal(existsSync(join(target, ".agents", "skills", "orchestrate")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: planInstall dests point orchestrate at a sibling skill folder", () => {
  const grokUser = planInstall({ platform: "grok", scope: "user" });
  const grokProject = planInstall({
    platform: "grok",
    scope: "project",
    target: "/does-not-exist/retemper-orch-grok",
  });
  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const codexProject = planInstall({
    platform: "codex",
    scope: "project",
    target: "/does-not-exist/retemper-orch-codex",
  });

  const copilotProject = planInstall({
    platform: "copilot",
    scope: "project",
    target: "/does-not-exist/retemper-orch-copilot",
  });
  const cursorProject = planInstall({
    platform: "cursor",
    scope: "project",
    target: "/does-not-exist/retemper-orch-cursor",
  });

  const src = join(root, ".agents", "skills", "orchestrate");
  assert.equal(grokUser.orchestrateSrc, src);
  assert.equal(codexUser.orchestrateSrc, src);
  assert.equal(copilotProject.orchestrateSrc, src);
  assert.equal(cursorProject.orchestrateSrc, src);
  assert.ok(copilotProject.orchestrateDest.endsWith(join(".agents", "skills", "orchestrate")));
  assert.ok(cursorProject.orchestrateDest.endsWith(join(".agents", "skills", "orchestrate")));
  assert.ok(grokUser.orchestrateDest.endsWith(join("skills", "orchestrate")));
  assert.doesNotMatch(grokUser.orchestrateDest, /\.agents[/\\]/);
  assert.ok(grokProject.orchestrateDest.endsWith(join(".grok", "skills", "orchestrate")));
  assert.ok(codexUser.orchestrateDest.endsWith(join(".agents", "skills", "orchestrate")));
  assert.ok(codexProject.orchestrateDest.endsWith(join(".agents", "skills", "orchestrate")));
  assert.notEqual(codexProject.orchestrateDest, codexProject.skillDest);
});
