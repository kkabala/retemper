import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  codexHome,
  installsPath,
  planInstall,
} from "../install.ts";
import {
  buildGroups,
  describeRemoval,
  helpText as uninstallHelpText,
  matchedEntries,
  parseUninstallArgs,
  removalPaths,
  validateUninstallArgs,
} from "../uninstall.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installPath = join(root, "install.ts");
const uninstallPath = join(root, "uninstall.ts");
const dispatcherPath = join(root, "retemper.ts");

type CliEnv = Record<string, string>;

function cli(args: string[], env: CliEnv = {}, input?: string) {
  return spawnSync(process.execPath, [uninstallPath, ...args], {
    encoding: "utf8" as const,
    cwd: root,
    env: { ...process.env, ...env },
    ...(input !== undefined ? { input } : {}),
  });
}

function installCli(args: string[], env: CliEnv = {}) {
  return spawnSync(process.execPath, [installPath, ...args], {
    encoding: "utf8" as const,
    cwd: root,
    env: { ...process.env, ...env },
  });
}

function dispatchCli(args: string[], env: CliEnv = {}) {
  return spawnSync(process.execPath, [dispatcherPath, ...args], {
    encoding: "utf8" as const,
    cwd: root,
    env: { ...process.env, ...env },
  });
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "retemper-un-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("parseUninstallArgs defaults to --all and accepts the installer flag grammar", () => {
  const bare = parseUninstallArgs(["node", "uninstall.ts"]);
  assert.equal(bare.all, true);
  assert.equal(bare.allExplicit, false);
  assert.equal(bare.dryRun, false);
  assert.equal(bare.yes, false);
  assert.deepEqual(bare.platforms, []);

  const filtered = parseUninstallArgs([
    "node",
    "uninstall.ts",
    "--platform",
    "grok,codex",
    "--scope",
    "project",
    "--target",
    "/repo",
    "--dry-run",
    "--yes",
  ]);
  assert.equal(filtered.all, false);
  assert.deepEqual(filtered.platforms, ["grok", "codex"]);
  assert.equal(filtered.scope, "project");
  assert.equal(filtered.target, "/repo");
  assert.equal(filtered.dryRun, true);
  assert.equal(filtered.yes, true);

  const explicitAll = parseUninstallArgs(["node", "uninstall.ts", "--all", "-y"]);
  assert.equal(explicitAll.all, true);
  assert.equal(explicitAll.allExplicit, true);
  assert.equal(explicitAll.yes, true);

  const spaced = parseUninstallArgs(["node", "uninstall.ts", "--platform", "grok", "codex", "--scope", "user"]);
  assert.deepEqual(spaced.platforms, ["grok", "codex"]);

  const equals = parseUninstallArgs(["node", "uninstall.ts", "--platform=copilot,grok", "--scope", "user"]);
  assert.deepEqual(equals.platforms, ["copilot", "grok"]);

  assert.throws(() => parseUninstallArgs(["node", "uninstall.ts", "--bogus"]), /Unknown argument: --bogus/);
});

test("validateUninstallArgs rejects conflicting or unsafe filters", () => {
  validateUninstallArgs(parseUninstallArgs(["node", "uninstall.ts"]));

  assert.throws(
    () => validateUninstallArgs(parseUninstallArgs(["node", "uninstall.ts", "--all", "--platform", "grok"])),
    /not both/,
  );
  assert.throws(
    () => validateUninstallArgs(parseUninstallArgs(["node", "uninstall.ts", "--all", "--scope", "user"])),
    /not both/,
  );
  assert.throws(
    () => validateUninstallArgs(parseUninstallArgs(["node", "uninstall.ts", "--platform", "claude", "--scope", "user"])),
    /Unsupported platform "claude"/,
  );
  assert.throws(
    () => validateUninstallArgs(parseUninstallArgs(["node", "uninstall.ts", "--platform", "grok"])),
    /Unsupported scope/,
  );
  assert.throws(
    () => validateUninstallArgs(parseUninstallArgs(["node", "uninstall.ts", "--platform", "grok", "--scope", "project"])),
    /--target <dir> is required/,
  );
});

