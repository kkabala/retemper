import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PHASES } from "../lib/cycle.mjs";
import {
  agentsHome,
  describe,
  grokHome,
  helpText,
  parseArgs,
  planInstall,
  SKILL_PLATFORMS,
  SUPPORTED_PLATFORMS,
} from "../install.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installPath = join(root, "install.mjs");
const skillSource = join(root, ".agents", "skills", "retemper", "SKILL.md");

function cli(args) {
  return spawnSync(process.execPath, [installPath, ...args], {
    encoding: "utf8",
    cwd: root,
  });
}

test("parseArgs accepts the same flags for grok, codex, and copilot", () => {
  const grok = parseArgs([
    "node",
    "install.mjs",
    "--platform",
    "grok",
    "--scope",
    "user",
    "--dry-run",
    "--skip-deps",
    "--standards",
    "--target",
    "/repo",
  ]);
  const codex = parseArgs([
    "node",
    "install.mjs",
    "--platform",
    "codex",
    "--scope",
    "project",
    "--dry-run",
    "--skip-deps",
    "--standards",
    "--target",
    "/repo",
  ]);
  assert.equal(grok.platform, "grok");
  assert.equal(codex.platform, "codex");
  assert.equal(grok.scope, "user");
  assert.equal(codex.scope, "project");
  assert.equal(grok.dryRun, true);
  assert.equal(codex.dryRun, true);
  assert.equal(grok.skipDeps, true);
  assert.equal(codex.skipDeps, true);
  assert.equal(grok.standards, true);
  assert.equal(codex.standards, true);
  assert.equal(grok.target, "/repo");
  assert.equal(codex.target, "/repo");

  const copilot = parseArgs([
    "node",
    "install.mjs",
    "--platform",
    "copilot",
    "--scope",
    "user",
    "--dry-run",
  ]);
  assert.equal(copilot.platform, "copilot");
  assert.equal(copilot.scope, "user");
  assert.equal(copilot.dryRun, true);
});

test("help names grok, codex, and copilot and does not say only grok is implemented", () => {
  const text = helpText();
  assert.match(text, /\bgrok\b/);
  assert.match(text, /\bcodex\b/);
  assert.match(text, /\bcopilot\b/);
  assert.match(text, /\$retemper/);
  assert.match(text, /\/retemper/);
  assert.match(text, /\/skills/);
  assert.match(text, /\.agents[/\\]?skills/);
  assert.doesNotMatch(text, /Only grok is implemented/i);
  assert.doesNotMatch(text, /Claude\/Codex\/Copilot later/);
  assert.doesNotMatch(text, /later port/i);
});

test("planInstall accepts codex and keeps grok destinations unchanged", () => {
  const grokUser = planInstall({ platform: "grok", scope: "user" });
  const grokProject = planInstall({
    platform: "grok",
    scope: "project",
    target: "/does-not-exist/retemper-grok-proj",
  });
  const home = grokHome();

  assert.equal(grokUser.platform, "grok");
  assert.equal(grokUser.workflowDest, join(home, "workflows", "retemper.rhai"));
  assert.equal(grokUser.refsDest, join(home, "retemper", "references"));
  assert.deepEqual(grokUser.skillDests, [
    join(home, "skills", "grill-me"),
    join(home, "skills", "grilling"),
  ]);
  assert.equal(grokUser.skillDest, null);

  assert.equal(grokProject.platform, "grok");
  assert.ok(grokProject.workflowDest.endsWith(join(".grok", "workflows", "retemper.rhai")));
  assert.ok(grokProject.refsDest.endsWith(join(".grok", "retemper", "references")));
  assert.ok(grokProject.skillDests[0].endsWith(join(".grok", "skills", "grill-me")));
  assert.ok(grokProject.skillDests[1].endsWith(join(".grok", "skills", "grilling")));
});

test("planInstall routes Codex user and project dests under .agents/skills", () => {
  const user = planInstall({ platform: "codex", scope: "user" });
  const project = planInstall({
    platform: "codex",
    scope: "project",
    target: "/does-not-exist/retemper-codex-proj",
  });
  const home = agentsHome();

  assert.equal(user.platform, "codex");
  assert.equal(user.workflowDest, null);
  assert.equal(user.skillDest, join(home, "skills", "retemper"));
  assert.equal(user.refsDest, join(home, "skills", "retemper", "references"));
  assert.deepEqual(user.skillDests, [
    join(home, "skills", "grill-me"),
    join(home, "skills", "grilling"),
  ]);
  assert.ok(user.skillDest.includes(join(".agents", "skills")));
  assert.doesNotMatch(user.skillDest, /\.codex[/\\]prompts/);

  assert.equal(project.platform, "codex");
  assert.equal(project.workflowDest, null);
  assert.ok(project.skillDest.endsWith(join(".agents", "skills", "retemper")));
  assert.ok(project.refsDest.endsWith(join(".agents", "skills", "retemper", "references")));
  assert.ok(project.skillDests[0].endsWith(join(".agents", "skills", "grill-me")));
  assert.ok(project.skillDests[1].endsWith(join(".agents", "skills", "grilling")));
});

