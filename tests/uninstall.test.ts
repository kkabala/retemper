import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  codexHome,
  installsPath,
  main as installMain,
  planInstall,
} from "../install.ts";
import {
  helpText as uninstallHelpText,
  matchedEntries,
  parseUninstallArgs,
  removalPaths,
  validateUninstallArgs,
} from "../uninstall.ts";
import {
  manifestExpectationPath,
  manifestPath,
  readInstallManifest,
  writeInstallManifest,
} from "../lib/install-manifest.ts";
import {
  beginOwnershipTransaction,
  ownershipTransactionPath,
  rotateStateGeneration,
} from "../lib/install-state.ts";

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

function interactiveCli(args: string[], env: CliEnv = {}) {
  const child = spawn(process.execPath, [uninstallPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let promptSettled = false;
  let promptTimer: ReturnType<typeof setTimeout>;
  const prompt = new Promise<void>((resolvePrompt, rejectPrompt) => {
    promptTimer = setTimeout(() => {
      if (!promptSettled) rejectPrompt(new Error(`Timed out waiting for uninstall prompt. stdout=${stdout} stderr=${stderr}`));
    }, 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (!promptSettled && stdout.includes("Proceed with removal?")) {
        promptSettled = true;
        clearTimeout(promptTimer);
        resolvePrompt();
      }
    });
    child.once("close", (code) => {
      if (!promptSettled) {
        promptSettled = true;
        clearTimeout(promptTimer);
        rejectPrompt(new Error(`Uninstall exited before prompting (${code}). stdout=${stdout} stderr=${stderr}`));
      }
    });
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const completed = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveResult) => {
    child.once("close", (status) => resolveResult({ status, stdout, stderr }));
  });
  return { child, prompt, completed };
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

test("acceptance: an explicit empty filter fails closed instead of uninstalling everything", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-empty-filter-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);

      const result = cli(["--platform", "--yes"], { RETEMPER_HOME: home });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--platform requires a value/);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.equal(existsSync(join(home, "installs.txt")), true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("parseUninstallArgs validates option values and supports equals forms", () => {
  const parsed = parseUninstallArgs([
    "node",
    "uninstall.ts",
    "--platform=codex,cursor",
    "--scope=project",
    "--target=--dash-prefixed-project",
    "--dry-run",
  ]);
  assert.deepEqual(parsed.platforms, ["codex", "cursor"]);
  assert.equal(parsed.scope, "project");
  assert.equal(parsed.target, "--dash-prefixed-project");
  assert.equal(parsed.dryRun, true);

  for (const args of [
    ["--platform"],
    ["--platform="],
    ["--platform", "--dry-run"],
    ["--scope"],
    ["--scope="],
    ["--scope", "--dry-run"],
    ["--target"],
    ["--target="],
    ["--target", "--dry-run"],
  ]) {
    assert.throws(
      () => parseUninstallArgs(["node", "uninstall.ts", ...args]),
      /--(?:platform|scope|target) requires a value/,
      args.join(" "),
    );
  }
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

test("acceptance: uninstall help and validation list every supported platform", () => {
  const help = cli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  for (const platform of ["grok", "codex", "copilot", "cursor"]) {
    assert.match(help.stdout, new RegExp(platform));
  }

  const invalid = cli(["--platform", "unknown", "--scope", "user", "--yes"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /grok, codex, copilot, or cursor/);
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
  const groups = opts.platforms.map((platform) => ({
    record: { platform, scope: opts.scope, path: opts.target },
  }));
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
      assert.match(again.stdout, /Nothing to uninstall/);
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
      const generationPath = join(home, "state.generation");
      const generationBeforeDecline = readFileSync(generationPath, "utf8");

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
      assert.equal(readFileSync(generationPath, "utf8"), generationBeforeDecline);
      assert.equal(existsSync(join(home, "state.lock")), false);

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

test("acceptance: an uninstall prompt becomes stale when the same record is reinstalled", async () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-stale-prompt-"));
  const home = mkdtempSync(join(tmpdir(), "retemper-un-stale-state-"));
  try {
    const args = ["--platform", "cursor", "--scope", "project", "--target", target];
    const setup = installCli([...args, "--skip-deps"], { RETEMPER_HOME: home });
    assert.equal(setup.status, 0, setup.stderr);
    const pending = interactiveCli(args, { RETEMPER_HOME: home });
    await pending.prompt;

    const reinstall = installCli([...args, "--skip-deps"], { RETEMPER_HOME: home });
    assert.equal(reinstall.status, 0, reinstall.stderr);
    pending.child.stdin.end("yes\n");
    const stale = await pending.completed;

    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /state.*changed|stale.*plan|generation/i);
    assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
    assert.match(readFileSync(join(home, "installs.txt"), "utf8"), /^cursor project /m);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("acceptance: a live state lock fails closed before a multi-platform install writes", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-install-lock-project-"));
  const home = mkdtempSync(join(tmpdir(), "retemper-install-lock-state-"));
  mkdirSync(join(home, "state.lock"));
  try {
    const result = installCli(
      ["--platform", "codex,cursor", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /state lock|another retemper operation|contention/i);
    assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), false);
    assert.equal(existsSync(join(home, "installs.txt")), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("acceptance: malformed state generation fails closed before install writes", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-install-bad-generation-project-"));
  const home = mkdtempSync(join(tmpdir(), "retemper-install-bad-generation-state-"));
  writeFileSync(join(home, "state.generation"), "not-a-generation\n");
  try {
    const result = installCli(
      ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid.*state generation|concurrent state changes/i);
    assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), false);
    assert.equal(existsSync(join(home, "installs.txt")), false);
    assert.equal(existsSync(join(home, "state.lock")), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("acceptance: uninstall dry-run releases the lock without rotating state generation", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-dry-generation-project-"));
  const home = mkdtempSync(join(tmpdir(), "retemper-un-dry-generation-state-"));
  try {
    const setup = installCli(
      ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const generationPath = join(home, "state.generation");
    const before = readFileSync(generationPath, "utf8");

    const result = cli(["--all", "--dry-run"], { RETEMPER_HOME: home });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(generationPath, "utf8"), before);
    assert.equal(existsSync(join(home, "state.lock")), false);
    assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
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

test("acceptance: shared skill files remain until the last platform owner is uninstalled", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-shared-owners-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex,copilot,cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const skill = join(target, ".agents", "skills", "retemper", "SKILL.md");

      for (const [platform, remaining] of [
        ["codex", ["copilot", "cursor"]],
        ["cursor", ["copilot"]],
      ] as const) {
        const result = cli(
          ["--platform", platform, "--scope", "project", "--target", target, "--yes"],
          { RETEMPER_HOME: home },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(existsSync(skill), true, `${platform} removed a shared skill`);
        const tracking = readFileSync(join(home, "installs.txt"), "utf8");
        for (const owner of remaining) assert.match(tracking, new RegExp(`^${owner} project `, "m"));
        assert.doesNotMatch(tracking, new RegExp(`^${platform} project `, "m"));
      }

      const last = cli(
        ["--platform", "copilot", "--scope", "project", "--target", target, "--yes"],
        { RETEMPER_HOME: home },
      );
      assert.equal(last.status, 0, last.stderr);
      assert.equal(existsSync(skill), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: empty directories referenced by an unmatched owner are retained", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-shared-empty-dirs-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex,cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const cursorRecord = { platform: "cursor", scope: "project", path: target } as const;
      const cursorManifest = readInstallManifest(home, cursorRecord);
      assert.ok(cursorManifest);
      for (const entry of cursorManifest.entries) {
        unlinkSync(join(cursorManifest.roots[entry.root].path, entry.relativePath));
      }

      const result = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--yes"],
        { RETEMPER_HOME: home },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper")), true);
      assert.match(readFileSync(join(home, "installs.txt"), "utf8"), /^cursor project /m);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: a later shared install refreshes older owners before last-owner removal", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-shared-refresh-"));
  withHome((home) => {
    try {
      const codex = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(codex.status, 0, codex.stderr);
      const codexRecord = { platform: "codex", scope: "project", path: target } as const;
      const oldSnapshot = readInstallManifest(home, codexRecord);
      assert.ok(oldSnapshot);
      oldSnapshot.entries = oldSnapshot.entries.map((entry) =>
        entry.kind === "file" ? { ...entry, sha256: "0".repeat(64) } : entry
      );
      writeInstallManifest(home, oldSnapshot);

      const cursor = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(cursor.status, 0, cursor.stderr);

      for (const platform of ["cursor", "codex"]) {
        const result = cli(
          ["--platform", platform, "--scope", "project", "--target", target, "--yes"],
          { RETEMPER_HOME: home },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: a newer shared install adds new files to older owner manifests", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-shared-new-entry-"));
  withHome((home) => {
    try {
      const codex = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(codex.status, 0, codex.stderr);
      const codexRecord = { platform: "codex", scope: "project", path: target } as const;
      const oldSnapshot = readInstallManifest(home, codexRecord);
      assert.ok(oldSnapshot);
      const introducedFile = join(".agents", "skills", "orchestrate", "references", "orchestrator.md");
      const introducedDirectory = dirname(introducedFile);
      oldSnapshot.entries = oldSnapshot.entries.filter((entry) => entry.relativePath !== introducedFile);
      oldSnapshot.directories = oldSnapshot.directories.filter(
        (directory) => directory.relativePath !== introducedDirectory,
      );
      writeInstallManifest(home, oldSnapshot);

      const cursor = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(cursor.status, 0, cursor.stderr);
      const removeCursor = cli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--yes"],
        { RETEMPER_HOME: home },
      );

      assert.equal(removeCursor.status, 0, removeCursor.stderr);
      assert.equal(existsSync(join(target, introducedFile)), true);
      const refreshedCodex = readInstallManifest(home, codexRecord);
      assert.ok(refreshedCodex);
      assert.equal(refreshedCodex.entries.some((entry) => entry.relativePath === introducedFile), true);
      assert.equal(
        refreshedCodex.directories.some((directory) => directory.relativePath === introducedDirectory),
        true,
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: a partial peer-manifest update blocks uninstall until the same update repairs it", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-dirty-ownership-"));
  const home = mkdtempSync(join(tmpdir(), "retemper-un-dirty-state-"));
  const codexRecord = { platform: "codex", scope: "project", path: target } as const;
  const cursorRecord = { platform: "cursor", scope: "project", path: target } as const;
  const introducedFile = join(".agents", "skills", "orchestrate", "references", "orchestrator.md");
  const markerPath = join(home, "ownership-transaction.json");
  const peerTemporary = `${manifestPath(home, cursorRecord)}.${process.pid}.tmp`;
  const previousHome = process.env.RETEMPER_HOME;
  try {
    const setup = installCli(
      ["--platform", "codex,cursor", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );
    assert.equal(setup.status, 0, setup.stderr);
    const staleCursor = readInstallManifest(home, cursorRecord);
    assert.ok(staleCursor);
    staleCursor.entries = staleCursor.entries.filter((entry) => entry.relativePath !== introducedFile);
    staleCursor.directories = staleCursor.directories.filter(
      (directory) => directory.relativePath !== dirname(introducedFile),
    );
    writeInstallManifest(home, staleCursor);
    mkdirSync(peerTemporary);
    process.env.RETEMPER_HOME = home;

    const failedUpdate = installMain(["node", "install.ts", "--update", "--skip-deps"]);

    assert.equal(failedUpdate, 1);
    assert.equal(existsSync(markerPath), true);
    rmSync(peerTemporary, { recursive: true });
    const unrelated = installCli(
      ["--platform", "grok", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );
    assert.notEqual(unrelated.status, 0);
    assert.match(unrelated.stderr, /unfinished.*ownership|rerunning the same.*update/i);
    assert.equal(existsSync(join(target, ".grok")), false);
    assert.equal(existsSync(markerPath), true);
    const refused = cli(
      ["--platform", "codex", "--scope", "project", "--target", target, "--yes"],
      { RETEMPER_HOME: home },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /unfinished.*ownership|dirty.*state|rerun.*update/i);
    assert.equal(existsSync(join(target, introducedFile)), true);

    const repaired = installMain(["node", "install.ts", "--update", "--skip-deps"]);
    assert.equal(repaired, 0);
    assert.equal(existsSync(markerPath), false);
    const refreshedCursor = readInstallManifest(home, cursorRecord);
    assert.ok(refreshedCursor);
    assert.equal(refreshedCursor.entries.some((entry) => entry.relativePath === introducedFile), true);

    const safe = cli(
      ["--platform", "codex", "--scope", "project", "--target", target, "--yes"],
      { RETEMPER_HOME: home },
    );
    assert.equal(safe.status, 0, safe.stderr);
    assert.equal(existsSync(join(target, introducedFile)), true);
    assert.ok(readInstallManifest(home, cursorRecord));
    assert.equal(readInstallManifest(home, codexRecord), null);
  } finally {
    if (previousHome === undefined) delete process.env.RETEMPER_HOME;
    else process.env.RETEMPER_HOME = previousHome;
    rmSync(peerTemporary, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("acceptance: update recovers a mixed transaction already committed to tracking", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-update-post-tracking-"));
  const target = join(holder, "live-project");
  const missing = join(holder, "missing-project");
  const home = join(holder, "state");
  mkdirSync(target);
  const live = { platform: "cursor", scope: "project", path: target } as const;
  const gone = { platform: "codex", scope: "project", path: missing } as const;
  const modified = join(target, ".agents", "skills", "retemper", "SKILL.md");
  try {
    const setup = installCli(
      ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );
    assert.equal(setup.status, 0, setup.stderr);
    writeFileSync(join(home, "installs.txt"), `cursor project ${target}\ncodex project ${missing}\n`);
    beginOwnershipTransaction(home, {
      kind: "update",
      records: [live, gone],
      trackingBefore: `cursor project ${target}\ncodex project ${missing}\n`,
      trackingAfter: `cursor project ${target}\n`,
    });
    writeFileSync(join(home, "installs.txt"), `cursor project ${target}\n`);
    writeFileSync(modified, "keep post-commit edit\n");

    const recovered = installCli(["--update", "--skip-deps"], { RETEMPER_HOME: home });

    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(ownershipTransactionPath(home)), false);
    assert.equal(readFileSync(modified, "utf8"), "keep post-commit edit\n");
    const uninstall = cli(["--all", "--yes"], { RETEMPER_HOME: home });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(readFileSync(modified, "utf8"), "keep post-commit edit\n");
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("acceptance: update recovers an all-missing transaction after tracking commit", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-update-post-delete-"));
  const home = join(holder, "state");
  const first = { platform: "codex", scope: "project", path: join(holder, "missing-one") } as const;
  const second = { platform: "cursor", scope: "project", path: join(holder, "missing-two") } as const;
  mkdirSync(home);
  try {
    writeFileSync(join(home, "installs.txt"), `${first.platform} project ${first.path}\n${second.platform} project ${second.path}\n`);
    rotateStateGeneration(home);
    const trackingBefore = `${first.platform} project ${first.path}\n${second.platform} project ${second.path}\n`;
    beginOwnershipTransaction(home, {
      kind: "update",
      records: [first, second],
      trackingBefore,
      trackingAfter: "",
    });
    writeFileSync(join(home, "installs.txt"), "");

    const recovered = installCli(["--update"], { RETEMPER_HOME: home });

    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(existsSync(ownershipTransactionPath(home)), false);
    assert.equal(readFileSync(join(home, "installs.txt"), "utf8"), "");
    const uninstall = cli(["--all", "--yes"], { RETEMPER_HOME: home });
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.match(uninstall.stdout, /Nothing to uninstall/);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("acceptance: Grok ownership is never inferred from a shared project root", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-grok-not-shared-"));
  withHome((home) => {
    try {
      const env = { RETEMPER_HOME: home };
      const grok = installCli(
        ["--platform", "grok", "--scope", "project", "--target", target, "--skip-deps"],
        env,
      );
      assert.equal(grok.status, 0, grok.stderr);
      const grokRecord = { platform: "grok", scope: "project", path: target } as const;
      const before = readInstallManifest(home, grokRecord);
      assert.ok(before);

      const cursor = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        env,
      );
      assert.equal(cursor.status, 0, cursor.stderr);
      const after = readInstallManifest(home, grokRecord);
      assert.deepEqual(after, before);

      const removeCursor = cli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--yes"],
        env,
      );
      assert.equal(removeCursor.status, 0, removeCursor.stderr);
      assert.equal(existsSync(join(target, ".agents")), false);
      assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: Codex compatibility roots are excluded from shared owner refresh", () => {
  const agents = mkdtempSync(join(tmpdir(), "retemper-un-shared-primary-"));
  const codexHomePath = mkdtempSync(join(tmpdir(), "retemper-un-shared-codex-"));
  withHome((home) => {
    try {
      const env = { RETEMPER_HOME: home, AGENTS_HOME: agents, CODEX_HOME: codexHomePath };
      const copilot = installCli(["--platform", "copilot", "--scope", "user", "--skip-deps"], env);
      assert.equal(copilot.status, 0, copilot.stderr);
      const codex = installCli(["--platform", "codex", "--scope", "user", "--skip-deps"], env);
      assert.equal(codex.status, 0, codex.stderr);

      const copilotRecord = { platform: "copilot", scope: "user", path: agents } as const;
      const refreshed = readInstallManifest(home, copilotRecord);
      assert.ok(refreshed);
      assert.equal(refreshed.roots.length, 1);
      assert.equal(refreshed.entries.every((entry) => entry.root === 0), true);

      const removeCodex = cli(["--platform", "codex", "--scope", "user", "--yes"], env);
      assert.equal(removeCodex.status, 0, removeCodex.stderr);
      assert.equal(existsSync(join(codexHomePath, "skills", "retemper")), false);
      assert.equal(existsSync(join(agents, "skills", "retemper", "SKILL.md")), true);
    } finally {
      rmSync(agents, { recursive: true, force: true });
      rmSync(codexHomePath, { recursive: true, force: true });
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

test("acceptance: recorded user destinations are removed after current homes change", () => {
  const installedAgents = mkdtempSync(join(tmpdir(), "retemper-un-recorded-agents-"));
  const installedCodex = mkdtempSync(join(tmpdir(), "retemper-un-recorded-codex-"));
  const currentAgents = mkdtempSync(join(tmpdir(), "retemper-un-current-agents-"));
  const currentCodex = mkdtempSync(join(tmpdir(), "retemper-un-current-codex-"));
  withHome((home) => {
    try {
      const setup = installCli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: installedAgents,
        CODEX_HOME: installedCodex,
      });
      assert.equal(setup.status, 0, setup.stderr);

      const result = cli(["--all", "--yes"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: currentAgents,
        CODEX_HOME: currentCodex,
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(installedAgents, "skills", "retemper", "SKILL.md")), false);
      assert.equal(existsSync(join(installedCodex, "skills", "retemper")), false);
      assert.equal(existsSync(join(currentAgents, "skills")), false);
      assert.equal(existsSync(join(currentCodex, "skills")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      for (const path of [installedAgents, installedCodex, currentAgents, currentCodex]) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });
});

test("acceptance: legacy user records fail closed when current homes differ", () => {
  const installedAgents = mkdtempSync(join(tmpdir(), "retemper-un-legacy-agents-"));
  const installedCodex = mkdtempSync(join(tmpdir(), "retemper-un-legacy-codex-"));
  const currentAgents = mkdtempSync(join(tmpdir(), "retemper-un-legacy-current-agents-"));
  const currentCodex = mkdtempSync(join(tmpdir(), "retemper-un-legacy-current-codex-"));
  withHome((home) => {
    try {
      const setup = installCli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: installedAgents,
        CODEX_HOME: installedCodex,
      });
      assert.equal(setup.status, 0, setup.stderr);
      rmSync(join(home, "manifests"), { recursive: true, force: true });
      rmSync(join(home, "manifest-expectations"), { recursive: true, force: true });

      const result = cli(["--all", "--yes"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: currentAgents,
        CODEX_HOME: currentCodex,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /legacy.*current homes differ|reinstall.*migrate/i);
      assert.equal(existsSync(join(installedAgents, "skills", "retemper", "SKILL.md")), true);
      assert.equal(existsSync(join(home, "installs.txt")), true);
    } finally {
      for (const path of [installedAgents, installedCodex, currentAgents, currentCodex]) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });
});

test("acceptance: legacy Codex user records require migration before compatibility-link removal", () => {
  const createdAgents = mkdtempSync(join(tmpdir(), "retemper-un-legacy-codex-agents-"));
  const createdInstalledCodex = mkdtempSync(join(tmpdir(), "retemper-un-legacy-codex-original-"));
  const createdCurrentCodex = mkdtempSync(join(tmpdir(), "retemper-un-legacy-codex-current-"));
  const agents = realpathSync(createdAgents);
  const installedCodex = realpathSync(createdInstalledCodex);
  const currentCodex = realpathSync(createdCurrentCodex);
  withHome((home) => {
    try {
      const setup = installCli(["--platform", "codex", "--scope", "user", "--skip-deps"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: agents,
        CODEX_HOME: installedCodex,
      });
      assert.equal(setup.status, 0, setup.stderr);
      rmSync(join(home, "manifests"), { recursive: true, force: true });
      rmSync(join(home, "manifest-expectations"), { recursive: true, force: true });
      mkdirSync(join(currentCodex, "skills"), { recursive: true });
      for (const name of ["retemper", "orchestrate", "grill-me", "grilling"]) {
        symlinkSync(join(agents, "skills", name), join(currentCodex, "skills", name));
      }

      const result = cli(["--all", "--yes"], {
        RETEMPER_HOME: home,
        AGENTS_HOME: agents,
        CODEX_HOME: currentCodex,
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /legacy.*Codex.*not recorded|reinstall.*migrate/i);
      assert.equal(lstatSync(join(currentCodex, "skills", "retemper")).isSymbolicLink(), true);
      assert.equal(existsSync(join(agents, "skills", "retemper", "SKILL.md")), true);
      assert.equal(existsSync(join(home, "installs.txt")), true);
    } finally {
      for (const path of [createdAgents, createdInstalledCodex, createdCurrentCodex]) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  });
});

test("acceptance: a safe legacy project record removes only matching packaged files", () => {
  const createdTarget = mkdtempSync(join(tmpdir(), "retemper-un-safe-legacy-"));
  const target = realpathSync(createdTarget);
  withHome((home) => {
    try {
      const custom = join(target, ".agents", "skills", "retemper", "custom.txt");
      const setup = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      writeFileSync(custom, "legacy custom\n");
      rmSync(join(home, "manifests"), { recursive: true, force: true });
      rmSync(join(home, "manifest-expectations"), { recursive: true, force: true });

      const result = cli(["--all", "--yes"], { RETEMPER_HOME: home });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), false);
      assert.equal(readFileSync(custom, "utf8"), "legacy custom\n");
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(createdTarget, { recursive: true, force: true });
    }
  });
});

test("acceptance: mixed legacy and v2 owners keep their shared payload coherent", () => {
  const createdTarget = mkdtempSync(join(tmpdir(), "retemper-un-mixed-owner-"));
  const target = realpathSync(createdTarget);
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex,cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const cursor = { platform: "cursor", scope: "project", path: target } as const;
      rmSync(manifestPath(home, cursor), { force: true });
      rmSync(manifestExpectationPath(home, cursor), { force: true });

      const first = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--yes"],
        { RETEMPER_HOME: home },
      );
      assert.equal(first.status, 0, first.stderr);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.match(readFileSync(join(home, "installs.txt"), "utf8"), /^cursor project /m);

      const last = cli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--yes"],
        { RETEMPER_HOME: home },
      );
      assert.equal(last.status, 0, last.stderr);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(createdTarget, { recursive: true, force: true });
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

test("acceptance: uninstall preserves unowned children and modified installed files", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-owned-files-"));
  withHome((home) => {
    try {
      const custom = join(target, ".agents", "skills", "grill-me", "custom-user-file.txt");
      const modified = join(target, ".agents", "skills", "retemper", "SKILL.md");
      mkdirSync(dirname(custom), { recursive: true });
      writeFileSync(custom, "keep me\n");
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      writeFileSync(modified, "user modified\n");

      const result = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--yes"],
        { RETEMPER_HOME: home },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[modified\] keep/);
      assert.equal(readFileSync(custom, "utf8"), "keep me\n");
      assert.equal(readFileSync(modified, "utf8"), "user modified\n");
      assert.equal(existsSync(join(target, ".agents", "skills", "orchestrate", "SKILL.md")), false);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: already-missing owned directories are treated as missing", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-missing-payload-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      rmSync(join(target, ".agents"), { recursive: true, force: true });

      const result = cli(["--all", "--yes"], { RETEMPER_HOME: home });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\[missing\]/);
      assert.equal(existsSync(join(home, "installs.txt")), false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: filesystem inspection errors abort before tracking changes", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-permission-"));
  const agents = join(target, ".agents");
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      chmodSync(agents, 0o000);

      const result = cli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--yes"],
        { RETEMPER_HOME: home },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /EACCES|permission denied/i);
      assert.equal(existsSync(join(home, "installs.txt")), true);
      chmodSync(agents, 0o700);
      assert.equal(existsSync(join(agents, "skills", "retemper", "SKILL.md")), true);
    } finally {
      try {
        chmodSync(agents, 0o700);
      } catch {
        // The directory may already have been removed by a future correct implementation.
      }
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: uninstall rejects a retargeted recorded project root", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-un-root-link-"));
  const installedRoot = join(holder, "installed-root");
  const unrelatedRoot = join(holder, "unrelated-root");
  const target = join(holder, "project-link");
  mkdirSync(installedRoot);
  mkdirSync(join(unrelatedRoot, ".agents", "skills", "retemper"), { recursive: true });
  const unrelated = join(unrelatedRoot, ".agents", "skills", "retemper", "unrelated.txt");
  writeFileSync(unrelated, "keep\n");
  symlinkSync(installedRoot, target);
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "codex", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      unlinkSync(target);
      symlinkSync(unrelatedRoot, target);

      const result = cli(["--all", "--yes"], { RETEMPER_HOME: home });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /physical identity|retargeted/i);
      assert.equal(existsSync(join(installedRoot, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.equal(readFileSync(unrelated, "utf8"), "keep\n");
      assert.equal(existsSync(join(home, "installs.txt")), true);
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  });
});

test("acceptance: uninstall rejects a retargeted intermediate directory", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-un-inner-link-"));
  const target = join(holder, "project");
  const installedAgents = join(target, "installed-agents");
  const unrelatedAgents = join(holder, "unrelated-agents");
  mkdirSync(target);
  mkdirSync(installedAgents);
  mkdirSync(join(unrelatedAgents, "skills", "retemper"), { recursive: true });
  const unrelated = join(unrelatedAgents, "skills", "retemper", "unrelated.txt");
  writeFileSync(unrelated, "keep\n");
  symlinkSync(installedAgents, join(target, ".agents"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      unlinkSync(join(target, ".agents"));
      symlinkSync(unrelatedAgents, join(target, ".agents"));

      const result = cli(["--all", "--yes"], { RETEMPER_HOME: home });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /physical identity|retargeted/i);
      assert.equal(existsSync(join(installedAgents, "skills", "retemper", "SKILL.md")), true);
      assert.equal(readFileSync(unrelated, "utf8"), "keep\n");
      assert.equal(existsSync(join(home, "installs.txt")), true);
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  });
});

test("acceptance: install rejects a destination ancestor that escapes the project root", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-install-escaped-ancestor-"));
  const target = join(holder, "project");
  const externalAgents = join(holder, "external-agents");
  const home = join(holder, "state");
  mkdirSync(target);
  mkdirSync(externalAgents);
  symlinkSync(externalAgents, join(target, ".agents"));
  try {
    const result = installCli(
      ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside.*physical.*root|escapes.*target/i);
    assert.equal(existsSync(join(externalAgents, "skills", "retemper", "SKILL.md")), false);
    assert.equal(existsSync(join(home, "installs.txt")), false);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
});

test("acceptance: malformed persisted ownership metadata fails closed", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-bad-manifest-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const manifestDir = join(home, "manifests");
      const manifests = readdirSync(manifestDir);
      assert.equal(manifests.length, 1);
      writeFileSync(join(manifestDir, manifests[0]), "{not valid json\n");

      const result = cli(["--all", "--yes"], { RETEMPER_HOME: home });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid.*manifest|ownership metadata/i);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.equal(existsSync(join(home, "installs.txt")), true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: tracking that expects a missing manifest fails closed", () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-missing-manifest-"));
  withHome((home) => {
    try {
      const setup = installCli(
        ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
        { RETEMPER_HOME: home },
      );
      assert.equal(setup.status, 0, setup.stderr);
      const record = { platform: "cursor", scope: "project", path: target } as const;
      rmSync(manifestPath(home, record), { force: true });

      const result = cli(["--all", "--yes"], { RETEMPER_HOME: home });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /manifest mismatch|ownership metadata is missing/i);
      assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), true);
      assert.equal(existsSync(join(home, "installs.txt")), true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

test("acceptance: a tracking write failure retains metadata for a safe direct retry", async () => {
  const target = mkdtempSync(join(tmpdir(), "retemper-un-retry-safe-"));
  const home = mkdtempSync(join(tmpdir(), "retemper-un-retry-home-"));
  const record = { platform: "cursor", scope: "project", path: target } as const;
  const modified = join(target, ".agents", "skills", "retemper", "SKILL.md");
  let blocker = "";
  try {
    const setup = installCli(
      ["--platform", "cursor", "--scope", "project", "--target", target, "--skip-deps"],
      { RETEMPER_HOME: home },
    );
    assert.equal(setup.status, 0, setup.stderr);
    writeFileSync(modified, "keep my edit\n");
    writeFileSync(join(home, "installs.txt"), `cursor project ${target}\nnot-a-line\n`);
    const pending = interactiveCli(["--all"], { RETEMPER_HOME: home });
    await pending.prompt;
    assert.ok(pending.child.pid);
    blocker = `${join(home, "installs.txt")}.${pending.child.pid}.tmp`;
    mkdirSync(blocker);
    pending.child.stdin.end("yes\n");

    const interrupted = await pending.completed;

    assert.notEqual(interrupted.status, 0);
    assert.match(interrupted.stderr, /EISDIR|directory/i);
    assert.equal(readFileSync(modified, "utf8"), "keep my edit\n");
    assert.equal(existsSync(manifestPath(home, record)), true);
    assert.equal(existsSync(manifestExpectationPath(home, record)), true);
    assert.match(readFileSync(join(home, "installs.txt"), "utf8"), /^cursor project /m);

    rmSync(blocker, { recursive: true, force: true });
    blocker = "";
    const retry = cli(["--all", "--yes"], { RETEMPER_HOME: home });

    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(readFileSync(modified, "utf8"), "keep my edit\n");
    assert.equal(existsSync(manifestPath(home, record)), false);
    assert.equal(existsSync(manifestExpectationPath(home, record)), false);
    assert.equal(readFileSync(join(home, "installs.txt"), "utf8").trim(), "not-a-line");
  } finally {
    if (blocker) rmSync(blocker, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
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

test("acceptance: uninstall dry-run with no state does not create the state home", () => {
  const holder = mkdtempSync(join(tmpdir(), "retemper-un-no-state-"));
  const home = join(holder, "missing-state");
  try {
    const result = cli(["--dry-run"], { RETEMPER_HOME: home });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing to uninstall/);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
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