test("help explains --all default, the prompt gate, and what is kept", () => {
  const text = uninstallHelpText();
  assert.match(text, /--all/);
  assert.match(text, /Default when no filter is given/);
  assert.match(text, /--dry-run/);
  assert.match(text, /--yes/);
  assert.match(text, /--target <dir>/);
  assert.match(text, /installs\.txt/);
  assert.match(text, /CODING_STANDARDS\.md is never removed/);
  assert.match(text, /y or yes/);
  assert.match(text, /retemper\.ts uninstall/);
  assert.doesNotMatch(text, /--skip-deps/);
});

test("removalPaths lists every installed dest exactly once, deepest first, standards excluded", () => {
  for (const platform of ["grok", "codex", "copilot"] as const) {
    for (const scope of ["user", "project"] as const) {
      const target = "/does-not-exist/retemper-removal";
      const plan = planInstall({ platform, scope, ...(scope === "project" ? { target } : {}) });
      const paths = removalPaths(plan);

      assert.equal(new Set(paths).size, paths.length, `${platform}/${scope} duplicates`);
      for (let i = 1; i < paths.length; i += 1) {
        assert.ok(paths[i - 1].length >= paths[i].length, `${platform}/${scope} depth order`);
      }
      if (plan.workflowDest) assert.ok(paths.includes(plan.workflowDest));
      if (plan.skillDest) assert.ok(paths.includes(plan.skillDest));
      assert.ok(paths.includes(plan.orchestrateDest));
      assert.ok(paths.includes(plan.refsDest));
      for (const dest of plan.skillDests) assert.ok(paths.includes(dest));
      for (const link of plan.skillLinks) assert.ok(paths.includes(link.dest));
      if (scope === "project") {
        assert.equal(paths.includes(join(target, "CODING_STANDARDS.md")), false);
      }
    }
  }

  const codexUser = planInstall({ platform: "codex", scope: "user" });
  const codexSkills = join(codexHome(), "skills");
  const paths = removalPaths(codexUser);
  assert.deepEqual(
    [
      join(codexSkills, "grill-me"),
      join(codexSkills, "grilling"),
      join(codexSkills, "orchestrate"),
      join(codexSkills, "retemper"),
    ],
    paths.filter((path) => path.startsWith(codexSkills)).sort(),
  );

  const grokProject = planInstall({ platform: "grok", scope: "project", target: "/repo-x" });
  assert.deepEqual(removalPaths(grokProject), [
    join("/repo-x", ".grok", "workflows", "retemper.rhai"),
    join("/repo-x", ".grok", "retemper", "references"),
    join("/repo-x", ".grok", "skills", "orchestrate"),
    join("/repo-x", ".grok", "skills", "grill-me"),
    join("/repo-x", ".grok", "skills", "grilling"),
  ]);
});