test("planInstall rejects unknown platforms", () => {
  assert.throws(() => planInstall({ platform: "claude", scope: "user" }), /copilot/);
  assert.deepEqual(SUPPORTED_PLATFORMS, ["grok", "codex", "copilot"]);
  assert.deepEqual(SKILL_PLATFORMS, ["codex", "copilot"]);
});

test("codex and copilot share one skill source and the same .agents/skills dests", () => {
  const target = "/does-not-exist/retemper-skill-proj";
  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const copilotUser = planInstall({ platform: "copilot", scope: "user" });
  const codexProject = planInstall({ platform: "codex", scope: "project", target });
  const copilotProject = planInstall({ platform: "copilot", scope: "project", target });

  assert.equal(codexUser.skillSrc, copilotUser.skillSrc);
  assert.equal(codexUser.skillSrc, join(root, ".agents", "skills", "retemper"));
  assert.equal(codexUser.skillDest, copilotUser.skillDest);
  assert.equal(codexUser.refsDest, copilotUser.refsDest);
  assert.deepEqual(codexUser.skillDests, copilotUser.skillDests);
  assert.equal(codexProject.skillDest, copilotProject.skillDest);
  assert.equal(codexProject.refsDest, copilotProject.refsDest);
  assert.notEqual(codexUser.platform, copilotUser.platform);

  for (const plan of [copilotUser, copilotProject]) {
    assert.equal(plan.workflowDest, null);
    assert.ok(plan.skillDest.includes(join(".agents", "skills")));
    assert.doesNotMatch(plan.skillDest, /\.github[/\\]skills/);
    assert.doesNotMatch(plan.skillDest, /\.copilot[/\\]/);
    assert.doesNotMatch(plan.skillSrc, /\.github[/\\]/);
  }
});

test("the repo ships one retemper SKILL.md, under .agents/skills", () => {
  assert.equal(existsSync(skillSource), true);
  assert.equal(existsSync(join(root, ".github", "skills", "retemper", "SKILL.md")), false);
  assert.equal(existsSync(join(root, ".copilot", "skills", "retemper", "SKILL.md")), false);
});

test("grok, Codex, and Copilot plans share one platform-neutral refsSrc", () => {
  const grok = planInstall({ platform: "grok", scope: "user" });
  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const copilotUser = planInstall({ platform: "copilot", scope: "user" });
  const copilotProject = planInstall({
    platform: "copilot",
    scope: "project",
    target: "/does-not-exist/retemper-copilot-proj",
  });
  assert.equal(grok.refsSrc, codexUser.refsSrc);
  assert.equal(grok.refsSrc, copilotUser.refsSrc);
  assert.equal(grok.refsSrc, copilotProject.refsSrc);
  assert.equal(grok.refsSrc, join(root, "references"));
  assert.doesNotMatch(grok.refsSrc, /\.grok[/\\]/);
  assert.equal(existsSync(join(grok.refsSrc, "architect.md")), true);
  assert.equal(existsSync(join(grok.refsSrc, "final-qa.md")), true);
  const finalQa = readFileSync(join(grok.refsSrc, "final-qa.md"), "utf8");
  assert.match(finalQa, /skeptic/i);
});

test("the shipped skill payload is a SKILL.md with name and description", () => {
  for (const platform of SKILL_PLATFORMS) {
    const plan = planInstall({ platform, scope: "user" });
    const skillMd = join(plan.skillSrc, "SKILL.md");
    assert.equal(skillMd, skillSource);
    assert.equal(existsSync(skillMd), true);
    const body = readFileSync(skillMd, "utf8");
    assert.match(body, /^---\r?\n/);
    assert.match(body, /^name:\s*retemper\s*$/m);
    assert.match(body, /^description:\s*>?\s*$/m);
    assert.doesNotMatch(plan.skillSrc, /\.rhai$/);
  }
});

