import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

import { SUPPORTED_PLATFORMS } from "../install.ts";
import { REQUIRED_NODE_MAJOR, nodeMajor, nodeVersionError } from "../bin/bootstrap.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceBin = join(root, "retemper.ts");

const allPlatforms = ["grok", "codex", "copilot", "cursor"];
const allModes = ["source", "published"];

function requestedList(value: string | undefined, allowed: string[], label: string): string[] {
  if (!value) return allowed;
  if (!allowed.includes(value)) {
    throw new Error(`Unknown ${label} "${value}". Pick ${allowed.join(", ")}.`);
  }
  return [value];
}

const platforms = requestedList(process.env.RETEMPER_CLI_PLATFORM, allPlatforms, "platform");
const modes = requestedList(process.env.RETEMPER_CLI_MODE, allModes, "mode");

type PackedCli = { consumer: string; bin: string; tarball: string };

let packed: PackedCli | null = null;

function packPublishedCli(): PackedCli {
  const packDir = mkdtempSync(join(tmpdir(), "retemper-pack-"));
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], {
    encoding: "utf8" as const,
    cwd: root,
  });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);
  const info = JSON.parse(pack.stdout);
  const filename = Array.isArray(info) ? info[0].filename : info.filename;
  assert.equal(typeof filename, "string");
  const tarball = join(packDir, filename);
  assert.equal(existsSync(tarball), true, tarball);

  const consumer = mkdtempSync(join(tmpdir(), "retemper-consumer-"));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "retemper-consumer", private: true, type: "module" }),
  );
  const install = spawnSync("npm", ["install", "--prefix", consumer, "--no-fund", "--offline", tarball], {
    encoding: "utf8" as const,
    cwd: root,
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const bin = join(consumer, "node_modules", "retemper", "bin", "retemper.js");
  assert.equal(existsSync(bin), true, "published package must ship bin/retemper.js");
  return { consumer, bin, tarball };
}

before(() => {
  if (modes.includes("published")) {
    packed = packPublishedCli();
  }
});

after(() => {
  if (!packed) return;
  rmSync(dirname(packed.tarball), { recursive: true, force: true });
  rmSync(packed.consumer, { recursive: true, force: true });
});

function cliFor(mode: string, args: string[], env: NodeJS.ProcessEnv) {
  const entry = mode === "published" ? packed?.bin : sourceBin;
  assert.ok(entry, `CLI entry missing for mode=${mode}`);
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8" as const,
    cwd: root,
    env: { ...process.env, ...env },
  });
}

function payloadPath(platform: string, target: string): string {
  if (platform === "grok") {
    return join(target, ".grok", "workflows", "retemper.rhai");
  }
  return join(target, ".agents", "skills", "retemper", "SKILL.md");
}

function assertInstalled(platform: string, target: string): void {
  if (platform === "grok") {
    assert.equal(existsSync(join(target, ".grok", "workflows", "retemper.rhai")), true);
    assert.equal(existsSync(join(target, ".grok", "skills", "orchestrate", "SKILL.md")), true);
    assert.equal(existsSync(join(target, ".grok", "skills", "grill-me", "SKILL.md")), true);
    assert.equal(existsSync(join(target, ".grok", "skills", "grilling", "SKILL.md")), true);
    assert.equal(existsSync(join(target, ".grok", "retemper", "references", "architect.md")), true);
    return;
  }
  const skills = join(target, ".agents", "skills");
  assert.equal(existsSync(join(skills, "retemper", "SKILL.md")), true);
  assert.equal(existsSync(join(skills, "retemper", "references", "architect.md")), true);
  assert.equal(existsSync(join(skills, "orchestrate", "SKILL.md")), true);
  assert.equal(existsSync(join(skills, "grill-me", "SKILL.md")), true);
  assert.equal(existsSync(join(skills, "grilling", "SKILL.md")), true);
}

function assertUninstalled(platform: string, target: string): void {
  assert.equal(existsSync(payloadPath(platform, target)), false);
  if (platform === "grok") {
    assert.equal(existsSync(join(target, ".grok", "skills", "orchestrate", "SKILL.md")), false);
    return;
  }
  assert.equal(existsSync(join(target, ".agents", "skills", "retemper", "SKILL.md")), false);
}

test("bootstrap rejects Node majors below engines.node", () => {
  assert.equal(REQUIRED_NODE_MAJOR, 26);
  assert.equal(nodeMajor("22.14.0"), 22);
  assert.equal(nodeMajor("26.8.1"), 26);
  assert.match(nodeVersionError("v22.14.0"), /Node\.js 26 or later/);
  assert.match(nodeVersionError("v22.14.0"), /v22\.14\.0/);
});

test("CI runs npm test on Node 26 and a real CLI matrix; publish is human-gated", () => {
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /node-version-file: \.nvmrc/);
  assert.match(ci, /npm test/);
  assert.match(ci, /matrix:/);
  for (const platform of allPlatforms) {
    assert.match(ci, new RegExp(`\\b${platform}\\b`));
  }
  assert.match(ci, /RETEMPER_CLI_MODE: published/);
  assert.doesNotMatch(ci, /npm publish/);
  const publish = readFileSync(join(root, ".github", "workflows", "publish.yml"), "utf8");
  assert.match(publish, /workflow_dispatch/);
  assert.match(publish, /release:/);
  assert.match(publish, /npm publish/);
  assert.match(publish, /secrets\.NPM_TOKEN/);
  assert.doesNotMatch(publish, /branches:/);
});