test("describeRemoval marks present/missing paths, kept files, tracking drops, and dry-run", () => {
  const target = "/does-not-exist/retemper-describe";
  const groups = buildGroups(
    [],
    parseUninstallArgs(["node", "uninstall.ts", "--platform", "codex", "--scope", "project", "--target", target]),
  );
  const text = describeRemoval(groups, "/tmp/installs.txt", 2, { dryRun: true });

  assert.match(text, /planned removals/);
  assert.match(text, /codex project \(root: /);
  assert.match(text, /\[missing\] remove /);
  assert.match(text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /CODING_STANDARDS\.md is never removed/);
  assert.match(text, /2 record\(s\) will be dropped from \/tmp\/installs\.txt/);
  assert.match(text, /dry-run: no files removed, no prompt/);

  const noDryRun = describeRemoval(groups, "/tmp/installs.txt", 2, {});
  assert.doesNotMatch(noDryRun, /dry-run/);
});

test("matchedEntries matches user records per platform and project records by resolved path", () => {
  const opts = parseUninstallArgs([
    "node",
    "uninstall.ts",
    "--platform",
    "grok,codex",
    "--scope",
    "project",
    "--target",
    "/repo",
  ]);
  const groups = buildGroups([], opts);
  const entries = [
    { platform: "grok", scope: "project", path: "/repo" },
    { platform: "codex", scope: "project", path: "/repo/" },
    { platform: "copilot", scope: "project", path: "/repo" },
    { platform: "grok", scope: "user", path: "/home/.grok" },
    { invalid: true, raw: "junk line" },
  ];
  const matched = matchedEntries(entries, groups).map((entry) => `${entry.platform} ${entry.scope}`);
  assert.deepEqual(matched.sort(), ["codex project", "grok project"]);
});

test("CLI targeted uninstall removes the tree, prunes empty roots, and forgets the record", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-target-"));
  withHome((home) => {
    try {
      const setup = installCli(["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"], {
        RETEMPER_HOME: home,
      });
      assert.equal(setup.status, 0, setup.stderr);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
      assert.equal(existsSync(skillMd), true);

      const result = cli(["--platform", "codex", "--scope", "project", "--target", target, "--yes"], {
        RETEMPER_HOME: home,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /planned removals/);
      assert.match(result.stdout, /\[present\] remove /);
      assert.match(result.stdout, /uninstalled retemper/);
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);

      const again = cli(["--platform", "codex", "--scope", "project", "--target", target, "--yes"], {
        RETEMPER_HOME: home,
      });
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /\(no files found\)/);
      assert.match(again.stdout, /uninstalled retemper/);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI shows planned paths before the prompt and aborts unless accepted", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-gate-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");

      const declined = cli(
        ["--platform", "codex", "--scope", "project", "--target", target],
        { RETEMPER_HOME: home },
        "n\n",
      );
      assert.equal(declined.status, 0, declined.stderr);
      const skillDir = join(target, ".agents", "skills", "retemper");
      const listedAt = declined.stdout.indexOf(skillDir);
      const promptedAt = declined.stdout.indexOf("Proceed with removal?");
      assert.ok(listedAt >= 0 && promptedAt > listedAt);
      assert.match(declined.stdout, /Aborted\. Nothing was removed\./);
      assert.equal(existsSync(skillMd), true);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), `codex project ${target}`);

      const eof = cli(["--platform", "codex", "--scope", "project", "--target", target], { RETEMPER_HOME: home }, "");
      assert.equal(eof.status, 0, eof.stderr);
      assert.match(eof.stdout, /Aborted\. Nothing was removed\./);
      assert.equal(existsSync(skillMd), true);

      const accepted = cli(
        ["--platform", "codex", "--scope", "project", "--target", target],
        { RETEMPER_HOME: home },
        "y\n",
      );
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout, /Proceed with removal\? \[y\/N\] /);
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --dry-run lists everything and removes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-dry-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const skillMd = join(target, ".agents", "skills", "retemper", "SKILL.md");
      const before = readFileSync(join(home, "installs.txt"), "utf8");

      const result = cli(["--platform", "codex", "--scope", "project", "--target", target, "--dry-run"], {
        RETEMPER_HOME: home,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[present\] remove /);
      assert.match(result.stdout, /dry-run: no files removed, no prompt/);
      assert.doesNotMatch(result.stdout, /Proceed with removal/);
      assert.equal(existsSync(skillMd), true);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8"), before);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI default --all clears every recorded install and deletes the tracking file", () => {
  const grok = mkdtempSync(join(tmpdir(), "retemper-un-all-grok-"));
  const target = mkdtempSync(join(tmpdir(), "retemper-un-all-repo-"));
  withHome((home) => {
    try {
      const env: CliEnv = { RETEMPER_HOME: home, GROK_HOME: grok };
      for (const args of [
        ["--platform", "grok", "--scope", "user", "--skip-deps"],
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
      ]) {
        const setup = installCli(args, env);
        assert.equal(setup.status, 0, setup.stderr);
      }

      const result = cli(["--yes"], env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /grok user/);
      assert.match(result.stdout, /codex project/);
      assert.match(result.stdout, /2 record\(s\) will be dropped/);
      assert.equal(existsSync(join(grok, "workflows", "retemper.rhai")), false);
      assert.equal(existsSync(join(grok, "retemper")), false);
      for (const name of ["grill-me", "grilling", "orchestrate"]) {
        assert.equal(existsSync(join(grok, "skills", name)), false, name);
      }
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(grok, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI targeted uninstall leaves other platforms and their records intact", () => {
  const grok = mkdtempSync(join(tmpdir(), "retemper-un-keep-grok-"));
  const target = mkdtempSync(join(tmpdir(), "retemper-un-keep-repo-"));
  withHome((home) => {
    try {
      const env: CliEnv = { RETEMPER_HOME: home, GROK_HOME: grok };
      for (const args of [
        ["--platform", "grok", "--scope", "user", "--skip-deps"],
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
      ]) {
        const setup = installCli(args, env);
        assert.equal(setup.status, 0, setup.stderr);
      }

      const result = cli(["--platform", "grok", "--scope", "user", "--yes"], env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(grok, "workflows", "retemper.rhai")), false);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.deepEqual(readFileSync(join(home, "installs.txt"), "utf8").trim().split("\n"), [
        `codex project ${target}`,
      ]);
    } finally {
      rmSync(grok, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI user-scope uninstall removes the $CODEX_HOME/skills symlinks", () => {
  const agents = mkdtempSync(join(tmpdir(), "retemper-un-agents-"));
  const codex = mkdtempSync(join(tmpdir(), "retemper-un-codex-"));
  withHome((home) => {
    try {
      const env: CliEnv = { RETEMPER_HOME: home, AGENTS_HOME: agents, CODEX_HOME: codex };
      const setup = installCli(["--platform", "codex", "--scope", "user", "--skip-deps"], env);
      assert.equal(setup.status, 0, setup.stderr);
      for (const name of ["retemper", "orchestrate", "grill-me", "grilling"]) {
        assert.equal(lstatSync(join(codex, "skills", name)).isSymbolicLink(), true, name);
      }

      const result = cli(["--platform", "codex", "--scope", "user", "--yes"], env);
      assert.equal(result.status, 0, result.stderr);
      for (const name of ["retemper", "orchestrate", "grill-me", "grilling"]) {
        assert.equal(existsSync(join(codex, "skills", name)), false, name);
      }
      assert.equal(existsSync(join(agents, "skills", "retemper")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(agents, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
    }
  });
});

test("CLI uninstall never touches CODING_STANDARDS.md", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-std-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps", "--standards"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const standards = join(target, "CODING_STANDARDS.md");
      assert.equal(existsSync(standards), true);

      const result = cli(["--platform", "codex", "--scope", "project", "--target", target, "--yes"], {
        RETEMPER_HOME: home,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(standards), true);
      assert.match(readFileSync(standards, "utf8"), /Living document/);
      assert.equal(existsSync(join(target, ".agents")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI --all without a tracking file reports nothing to uninstall", () => {
  withHome((home) => {
    const result = cli(["--yes"], { RETEMPER_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(no files found\)/);
    assert.match(result.stdout, /Nothing to uninstall\./);
    assert.equal(existsSync(join(home, "installs.txt")), false);
  });
});

test("CLI keeps malformed tracking lines when uninstalling recorded installs", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-malformed-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      writeFileSync(join(home, "installs.txt"), `codex project ${target}\nnot-a-line\n`);

      const result = cli(["--yes"], { RETEMPER_HOME: home });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), "not-a-line");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("CLI targeted uninstall with an unknown platform fails loudly and removes nothing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-badplat-"));
  withHome((home) => {
    try {
      const result = cli(["--platform", "claude", "--scope", "project", "--target", target, "--yes"], {
        RETEMPER_HOME: home,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsupported platform "claude"/);
      assert.equal(existsSync(join(target, ".grok")), false);
      assert.equal(existsSync(join(target, ".agents")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("dispatcher routes verbs to the right help and fails on unknown commands", () => {
  const bare = dispatchCli([]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /retemper\.ts install/);
  assert.match(bare.stdout, /uninstall/);
  assert.match(bare.stdout, /update/);

  const installHelp = dispatchCli(["install", "--help"]);
  assert.equal(installHelp.status, 0, installHelp.stderr);
  assert.match(installHelp.stdout, /retemper installer/);
  assert.match(installHelp.stdout, /--skip-deps/);

  const uninstallHelp = dispatchCli(["uninstall", "--help"]);
  assert.equal(uninstallHelp.status, 0, uninstallHelp.stderr);
  assert.match(uninstallHelp.stdout, /retemper uninstaller/);
  assert.match(uninstallHelp.stdout, /--all/);

  const bogus = dispatchCli(["bogus"]);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /Unknown command: bogus/);

  withHome((home) => {
    const update = dispatchCli(["update"], { RETEMPER_HOME: home });
    assert.equal(update.status, 1);
    assert.match(update.stderr, /installs\.txt/);
  });
});