test("shipped skill states the cycle rules from PHASES and launch flags", () => {
  const body = readFileSync(skillSource, "utf8");
  for (const title of PHASES) {
    assert.match(body, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(body, /--no-grill/);
  assert.match(body, /--no-grill-me/);
  assert.match(body, /--no-plan/);
  assert.match(body, /--no-standards/);
  assert.match(body, /grill-me/);
  assert.match(body, /CODING_STANDARDS\.md/);
  assert.match(body, /return to \*\*Development\*\*/);
  assert.match(body, /no-skip replay/);
  assert.match(body, /max-cycles/);
  assert.match(body, /\$retemper/);
  assert.match(body, /\/retemper/);
  assert.match(body, /Copilot/);
  assert.match(body, /\/skills/);
  assert.doesNotMatch(body, /\/workflow resume retemper/);
});

test("describe(codex|copilot) names .agents/skills and does not use a .rhai payload", () => {
  for (const platform of SKILL_PLATFORMS) {
    const plan = planInstall({ platform, scope: "user" });
    const text = describe(plan, { dryRun: true, skipDeps: false });
    assert.match(text, new RegExp(`platform=${platform}`));
    assert.match(text, /\.agents[/\\]skills/);
    assert.match(text, /retemper/);
    assert.match(text, /grill-me/);
    assert.match(text, /grilling/);
    assert.doesNotMatch(text, /\.rhai/);
    assert.doesNotMatch(text, /\.github[/\\]skills/);
    assert.doesNotMatch(text, /\.copilot[/\\]skills/);
  }
});

test("CLI dry-run for Codex project prints dests and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-dry-"));
  try {
    const result = cli([
      "--dry-run",
      "--platform",
      "codex",
      "--scope",
      "project",
      "--target",
      target,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /platform=codex/);
    assert.match(result.stdout, /\.agents[/\\]skills/);
    assert.equal(existsSync(join(target, ".agents")), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("CLI --skip-deps Codex project install writes SKILL.md plus grill skills", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-inst-"));
  try {
    const first = cli([
      "--platform",
      "codex",
      "--scope",
      "project",
      "--target",
      target,
      "--skip-deps",
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /installed retemper/);

    const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
    assert.equal(existsSync(skillMd), true);
    const body = readFileSync(skillMd, "utf8");
    assert.match(body, /^name:\s*retemper\s*$/m);
    assert.match(body, /^description:/m);
    assert.equal(existsSync(join(target, ".agents", "skills", "grill-me", "SKILL.md")), true);
    assert.equal(existsSync(join(target, ".agents", "skills", "grilling", "SKILL.md")), true);
    assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "references", "architect.md")), true);
    const pipeline = readFileSync(
      join(target, ".agents", "skills", "retemper", "references", "pipeline.md"),
      "utf8",
    );
    assert.doesNotMatch(pipeline, /\/workflow resume retemper/);
    assert.match(pipeline, /wait on the real status/i);
    assert.match(pipeline, /sleep 300/);
    assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), false);
    assert.equal(existsSync(join(target, ".codex", "prompts")), false);

    const second = cli([
      "--platform",
      "codex",
      "--scope",
      "project",
      "--target",
      target,
      "--skip-deps",
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /installed retemper/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("CLI --skip-deps Copilot project install writes the shared .agents/skills tree", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-copilot-"));
  try {
    const result = cli([
      "--platform",
      "copilot",
      "--scope",
      "project",
      "--target",
      target,
      "--skip-deps",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /platform=copilot/);
    assert.match(result.stdout, /installed retemper/);

    const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
    assert.equal(existsSync(skillMd), true);
    assert.equal(readFileSync(skillMd, "utf8"), readFileSync(skillSource, "utf8"));
    assert.equal(existsSync(join(target, ".agents", "skills", "grill-me", "SKILL.md")), true);
    assert.equal(existsSync(join(target, ".agents", "skills", "grilling", "SKILL.md")), true);
    assert.equal(
      existsSync(join(target, ".agents", "skills", "retemper", "references", "architect.md")),
      true,
    );
    assert.equal(existsSync(join(target, ".github", "skills", "retemper", "SKILL.md")), false);
    assert.equal(existsSync(join(target, ".copilot")), false);
    assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("CLI dry-run for Copilot project prints dests and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-copilot-dry-"));
  try {
    const result = cli([
      "--dry-run",
      "--platform",
      "copilot",
      "--scope",
      "project",
      "--target",
      target,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /platform=copilot/);
    assert.match(result.stdout, /\.agents[/\\]skills/);
    assert.doesNotMatch(result.stdout, /\.github[/\\]skills/);
    assert.equal(existsSync(join(target, ".agents")), false);
    assert.equal(existsSync(join(target, ".github")), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