test("package metadata is publishable and honest about Node 26", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.name, "retemper");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.bin.retemper, "./bin/retemper.js");
  assert.equal(pkg.bin["retemper-install"], "./bin/retemper-install.js");
  assert.equal(pkg.bin["retemper-uninstall"], "./bin/retemper-uninstall.js");
  assert.equal(pkg.engines.node, ">=26");
  assert.deepEqual(SUPPORTED_PLATFORMS, allPlatforms);
  for (const entry of [
    "bin/",
    "retemper.ts",
    "install.ts",
    "uninstall.ts",
    "lib/",
    "references/",
    "templates/",
    "vendor/",
    ".agents/",
    ".grok/",
  ]) {
    assert.equal(pkg.files.includes(entry), true, entry);
  }
});

test("npm pack includes the install payloads npx needs", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8" as const,
    cwd: root,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const info = JSON.parse(result.stdout);
  const packedInfo = Array.isArray(info) ? info[0] : info;
  const paths = new Set((packedInfo.files || []).map((file: { path: string }) => file.path));
  const required = [
    "bin/retemper.js",
    "bin/bootstrap.js",
    "retemper.ts",
    "install.ts",
    "uninstall.ts",
    "lib/cycle.ts",
    "lib/install-manifest.ts",
    "lib/install-state.ts",
    ".agents/skills/retemper/SKILL.md",
    ".agents/skills/orchestrate/SKILL.md",
    ".grok/workflows/retemper.rhai",
    "references/architect.md",
    "templates/CODING_STANDARDS.md",
    "vendor/grill-me/SKILL.md",
    "vendor/grilling/SKILL.md",
    "vendor/LICENSE",
  ];
  for (const path of required) {
    assert.equal(paths.has(path), true, `packed tarball missing ${path}`);
  }
  assert.equal(paths.has("tests/install.test.ts"), false);
  assert.equal(paths.has("CODING_STANDARDS.md"), false);
});

for (const mode of modes) {
  for (const platform of platforms) {
    test(`${mode} CLI ${platform} install → update → uninstall`, () => {
      const target = mkdtempSync(join(tmpdir(), `retemper-${mode}-${platform}-`));
      const home = mkdtempSync(join(tmpdir(), "retemper-home-"));
      const env = { RETEMPER_HOME: home };
      try {
        const installed = cliFor(mode, [
          "install",
          "--platform",
          platform,
          "--scope",
          "project",
          "--target",
          target,
          "--skip-deps",
        ], env);
        assert.equal(installed.status, 0, installed.stderr || installed.stdout);
        assert.match(installed.stdout, new RegExp(`platform=${platform}`));
        assertInstalled(platform, target);
        assert.match(readFileSync(join(home, "installs.txt"), "utf8"), new RegExp(`${platform} project `));

        const marker = payloadPath(platform, target);
        rmSync(marker);
        assert.equal(existsSync(marker), false);

        const updated = cliFor(mode, ["update", "--skip-deps"], env);
        assert.equal(updated.status, 0, updated.stderr || updated.stdout);
        assert.equal(existsSync(marker), true, "update must restore the deleted payload");
        assertInstalled(platform, target);

        const removed = cliFor(mode, ["uninstall", "--all", "--yes"], env);
        assert.equal(removed.status, 0, removed.stderr || removed.stdout);
        assertUninstalled(platform, target);
        assert.equal(existsSync(join(home, "installs.txt")), false);
      } finally {
        rmSync(target, { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
}

if (modes.includes("published")) {
  test("published CLI help is reachable without a clone layout", () => {
    assert.ok(packed);
    const help = cliFor("published", ["help"], {});
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /npx retemper install/);
    const installHelp = cliFor("published", ["install", "--help"], {});
    assert.equal(installHelp.status, 0, installHelp.stderr);
    assert.match(installHelp.stdout, /retemper installer/);
    const uninstallHelp = cliFor("published", ["uninstall", "--help"], {});
    assert.equal(uninstallHelp.status, 0, uninstallHelp.stderr);
    assert.match(uninstallHelp.stdout, /retemper uninstaller/);

    const installBin = join(packed.consumer, "node_modules", "retemper", "bin", "retemper-install.js");
    const uninstallBin = join(packed.consumer, "node_modules", "retemper", "bin", "retemper-uninstall.js");
    const dedicatedInstall = spawnSync(process.execPath, [installBin, "--help"], {
      encoding: "utf8" as const,
    });
    assert.equal(dedicatedInstall.status, 0, dedicatedInstall.stderr);
    assert.match(dedicatedInstall.stdout, /retemper installer/);
    const dedicatedUninstall = spawnSync(process.execPath, [uninstallBin, "--help"], {
      encoding: "utf8" as const,
    });
    assert.equal(dedicatedUninstall.status, 0, dedicatedUninstall.stderr);
    assert.match(dedicatedUninstall.stdout, /retemper uninstaller/);
  });
}
