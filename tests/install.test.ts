import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PHASES } from "../lib/cycle.ts";
import {
  agentsHome,
  codexHome,
  describe,
  formatInstalls,
  grokHome,
  helpText,
  installsPath,
  missingInstallsMessage,
  parseArgs,
  parseInstalls,
  planInstall,
  recordFromPlan,
  retemperHome,
  SKILL_PLATFORMS,
  SUPPORTED_PLATFORMS,
  upsertInstalls,
} from "../install.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installPath = join(root, "install.ts");
const skillSource = join(root, ".agents", "skills", "retemper", "SKILL.md");
const installedSkillNames = ["retemper", "orchestrate", "grill-me", "grilling"];

function cli(args: string[], env: NodeJS.ProcessEnv = {}, cwd = root) {
  return spawnSync(process.execPath, [installPath, ...args], {
    encoding: "utf8" as const,
    cwd,
    env: { ...process.env, ...env },
  });
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "retemper-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertRealSkillDirectories(home: string): void {
  for (const name of installedSkillNames) {
    const skill = join(home, "skills", name);
    assert.equal(lstatSync(skill).isDirectory(), true, skill);
    assert.equal(existsSync(join(skill, "SKILL.md")), true, skill);
  }
}

test("parseArgs accepts the same flags for every supported platform", () => {
  const grok = parseArgs([
    "node",
    "install.ts",
    "--platform",
    "grok",
    "--scope",
    "user",
    "--dry-run",
    "--skip-deps",
    "--standards",
    "--target",
    "/repo",
    "--update",
  ]);
  const codex = parseArgs([
    "node",
    "install.ts",
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
  assert.deepEqual(grok.platforms, ["grok"]);
  assert.deepEqual(codex.platforms, ["codex"]);
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
  assert.equal(grok.update, true);
  assert.equal(codex.update, false);

  const copilot = parseArgs([
    "node",
    "install.ts",
    "--platform",
    "copilot",
    "--scope",
    "user",
    "--dry-run",
  ]);
  assert.deepEqual(copilot.platforms, ["copilot"]);
  assert.equal(copilot.scope, "user");
  assert.equal(copilot.dryRun, true);

  const cursor = parseArgs([
    "node",
    "install.ts",
    "--platform",
    "cursor",
    "--scope",
    "project",
    "--target",
    "/repo",
  ]);
  assert.deepEqual(cursor.platforms, ["cursor"]);
  assert.equal(cursor.scope, "project");
  assert.equal(cursor.target, "/repo");
});

test("parseArgs collects multiple platforms from spaces, commas, repeats, and --platform=", () => {
  const spaced = parseArgs([
    "node",
    "install.ts",
    "--platform",
    "grok",
    "codex",
    "--scope",
    "user",
  ]);
  assert.deepEqual(spaced.platforms, ["grok", "codex"]);
  assert.equal(spaced.scope, "user");

  const commas = parseArgs([
    "node",
    "install.ts",
    "--platform",
    "grok, copilot",
    "--scope",
    "project",
  ]);
  assert.deepEqual(commas.platforms, ["grok", "copilot"]);

  const repeats = parseArgs([
    "node",
    "install.ts",
    "--platform",
    "grok",
    "--platform",
    "codex",
    "--scope",
    "user",
  ]);
  assert.deepEqual(repeats.platforms, ["grok", "codex"]);

  const equals = parseArgs([
    "node",
    "install.ts",
    "--platform=grok,codex",
    "--scope",
    "user",
  ]);
  assert.deepEqual(equals.platforms, ["grok", "codex"]);

  const mixed = parseArgs([
    "node",
    "install.ts",
    "--platform",
    "grok",
    "--platform=codex,copilot",
    "--platform",
    "grok",
  ]);
  assert.deepEqual(mixed.platforms, ["grok", "codex", "copilot"]);

  assert.throws(
    () => parseArgs(["node", "install.ts", "--platform=grok", "codex"]),
    /Unknown argument: codex/,
  );
});

test("parseArgs rejects missing scope and target values instead of consuming the next option", () => {
  assert.throws(
    () => parseArgs(["node", "install.ts", "--scope", "--dry-run"]),
    /--scope requires a value/,
  );
  assert.throws(
    () => parseArgs(["node", "install.ts", "--target", "--dry-run"]),
    /--target requires a value/,
  );

  const explicitDashTarget = parseArgs([
    "node",
    "install.ts",
    "--scope=project",
    "--target=-repo",
  ]);
  assert.equal(explicitDashTarget.scope, "project");
  assert.equal(explicitDashTarget.target, "-repo");
});

test("help names every supported platform and does not say only grok is implemented", () => {
  const text = helpText();
  assert.match(text, /\bgrok\b/);
  assert.match(text, /\bcodex\b/);
  assert.match(text, /\bcopilot\b/);
  assert.match(text, /\bcursor\b/);
  assert.match(text, /\$retemper/);
  assert.match(text, /\/retemper/);
  assert.match(text, /\/skills/);
  assert.match(text, /\.agents[/\\]?skills/);
  assert.match(text, /orchestrate/);
  assert.doesNotMatch(text, /Only grok is implemented/i);
  assert.doesNotMatch(text, /Claude\/Codex\/Copilot later/);
  assert.doesNotMatch(text, /later port/i);
  assert.match(text, /--update/);
  assert.match(text, /installs\.txt/);
  assert.match(text, /RETEMPER_HOME/);
  assert.match(text, /--platform grok,codex|--platform grok --platform/);
  assert.match(text, /skills\/productivity\/grill-me/);
  assert.match(text, /skills\/productivity\/grilling/);
  assert.doesNotMatch(text, /PromptScript/);
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
  assert.equal(grokUser.targetRoot, home);
  assert.deepEqual(grokUser.skillLinks, []);

  assert.equal(grokProject.platform, "grok");
  assert.ok(grokProject.workflowDest.endsWith(join(".grok", "workflows", "retemper.rhai")));
  assert.ok(grokProject.refsDest.endsWith(join(".grok", "retemper", "references")));
  assert.ok(grokProject.skillDests[0].endsWith(join(".grok", "skills", "grill-me")));
  assert.ok(grokProject.skillDests[1].endsWith(join(".grok", "skills", "grilling")));
  assert.ok(grokProject.targetRoot.endsWith("retemper-grok-proj"));
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
  assert.equal(user.targetRoot, home);
  const codexSkills = join(codexHome(), "skills");
  assert.deepEqual(
    user.skillLinks.map((link) => link.dest),
    [
      join(codexSkills, "retemper"),
      join(codexSkills, "orchestrate"),
      join(codexSkills, "grill-me"),
      join(codexSkills, "grilling"),
    ],
  );
  assert.equal(user.skillLinks[0].src, user.skillDest);

  assert.equal(project.platform, "codex");
  assert.equal(project.workflowDest, null);
  assert.ok(project.skillDest.endsWith(join(".agents", "skills", "retemper")));
  assert.ok(project.refsDest.endsWith(join(".agents", "skills", "retemper", "references")));
  assert.ok(project.skillDests[0].endsWith(join(".agents", "skills", "grill-me")));
  assert.ok(project.skillDests[1].endsWith(join(".agents", "skills", "grilling")));
  assert.ok(project.targetRoot.endsWith("retemper-codex-proj"));
  assert.deepEqual(project.skillLinks, []);
});

test("planInstall routes Cursor through the shared .agents/skills payload", () => {
  const target = "/does-not-exist/retemper-cursor-proj";
  const codex = planInstall({ platform: "codex", scope: "project", target });
  const cursorUser = planInstall({ platform: "cursor", scope: "user" });
  const cursorProject = planInstall({ platform: "cursor", scope: "project", target });

  assert.equal(cursorUser.skillSrc, codex.skillSrc);
  assert.equal(cursorUser.skillDest, join(agentsHome(), "skills", "retemper"));
  assert.equal(cursorProject.skillDest, codex.skillDest);
  assert.equal(cursorProject.refsDest, codex.refsDest);
  assert.deepEqual(cursorProject.skillDests, codex.skillDests);
  assert.equal(cursorProject.workflowDest, null);
  assert.doesNotMatch(cursorUser.skillDest, /\.cursor[/\\]skills/);
  assert.doesNotMatch(cursorProject.skillDest, /\.cursor[/\\]skills/);
  assert.deepEqual(cursorUser.skillLinks, []);
  assert.deepEqual(cursorProject.skillLinks, []);
  for (const argv of [...cursorUser.fetchCommands, ...cursorProject.fetchCommands]) {
    assert.equal(fetchAgent(argv), "cline");
  }
});

test("grill fetch targets productivity skill folders, not the whole mattpocock catalog", () => {
  const grokUser = planInstall({ platform: "grok", scope: "user" });
  const grokProject = planInstall({
    platform: "grok",
    scope: "project",
    target: "/does-not-exist/retemper-grok-proj",
  });
  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const copilotProject = planInstall({
    platform: "copilot",
    scope: "project",
    target: "/does-not-exist/retemper-skill-proj",
  });
  const cursorProject = planInstall({
    platform: "cursor",
    scope: "project",
    target: "/does-not-exist/retemper-skill-proj",
  });

  for (const plan of [grokUser, grokProject, codexUser, copilotProject, cursorProject]) {
    const sources = plan.fetchCommands.map((argv) => argv.find((token) => String(token).startsWith("mattpocock/")));
    assert.deepEqual(sources, [
      "mattpocock/skills/skills/productivity/grill-me",
      "mattpocock/skills/skills/productivity/grilling",
    ]);
    for (const argv of plan.fetchCommands) {
      assert.equal(argv.includes("mattpocock/skills"), false);
    }
  }

  assert.equal(grokUser.fetchCommands[0].includes("--global"), true);
  assert.equal(codexUser.fetchCommands[1].includes("--global"), true);
  assert.equal(grokProject.fetchCommands[0].includes("--global"), false);
  assert.equal(copilotProject.fetchCommands[1].includes("--global"), false);

  const described = describe(grokUser, { dryRun: true, skipDeps: false });
  assert.match(described, /skills\/productivity\/grill-me/);
  assert.match(described, /skills\/productivity\/grilling/);
  assert.doesNotMatch(described, /add mattpocock\/skills --skill/);
});

function fetchAgent(argv: string[]) {
  const index = argv.indexOf("--agent");
  assert.ok(index >= 0, `expected --agent in ${argv.join(" ")}`);
  return argv[index + 1];
}

test("grill fetch --agent follows the selected platform dest", () => {
  const grokUser = planInstall({ platform: "grok", scope: "user" });
  const grokProject = planInstall({
    platform: "grok",
    scope: "project",
    target: "/does-not-exist/retemper-grok-proj",
  });
  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const copilotUser = planInstall({ platform: "copilot", scope: "user" });
  const copilotProject = planInstall({
    platform: "copilot",
    scope: "project",
    target: "/does-not-exist/retemper-skill-proj",
  });
  const cursorUser = planInstall({ platform: "cursor", scope: "user" });
  const cursorProject = planInstall({
    platform: "cursor",
    scope: "project",
    target: "/does-not-exist/retemper-skill-proj",
  });

  for (const argv of [...grokUser.fetchCommands, ...grokProject.fetchCommands]) {
    assert.equal(fetchAgent(argv), "grok");
  }
  for (const argv of [
    ...codexUser.fetchCommands,
    ...copilotUser.fetchCommands,
    ...copilotProject.fetchCommands,
    ...cursorUser.fetchCommands,
    ...cursorProject.fetchCommands,
  ]) {
    assert.equal(fetchAgent(argv), "cline");
  }

  assert.match(describe(grokUser, { dryRun: true, skipDeps: false }), /--agent grok/);
  assert.match(describe(codexUser, { dryRun: true, skipDeps: false }), /--agent cline/);
  assert.match(describe(cursorUser, { dryRun: true, skipDeps: false }), /--agent cline/);
});

test("planInstall rejects unknown platforms", () => {
  assert.throws(() => planInstall({ platform: "claude", scope: "user" }), /cursor/);
  assert.deepEqual(SUPPORTED_PLATFORMS, ["grok", "codex", "copilot", "cursor"]);
  assert.deepEqual(SKILL_PLATFORMS, ["codex", "copilot", "cursor"]);
});

test("planInstall rejects a project scope without an explicit target", () => {
  assert.throws(
    () => planInstall({ platform: "codex", scope: "project" }),
    /--target.*required/,
  );
});

test("codex, copilot, and cursor share one skill source and .agents/skills dests", () => {
  const target = "/does-not-exist/retemper-skill-proj";
  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const copilotUser = planInstall({ platform: "copilot", scope: "user" });
  const cursorUser = planInstall({ platform: "cursor", scope: "user" });
  const codexProject = planInstall({ platform: "codex", scope: "project", target });
  const copilotProject = planInstall({ platform: "copilot", scope: "project", target });
  const cursorProject = planInstall({ platform: "cursor", scope: "project", target });

  assert.equal(codexUser.skillSrc, copilotUser.skillSrc);
  assert.equal(codexUser.skillSrc, cursorUser.skillSrc);
  assert.equal(codexUser.skillSrc, join(root, ".agents", "skills", "retemper"));
  assert.equal(codexUser.skillDest, copilotUser.skillDest);
  assert.equal(codexUser.skillDest, cursorUser.skillDest);
  assert.equal(codexUser.refsDest, copilotUser.refsDest);
  assert.deepEqual(codexUser.skillDests, copilotUser.skillDests);
  assert.equal(codexProject.skillDest, copilotProject.skillDest);
  assert.equal(codexProject.skillDest, cursorProject.skillDest);
  assert.equal(codexProject.refsDest, copilotProject.refsDest);
  assert.notEqual(codexUser.platform, copilotUser.platform);
  assert.notEqual(codexUser.skillLinks.length, 0);
  assert.deepEqual(copilotUser.skillLinks, []);
  assert.deepEqual(cursorUser.skillLinks, []);

  for (const plan of [copilotUser, copilotProject, cursorUser, cursorProject]) {
    assert.equal(plan.workflowDest, null);
    assert.ok(plan.skillDest.includes(join(".agents", "skills")));
    assert.doesNotMatch(plan.skillDest, /\.github[/\\]skills/);
    assert.doesNotMatch(plan.skillDest, /\.copilot[/\\]/);
    assert.doesNotMatch(plan.skillDest, /\.cursor[/\\]/);
    assert.doesNotMatch(plan.skillSrc, /\.github[/\\]/);
  }
});

test("the repo ships one retemper SKILL.md, under .agents/skills", () => {
  assert.equal(existsSync(skillSource), true);
  assert.equal(existsSync(join(root, ".github", "skills", "retemper", "SKILL.md")), false);
  assert.equal(existsSync(join(root, ".copilot", "skills", "retemper", "SKILL.md")), false);
  assert.equal(existsSync(join(root, ".cursor", "skills", "retemper", "SKILL.md")), false);
});

test("all platform plans share one platform-neutral refsSrc", () => {
  const grok = planInstall({ platform: "grok", scope: "user" });
  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const copilotUser = planInstall({ platform: "copilot", scope: "user" });
  const copilotProject = planInstall({
    platform: "copilot",
    scope: "project",
    target: "/does-not-exist/retemper-copilot-proj",
  });
  const cursorProject = planInstall({
    platform: "cursor",
    scope: "project",
    target: "/does-not-exist/retemper-cursor-proj",
  });
  assert.equal(grok.refsSrc, codexUser.refsSrc);
  assert.equal(grok.refsSrc, copilotUser.refsSrc);
  assert.equal(grok.refsSrc, copilotProject.refsSrc);
  assert.equal(grok.refsSrc, cursorProject.refsSrc);
  assert.equal(grok.refsSrc, join(root, "references"));
  assert.doesNotMatch(grok.refsSrc, /\.grok[/\\]/);
  assert.equal(existsSync(join(grok.refsSrc, "architect.md")), true);
  assert.equal(existsSync(join(grok.refsSrc, "orchestrator.md")), true);
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
  assert.match(body, /Cursor/);
  assert.match(body, /\/skills/);
  assert.doesNotMatch(body, /\/workflow resume retemper/);
});

test("describe(grok) names the workflow and orchestrate skill", () => {
  const plan = planInstall({ platform: "grok", scope: "user" });
  const text = describe(plan, { dryRun: true, skipDeps: false });
  assert.match(text, /platform=grok/);
  assert.match(text, /orchestrate:/);
  assert.match(text, /\.rhai/);
  assert.match(plan.orchestrateDest, /[/\\]\.grok[/\\]skills[/\\]orchestrate$/);
});

test("describe(skill platform) names shared skills and only Codex compatibility links", () => {
  for (const platform of SKILL_PLATFORMS) {
    const plan = planInstall({ platform, scope: "user" });
    const text = describe(plan, { dryRun: true, skipDeps: false });
    assert.match(text, new RegExp(`platform=${platform}`));
    assert.match(text, /\.agents[/\\]skills/);
    assert.match(text, /retemper/);
    assert.match(text, /orchestrate:/);
    assert.match(text, /grill-me/);
    assert.match(text, /grilling/);
    if (platform === "codex") assert.match(text, /codex skill link:/);
    else assert.doesNotMatch(text, /codex skill link:/);
    assert.doesNotMatch(text, /\.rhai/);
    assert.doesNotMatch(text, /\.github[/\\]skills/);
    assert.doesNotMatch(text, /\.copilot[/\\]skills/);
    assert.doesNotMatch(text, /\.cursor[/\\]skills/);
  }
});

test("CLI dry-run for Codex project prints dests and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-dry-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--dry-run", "--platform", "codex", "--scope", "project", "--target", target],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /platform=codex/);
      assert.match(result.stdout, /\.agents[/\\]skills/);
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI dry-run does not create a nonexistent state home", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-dry-state-"));
  const target = join(holder, "project");
  const home = join(holder, "missing-state");
  mkdirSync(target);
  try {
    const result = cli(
      ["--dry-run", "--platform", "codex", "--scope", "project", "--target", target],
      { RETEMPER_HOME: home },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(join(target, ".agents")), false);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("CLI project install requires an explicit target and leaves the working directory untouched", () => {
  const workingDirectory = mkdtempSync(join(tmpdir(), "retemper-no-target-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "codex", "--scope", "project", "--skip-deps"],
        { RETEMPER_HOME: home },
        workingDirectory,
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--target/);
      assert.equal(existsSync(join(workingDirectory, ".agents")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);

      const missingValue = cli(
        [
          "--platform",
          "codex",
          "--scope",
          "project",
          "--target",
          "--dry-run",
          "--skip-deps",
        ],
        { RETEMPER_HOME: home },
        workingDirectory,
      );

      assert.notEqual(missingValue.status, 0);
      assert.match(missingValue.stderr, /--target requires a value/);
      assert.equal(existsSync(join(workingDirectory, "--dry-run")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);

      const dashTarget = cli(
        [
          "--platform",
          "codex",
          "--scope=project",
          "--target=-repo",
          "--skip-deps",
        ],
        { RETEMPER_HOME: home },
        workingDirectory,
      );

      assert.equal(dashTarget.status, 0, dashTarget.stderr);
      assert.equal(
        existsSync(join(workingDirectory, "-repo", ".agents", "skills", "retemper", "SKILL.md")),
        true,
      );
    } finally {
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  });
});

test("CLI --skip-deps Codex project install writes SKILL.md plus grill skills", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-inst-"));
  withHome((home) => {
    try {
      const first = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
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
      assert.equal(existsSync(join(target, ".agents", "skills", "orchestrate", "SKILL.md")), true);
      assert.equal(
        existsSync(join(target, ".agents", "skills", "orchestrate", "references", "orchestrator.md")),
        true,
      );
      const pipeline = readFileSync(
        join(target, ".agents", "skills", "retemper", "references", "pipeline.md"),
        "utf8",
      );
      assert.doesNotMatch(pipeline, /\/workflow resume retemper/);
      assert.match(pipeline, /wait on the real status/i);
      assert.match(pipeline, /sleep 300/);
      assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), false);
      assert.equal(existsSync(join(target, ".codex", "prompts")), false);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), `codex project ${target}`);

      const second = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /installed retemper/);
      const lines = readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n");
      assert.deepEqual(lines, [`codex project ${target}`]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("retemperHome and installsPath honor RETEMPER_HOME", () => {
  const prev = process.env.RETEMPER_HOME;
  process.env.RETEMPER_HOME = "/tmp/retemper-home-override";
  try {
    assert.equal(retemperHome(), "/tmp/retemper-home-override");
    assert.equal(installsPath(), join("/tmp/retemper-home-override", "installs.txt"));
  } finally {
    if (prev === undefined) delete process.env.RETEMPER_HOME;
    else process.env.RETEMPER_HOME = prev;
  }
});

test("agentsHome honors AGENTS_HOME", () => {
  const prev = process.env.AGENTS_HOME;
  process.env.AGENTS_HOME = "/tmp/retemper-agents-override";
  try {
    assert.equal(agentsHome(), "/tmp/retemper-agents-override");
  } finally {
    if (prev === undefined) delete process.env.AGENTS_HOME;
    else process.env.AGENTS_HOME = prev;
  }
});

test("codexHome honors CODEX_HOME", () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/tmp/retemper-codex-override";
  try {
    assert.equal(codexHome(), "/tmp/retemper-codex-override");
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("CLI --skip-deps Copilot project install writes the shared .agents/skills tree", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-copilot-"));
  withHome((home) => {
    try {
      const result = cli(
        [
          "--platform",
          "copilot",
          "--scope",
          "project",
          "--target",
          target,
          "--skip-deps",
        ],
        { RETEMPER_HOME: home },
      );
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
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), `copilot project ${target}`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: Cursor project install writes the complete shared skill tree", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-cursor-"));
  withHome((home) => {
    try {
      const result = cli(
        [
          "--platform",
          "cursor",
          "--scope",
          "project",
          "--target",
          target,
          "--skip-deps",
        ],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /platform=cursor/);
      assert.match(result.stdout, /installed retemper/);

      const skills = join(target, ".agents", "skills");
      assert.equal(existsSync(join(skills, "retemper", "SKILL.md")), true);
      assert.equal(existsSync(join(skills, "retemper", "references", "architect.md")), true);
      assert.equal(existsSync(join(skills, "orchestrate", "SKILL.md")), true);
      assert.equal(existsSync(join(skills, "grill-me", "SKILL.md")), true);
      assert.equal(existsSync(join(skills, "grilling", "SKILL.md")), true);
      assert.equal(existsSync(join(target, ".cursor")), false);
      assert.equal(
        readFileSync(join(home, "installs.txt"), "utf8").trim(),
        `cursor project ${target}`,
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: Cursor user install and update leave Codex skills untouched", () => {
  const agents = mkdtempSync(join(tmpdir(), "retemper-cursor-agents-"));
  const codex = mkdtempSync(join(tmpdir(), "retemper-cursor-codex-"));
  withHome((home) => {
    const marker = join(codex, "skills", "retemper", "codex-owned.txt");
    try {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, "keep me\n");
      const env = { RETEMPER_HOME: home, AGENTS_HOME: agents, CODEX_HOME: codex };

      const installed = cli(
        ["--platform", "cursor", "--scope", "user", "--skip-deps"],
        env,
      );
      assert.equal(installed.status, 0, installed.stderr);
      const skillMd = join(agents, "skills", "retemper", "SKILL.md");
      rmSync(skillMd);

      const updated = cli(["--update", "--skip-deps"], env);
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(existsSync(skillMd), true);
      assert.equal(readFileSync(marker, "utf8"), "keep me\n");
      assert.equal(lstatSync(dirname(marker)).isDirectory(), true);
      assert.equal(existsSync(join(codex, "skills", "orchestrate")), false);
      assert.equal(existsSync(join(codex, "skills", "grill-me")), false);
      assert.equal(existsSync(join(codex, "skills", "grilling")), false);
    } finally {
      rmSync(agents, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
    }
  });
});

test("acceptance: Cursor project install and update refresh dependencies in the target", () => {
  const caller = mkdtempSync(join(tmpdir(), "retemper-cursor-caller-"));
  const target = mkdtempSync(join(tmpdir(), "retemper-cursor-target-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "retemper-fake-bin-"));
  withHome((home) => {
    const fakeNpx = join(fakeBin, "npx");
    const log = join(home, "npx-cwds.txt");
    try {
      writeFileSync(
        fakeNpx,
        [
          "#!/bin/sh",
          'printf "%s\\n" "$PWD" >> "$RETEMPER_FAKE_NPX_LOG"',
          'mkdir -p "$PWD/.agents/skills/dependency-refresh"',
          'printf "dependency refresh\\n" > "$PWD/.agents/skills/dependency-refresh/SKILL.md"',
          "",
        ].join("\n"),
      );
      chmodSync(fakeNpx, 0o755);
      const env = {
        RETEMPER_HOME: home,
        RETEMPER_FAKE_NPX_LOG: log,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      };

      const installed = cli(
        ["--platform", "cursor", "--scope", "project", "--target", target],
        env,
        caller,
      );
      assert.equal(installed.status, 0, installed.stderr);

      const updated = cli(["--update"], env, caller);
      assert.equal(updated.status, 0, updated.stderr);
      const targetCwd = realpathSync(target);
      assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
        targetCwd,
        targetCwd,
        targetCwd,
        targetCwd,
      ]);
      assert.equal(
        existsSync(join(target, ".agents", "skills", "dependency-refresh", "SKILL.md")),
        true,
      );
      assert.equal(existsSync(join(caller, ".agents")), false);
    } finally {
      rmSync(caller, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});

test("CLI dry-run for Copilot project prints dests and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-copilot-dry-"));
  withHome((home) => {
    try {
      const result = cli(
        [
          "--dry-run",
          "--platform",
          "copilot",
          "--scope",
          "project",
          "--target",
          target,
        ],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /platform=copilot/);
      assert.match(result.stdout, /\.agents[/\\]skills/);
      assert.doesNotMatch(result.stdout, /\.github[/\\]skills/);
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(existsSync(join(target, ".github")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("parseInstalls skips comments and blanks and keeps paths with spaces", () => {
  const parsed = parseInstalls(
    [
      "# a comment",
      "",
      "grok user /Users/you/.grok",
      "codex project /tmp/my repo",
      "cursor user /Users/you/.agents",
      "not-a-platform user /tmp/x",
      "grok nope /tmp/x",
    ].join("\n"),
  );
  assert.deepEqual(parsed[0], { platform: "grok", scope: "user", path: "/Users/you/.grok" });
  assert.deepEqual(parsed[1], { platform: "codex", scope: "project", path: "/tmp/my repo" });
  assert.deepEqual(parsed[2], { platform: "cursor", scope: "user", path: "/Users/you/.agents" });
  assert.equal(parsed[3].invalid, true);
  assert.equal(parsed[4].invalid, true);
  assert.equal(formatInstalls(parsed).includes("codex project /tmp/my repo"), true);
});

test("upsertInstalls is unique per user platform and per project path", () => {
  let entries = [];
  entries = upsertInstalls(entries, { platform: "grok", scope: "user", path: "/a/.grok" });
  entries = upsertInstalls(entries, { platform: "grok", scope: "user", path: "/b/.grok" });
  entries = upsertInstalls(entries, { platform: "codex", scope: "user", path: "/a/.agents" });
  entries = upsertInstalls(entries, { platform: "codex", scope: "project", path: "/repo" });
  entries = upsertInstalls(entries, { platform: "grok", scope: "project", path: "/repo" });
  entries = upsertInstalls(entries, { platform: "codex", scope: "project", path: "/repo" });
  entries = upsertInstalls(entries, { platform: "codex", scope: "project", path: "/other" });
  assert.deepEqual(entries, [
    { platform: "grok", scope: "user", path: "/b/.grok" },
    { platform: "codex", scope: "user", path: "/a/.agents" },
    { platform: "codex", scope: "project", path: "/repo" },
    { platform: "grok", scope: "project", path: "/repo" },
    { platform: "codex", scope: "project", path: "/other" },
  ]);
});

test("recordFromPlan uses targetRoot for user home and project repo", () => {
  const grokUser = planInstall({ platform: "grok", scope: "user" });
  const codexProject = planInstall({
    platform: "codex",
    scope: "project",
    target: "/does-not-exist/retemper-codex-proj",
  });
  assert.deepEqual(recordFromPlan(grokUser), {
    platform: "grok",
    scope: "user",
    path: grokHome(),
  });
  assert.equal(recordFromPlan(codexProject).platform, "codex");
  assert.equal(recordFromPlan(codexProject).scope, "project");
  assert.ok(recordFromPlan(codexProject).path.endsWith("retemper-codex-proj"));
});

test("missingInstallsMessage names the file and asks for --platform and --scope", () => {
  const text = missingInstallsMessage("/tmp/retemper-home/installs.txt");
  assert.match(text, /\/tmp\/retemper-home\/installs\.txt/);
  assert.match(text, /--platform/);
  assert.match(text, /--scope/);
  assert.match(text, /--target/);
  assert.match(text, /cursor/);
});

test("CLI --update with no tracking file tells the user to install and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-noupdate-"));
  withHome((home) => {
    try {
      const result = cli(["--update"], { RETEMPER_HOME: home });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /installs\.txt/);
      assert.match(result.stderr, /--scope/);
      assert.match(result.stderr, /--platform/);
      assert.equal(existsSync(join(home, "installs.txt")), false);
      assert.equal(existsSync(join(target, ".agents")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --update with no tracking file does not create a nonexistent state home", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-update-missing-state-"));
  const home = join(holder, "missing-state");
  try {
    const result = cli(["--update"], { RETEMPER_HOME: home });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /installs\.txt/);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("CLI --update restores a deleted Cursor project payload from the tracking file", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-upd-"));
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
      rmSync(skillMd);
      assert.equal(existsSync(skillMd), false);

      const updated = cli(["--update", "--skip-deps"], { RETEMPER_HOME: home });
      assert.equal(updated.status, 0, updated.stderr);
      assert.match(updated.stdout, /platform=cursor/);
      assert.equal(existsSync(skillMd), true);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), `cursor project ${target}`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --update --dry-run does not restore files or rewrite the tracking file", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-upddry-"));
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
      rmSync(skillMd);
      const before = readFileSync(join(home, "installs.txt"), "utf8");

      const result = cli(["--update", "--dry-run"], { RETEMPER_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /platform=codex/);
      assert.equal(existsSync(skillMd), false);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8"), before);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --update drops a vanished project path and still updates a live dest", () => {
  const live = mkdtempSync(join(tmpdir(), "retemper-live-"));
  const gone = join(tmpdir(), `retemper-gone-${Date.now()}`);
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", live, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      writeFileSync(
        join(home, "installs.txt"),
        `codex project ${live}\ncodex project ${gone}\n`,
      );
      const skillMd = join(live, ".agents", "skills", "retemper", "SKILL.md");
      rmSync(skillMd);

      const result = cli(["--update", "--skip-deps"], { RETEMPER_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /gone/);
      assert.equal(existsSync(skillMd), true);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), `codex project ${live}`);
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });
});

test("CLI --update --dry-run leaves a vanished project path in the tracking file", () => {
  const live = mkdtempSync(join(tmpdir(), "retemper-drygone-"));
  const gone = join(tmpdir(), `retemper-drygone-missing-${Date.now()}`);
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", live, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const listed = `codex project ${live}\ncodex project ${gone}\n`;
      writeFileSync(join(home, "installs.txt"), listed);

      const result = cli(["--update", "--dry-run"], { RETEMPER_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /gone/);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8"), listed);
    } finally {
      rmSync(live, { recursive: true, force: true });
    }
  });
});

test("CLI --update with an empty tracking file reports nothing to update", () => {
  withHome((home) => {
    writeFileSync(join(home, "installs.txt"), "");
    const result = cli(["--update"], { RETEMPER_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /nothing to update/i);
    assert.equal(existsSync(join(home, "state.generation")), false);
    assert.equal(existsSync(join(home, "state.lock")), false);
  });
});

test("CLI --update --help prints help and does not require a tracking file", () => {
  withHome((home) => {
    const result = cli(["--update", "--help"], { RETEMPER_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--update/);
    assert.equal(existsSync(join(home, "installs.txt")), false);
  });
});

test("CLI grok user install records the home and --update restores it", () => {
  const grok = mkdtempSync(join(tmpdir(), "retemper-grokhome-"));
  withHome((home) => {
    try {
      const env = { RETEMPER_HOME: home, GROK_HOME: grok };
      const installed = cli(["--platform", "grok", "--scope", "user", "--skip-deps"], env);
      assert.equal(installed.status, 0, installed.stderr);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), `grok user ${grok}`);
      const workflow = join(grok, "workflows", "retemper.rhai");
      assert.equal(existsSync(workflow), true);
      rmSync(workflow);

      const updated = cli(["--update", "--skip-deps"], env);
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(existsSync(workflow), true);
    } finally {
      rmSync(grok, { recursive: true, force: true });
    }
  });
});

test("CLI --update keeps a malformed line and still updates a valid dest", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-malformed-"));
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      writeFileSync(join(home, "installs.txt"), `codex project ${target}\nnot-a-line\n`);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
      rmSync(skillMd);

      const result = cli(["--update", "--skip-deps"], { RETEMPER_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /malformed/);
      assert.equal(existsSync(skillMd), true);
      const recorded = readFileSync(join(home, "installs.txt"), "utf8");
      assert.match(recorded, /not-a-line/);
      assert.match(recorded, new RegExp(`codex project ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --update collapses duplicate tracking lines for the same dest", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-dup-"));
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      writeFileSync(
        join(home, "installs.txt"),
        `codex project ${target}\ncodex project ${target}\n`,
      );
      const result = cli(["--update", "--skip-deps"], { RETEMPER_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n"), [
        `codex project ${target}`,
      ]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --update --standards copies the template when the project file is missing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-std-"));
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const standards = join(target, "CODING_STANDARDS.md");
      assert.equal(existsSync(standards), false);

      const updated = cli(["--update", "--skip-deps", "--standards"], { RETEMPER_HOME: home });
      assert.equal(updated.status, 0, updated.stderr);
      assert.equal(existsSync(standards), true);
      assert.match(readFileSync(standards, "utf8"), /Living document/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --update ignores --platform and uses the tracking file", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-ignoreplat-"));
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
      rmSync(skillMd);

      const result = cli(
        ["--update", "--platform", "grok", "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(skillMd), true);
      assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI records grok and codex project dests on the same repo", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-both-"));
  withHome((home) => {
    try {
      const grok = cli(
        ["--platform", "grok", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      const codex = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(grok.status, 0, grok.stderr);
      assert.equal(codex.status, 0, codex.stderr);
      assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), true);
      const lines = readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n");
      assert.deepEqual(lines, [`grok project ${target}`, `codex project ${target}`]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --platform grok codex project install writes both dests and two tracking lines", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-multi-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "grok", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /platform=grok/);
      assert.match(result.stdout, /platform=codex/);
      assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), true);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.deepEqual(readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n"), [
        `grok project ${target}`,
        `codex project ${target}`,
      ]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --platform=grok,codex and repeated --platform install the same dests", () => {
  const commaTarget = mkdtempSync(join(tmpdir(), "retemper-comma-"));
  const repeatTarget = mkdtempSync(join(tmpdir(), "retemper-repeat-"));
  withHome((home) => {
    try {
      const commas = cli(
        ["--platform=grok,codex", "--scope", "project", "--target", commaTarget, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      const repeats = cli(
        [
          "--platform",
          "grok",
          "--platform",
          "codex",
          "--scope",
          "project",
          "--target",
          repeatTarget,
          "--skip-deps",
        ],
        { RETEMPER_HOME: home },
      );
      assert.equal(commas.status, 0, commas.stderr);
      assert.equal(repeats.status, 0, repeats.stderr);
      assert.equal(existsSync(join(commaTarget, ".grok", "workflows", "retemper.rhai")), true);
      assert.equal(existsSync(join(commaTarget, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.equal(existsSync(join(repeatTarget, ".grok", "workflows", "retemper.rhai")), true);
      assert.equal(existsSync(join(repeatTarget, ".agents", "skills", "retemper", "SKILL.md")), true);
    } finally {
      rmSync(commaTarget, { recursive: true, force: true });
      rmSync(repeatTarget, { recursive: true, force: true });
    }
  });
});

test("CLI dry-run with several platforms prints each plan and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-multidry-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--dry-run", "--platform", "grok,codex", "--scope", "project", "--target", target],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /platform=grok/);
      assert.match(result.stdout, /platform=codex/);
      assert.equal(existsSync(join(target, ".grok")), false);
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --platform grok claude rejects the unknown name and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-badplat-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "grok", "claude", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsupported platform "claude"/);
      assert.equal(existsSync(join(target, ".grok")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI rejects an invalid platform before creating state", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-invalid-state-"));
  const target = join(holder, "project");
  const home = join(holder, "missing-state");
  mkdirSync(target);
  try {
    const result = cli(
      ["--platform", "nope", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported platform "nope"/);
    assert.equal(existsSync(home), false);
    assert.equal(existsSync(join(target, ".agents")), false);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("CLI multi-platform user install writes Grok and shared Cursor skill dests", () => {
  const grok = mkdtempSync(join(tmpdir(), "retemper-user-grok-"));
  const agents = mkdtempSync(join(tmpdir(), "retemper-user-agents-"));
  const codex = mkdtempSync(join(tmpdir(), "retemper-user-codex-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "grok", "codex", "cursor", "--scope", "user", "--skip-deps"],
        {
          RETEMPER_HOME: home,
          GROK_HOME: grok,
          AGENTS_HOME: agents,
          CODEX_HOME: codex,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /platform=cursor/);
      assert.equal(existsSync(join(grok, "workflows", "retemper.rhai")), true);
      assert.equal(existsSync(join(agents, "skills", "retemper", "SKILL.md")), true);
      for (const name of ["retemper", "orchestrate", "grill-me", "grilling"]) {
        const dest = join(codex, "skills", name);
        assert.equal(lstatSync(dest).isSymbolicLink(), true, dest);
        assert.equal(resolve(readlinkSync(dest)), resolve(join(agents, "skills", name)));
        assert.equal(existsSync(join(dest, "SKILL.md")), true);
      }
      assert.deepEqual(readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n"), [
        `grok user ${grok}`,
        `codex user ${agents}`,
        `cursor user ${agents}`,
      ]);
    } finally {
      rmSync(grok, { recursive: true, force: true });
      rmSync(agents, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
    }
  });
});

test("CLI user install preserves skills when the Agents and Codex homes are the same", () => {
  const sharedHome = mkdtempSync(join(tmpdir(), "retemper-shared-agent-home-"));
  withHome((home) => {
    try {
      const result = cli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: sharedHome,
        CODEX_HOME: sharedHome,
      });

      assert.equal(result.status, 0, result.stderr);
      assertRealSkillDirectories(sharedHome);
    } finally {
      rmSync(sharedHome, { recursive: true, force: true });
    }
  });
});

test("CLI user install preserves skills when Codex home aliases Agents home", () => {
  const agents = mkdtempSync(join(tmpdir(), "retemper-agent-home-"));
  const aliasRoot = mkdtempSync(join(tmpdir(), "retemper-agent-alias-"));
  const codex = join(aliasRoot, "codex-home");
  symlinkSync(agents, codex, "dir");
  withHome((home) => {
    try {
      const result = cli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: agents,
        CODEX_HOME: codex,
      });

      assert.equal(result.status, 0, result.stderr);
      assertRealSkillDirectories(agents);
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
      rmSync(agents, { recursive: true, force: true });
    }
  });
});

test("CLI user install preserves skills across case aliases when supported", (context) => {
  const agents = mkdtempSync(join(tmpdir(), "retemper-Agent-home-"));
  const codex = agents.replace("Agent", "agent");
  if (!existsSync(codex)) {
    rmSync(agents, { recursive: true, force: true });
    context.skip("filesystem is case-sensitive");
    return;
  }

  withHome((home) => {
    try {
      const result = cli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: agents,
        CODEX_HOME: codex,
      });

      assert.equal(result.status, 0, result.stderr);
      assertRealSkillDirectories(agents);
    } finally {
      rmSync(agents, { recursive: true, force: true });
    }
  });
});

test("CLI user install repairs legacy self-referential skill links", () => {
  const sharedHome = mkdtempSync(join(tmpdir(), "retemper-legacy-agent-home-"));
  const skills = join(sharedHome, "skills");
  mkdirSync(skills, { recursive: true });
  for (const name of installedSkillNames) {
    const skill = join(skills, name);
    symlinkSync(skill, skill, "dir");
  }

  withHome((home) => {
    try {
      const result = cli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: sharedHome,
        CODEX_HOME: sharedHome,
      });

      assert.equal(result.status, 0, result.stderr);
      assertRealSkillDirectories(sharedHome);
    } finally {
      rmSync(sharedHome, { recursive: true, force: true });
    }
  });
});

test("CLI rejects an escaped skills parent before repairing an external self-link", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-escaped-self-link-"));
  const agents = join(holder, "agents");
  const externalSkills = join(holder, "external-skills");
  const home = join(holder, "state");
  mkdirSync(agents);
  mkdirSync(externalSkills);
  symlinkSync(externalSkills, join(agents, "skills"), "dir");
  const externalSkill = join(externalSkills, "retemper");
  symlinkSync(externalSkill, externalSkill, "dir");
  try {
    const result = cli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
      RETEMPER_HOME: home,
      AGENTS_HOME: agents,
      CODEX_HOME: agents,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside.*physical.*root|escapes.*target/i);
    assert.equal(lstatSync(externalSkill).isSymbolicLink(), true);
    assert.equal(resolve(dirname(externalSkill), readlinkSync(externalSkill)), externalSkill);
    assert.equal(existsSync(join(home, "installs.txt")), false);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("CLI user install does not replace an unrelated dangling skill link", () => {
  const sharedHome = mkdtempSync(join(tmpdir(), "retemper-dangling-agent-home-"));
  const skill = join(sharedHome, "skills", "retemper");
  const unrelatedTarget = join(sharedHome, "unrelated-missing-skill");
  mkdirSync(dirname(skill), { recursive: true });
  symlinkSync(unrelatedTarget, skill, "dir");

  withHome((home) => {
    try {
      const result = cli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: sharedHome,
        CODEX_HOME: sharedHome,
      });

      assert.notEqual(result.status, 0);
      assert.equal(lstatSync(skill).isSymbolicLink(), true);
      assert.equal(resolve(dirname(skill), readlinkSync(skill)), unrelatedTarget);
    } finally {
      rmSync(sharedHome, { recursive: true, force: true });
    }
  });
});

test("CLI --platform with only commas fails and writes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-emptyplat-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", ",", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsupported platform/);
      assert.equal(existsSync(join(target, ".grok")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --platform grok,codex,grok records each platform once", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-dedup-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "grok,codex,grok", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n"), [
        `grok project ${target}`,
        `codex project ${target}`,
      ]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --platform codex copilot cursor records three skill lines on one dest tree", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-skills-"));
  withHome((home) => {
    try {
      const result = cli(
        [
          "--platform",
          "codex",
          "copilot",
          "cursor",
          "--scope",
          "project",
          "--target",
          target,
          "--skip-deps",
        ],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.deepEqual(readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n"), [
        `codex project ${target}`,
        `copilot project ${target}`,
        `cursor project ${target}`,
      ]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
