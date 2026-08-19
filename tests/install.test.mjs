import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { PHASES } from "../lib/cycle.mjs";
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
} from "../install.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installPath = join(root, "install.mjs");
const skillSource = join(root, ".agents", "skills", "retemper", "SKILL.md");

function cli(args, env = {}) {
  return spawnSync(process.execPath, [installPath, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, ...env },
  });
}

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "retemper-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
    "--update",
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
    "install.mjs",
    "--platform",
    "copilot",
    "--scope",
    "user",
    "--dry-run",
  ]);
  assert.deepEqual(copilot.platforms, ["copilot"]);
  assert.equal(copilot.scope, "user");
  assert.equal(copilot.dryRun, true);
});

test("parseArgs collects multiple platforms from spaces, commas, repeats, and --platform=", () => {
  const spaced = parseArgs([
    "node",
    "install.mjs",
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
    "install.mjs",
    "--platform",
    "grok, copilot",
    "--scope",
    "project",
  ]);
  assert.deepEqual(commas.platforms, ["grok", "copilot"]);

  const repeats = parseArgs([
    "node",
    "install.mjs",
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
    "install.mjs",
    "--platform=grok,codex",
    "--scope",
    "user",
  ]);
  assert.deepEqual(equals.platforms, ["grok", "codex"]);

  const mixed = parseArgs([
    "node",
    "install.mjs",
    "--platform",
    "grok",
    "--platform=codex,copilot",
    "--platform",
    "grok",
  ]);
  assert.deepEqual(mixed.platforms, ["grok", "codex", "copilot"]);

  assert.throws(
    () => parseArgs(["node", "install.mjs", "--platform=grok", "codex"]),
    /Unknown argument: codex/,
  );
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

  for (const plan of [grokUser, grokProject, codexUser, copilotProject]) {
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

function fetchAgent(argv) {
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

  for (const argv of [...grokUser.fetchCommands, ...grokProject.fetchCommands]) {
    assert.equal(fetchAgent(argv), "grok");
  }
  for (const argv of [
    ...codexUser.fetchCommands,
    ...copilotUser.fetchCommands,
    ...copilotProject.fetchCommands,
  ]) {
    assert.equal(fetchAgent(argv), "cline");
  }

  assert.match(describe(grokUser, { dryRun: true, skipDeps: false }), /--agent grok/);
  assert.match(describe(codexUser, { dryRun: true, skipDeps: false }), /--agent cline/);
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

test("describe(codex|copilot) names .agents/skills and does not use a .rhai payload", () => {
  for (const platform of SKILL_PLATFORMS) {
    const plan = planInstall({ platform, scope: "user" });
    const text = describe(plan, { dryRun: true, skipDeps: false });
    assert.match(text, new RegExp(`platform=${platform}`));
    assert.match(text, /\.agents[/\\]skills/);
    assert.match(text, /retemper/);
    assert.match(text, /orchestrate:/);
    assert.match(text, /grill-me/);
    assert.match(text, /grilling/);
    assert.match(text, /codex skill link:/);
    assert.doesNotMatch(text, /\.rhai/);
    assert.doesNotMatch(text, /\.github[/\\]skills/);
    assert.doesNotMatch(text, /\.copilot[/\\]skills/);
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
      "not-a-platform user /tmp/x",
      "grok nope /tmp/x",
    ].join("\n"),
  );
  assert.deepEqual(parsed[0], { platform: "grok", scope: "user", path: "/Users/you/.grok" });
  assert.deepEqual(parsed[1], { platform: "codex", scope: "project", path: "/tmp/my repo" });
  assert.equal(parsed[2].invalid, true);
  assert.equal(parsed[3].invalid, true);
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

test("CLI --update restores a deleted project payload from the tracking file", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-upd-"));
  withHome((home) => {
    try {
      const installed = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(installed.status, 0, installed.stderr);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
      rmSync(skillMd);
      assert.equal(existsSync(skillMd), false);

      const updated = cli(["--update", "--skip-deps"], { RETEMPER_HOME: home });
      assert.equal(updated.status, 0, updated.stderr);
      assert.match(updated.stdout, /platform=codex/);
      assert.equal(existsSync(skillMd), true);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), `codex project ${target}`);
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

test("CLI --platform grok,codex --scope user writes grok and skill dests under test homes", () => {
  const grok = mkdtempSync(join(tmpdir(), "retemper-user-grok-"));
  const agents = mkdtempSync(join(tmpdir(), "retemper-user-agents-"));
  const codex = mkdtempSync(join(tmpdir(), "retemper-user-codex-"));
  withHome((home) => {
    try {
      const result = cli(["--platform", "grok", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        GROK_HOME: grok,
        AGENTS_HOME: agents,
        CODEX_HOME: codex,
      });
      assert.equal(result.status, 0, result.stderr);
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
      ]);
    } finally {
      rmSync(grok, { recursive: true, force: true });
      rmSync(agents, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
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

test("CLI --platform codex copilot records two skill lines on the same dest tree", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-skills-"));
  withHome((home) => {
    try {
      const result = cli(
        ["--platform", "codex", "copilot", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.deepEqual(readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n"), [
        `codex project ${target}`,
        `copilot project ${target}`,
      ]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
