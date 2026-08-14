#!/usr/bin/env node
/**
 * Retemper installer — Grok Build only for now.
 *
 *   node install.mjs --help
 *   node install.mjs --dry-run --platform grok --scope user
 *   node install.mjs --platform grok --scope user
 *   node install.mjs --platform grok --scope project --target /path/to/repo
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "retemper";
const SUPPORTED_PLATFORMS = ["grok"];
const SUPPORTED_SCOPES = ["user", "project"];

const GRILL_FETCH = [
  "npx",
  "--yes",
  "skills@latest",
  "add",
  "mattpocock/skills",
  "--skill",
  "grill-me",
  "--skill",
  "grilling",
  "-y",
  "--copy",
];

function parseArgs(argv) {
  const out = {
    help: false,
    dryRun: false,
    skipDeps: false,
    platform: "",
    scope: "",
    target: "",
    standards: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--dry-run") out.dryRun = true;
    else if (token === "--skip-deps") out.skipDeps = true;
    else if (token === "--standards") out.standards = true;
    else if (token === "--platform") out.platform = String(rest[++i] || "");
    else if (token === "--scope") out.scope = String(rest[++i] || "");
    else if (token === "--target") out.target = String(rest[++i] || "");
    else throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function helpText() {
  return [
    "retemper installer",
    "",
    "A project-agnostic plan → accept → build → harden → review → QA → PR cycle.",
    "Platform support today: grok (Grok Build workflows).",
    "",
    "Usage:",
    "  node install.mjs --platform grok --scope user [--dry-run] [--skip-deps]",
    "  node install.mjs --platform grok --scope project --target <repo> [--standards]",
    "",
    "Options:",
    "  --platform grok          Only grok is implemented (Claude/Codex/Copilot later)",
    "  --scope user|project     user → ~/.grok/workflows   project → <repo>/.grok/workflows",
    "  --target <dir>           Required for --scope project",
    "  --dry-run                Print the plan, including the grill-me dependency step",
    "  --skip-deps              Do not fetch Matt Pocock grill-me / grilling",
    "  --standards              Copy templates/CODING_STANDARDS.md into the project root if missing",
    "  --help                   This text",
    "",
    "Dependencies:",
    "  grill-me  (mattpocock/skills) — front door; body is “run a grilling session”",
    "  grilling  (mattpocock/skills) — the interview primitive grill-me requires",
    `  Fetch: ${GRILL_FETCH.join(" ")} [--global for user scope]`,
    "  Offline fallback: vendor/grill-me and vendor/grilling shipped in this package.",
  ].join("\n");
}

function grokHome() {
  return process.env.GROK_HOME ? resolve(process.env.GROK_HOME) : join(homedir(), ".grok");
}

function planInstall(opts) {
  if (!SUPPORTED_PLATFORMS.includes(opts.platform)) {
    throw new Error(
      `Unsupported platform "${opts.platform || "(missing)"}". Pick platform=grok.`,
    );
  }
  if (!SUPPORTED_SCOPES.includes(opts.scope)) {
    throw new Error(`Unsupported scope "${opts.scope || "(missing)"}". Pick scope=user or scope=project.`);
  }

  const workflowSrc = join(here, ".grok", "workflows", `${NAME}.rhai`);
  const refsSrc = join(here, ".grok", "retemper", "references");
  const vendorGrillMe = join(here, "vendor", "grill-me");
  const vendorGrilling = join(here, "vendor", "grilling");
  const standardsSrc = join(here, "templates", "CODING_STANDARDS.md");

  if (opts.scope === "user") {
    const home = grokHome();
    return {
      platform: "grok",
      scope: "user",
      workflowSrc,
      workflowDest: join(home, "workflows", `${NAME}.rhai`),
      refsSrc,
      refsDest: join(home, "retemper", "references"),
      skillDests: [
        join(home, "skills", "grill-me"),
        join(home, "skills", "grilling"),
      ],
      vendorSkills: [vendorGrillMe, vendorGrilling],
      standardsSrc,
      standardsDest: null,
      fetchArgs: [...GRILL_FETCH, "--global"],
    };
  }

  const target = resolve(opts.target || process.cwd());
  return {
    platform: "grok",
    scope: "project",
    workflowSrc,
    workflowDest: join(target, ".grok", "workflows", `${NAME}.rhai`),
    refsSrc,
    refsDest: join(target, ".grok", "retemper", "references"),
    skillDests: [
      join(target, ".grok", "skills", "grill-me"),
      join(target, ".grok", "skills", "grilling"),
    ],
    vendorSkills: [vendorGrillMe, vendorGrilling],
    standardsSrc,
    standardsDest: opts.standards ? join(target, "CODING_STANDARDS.md") : null,
    fetchArgs: [...GRILL_FETCH],
  };
}

function describe(plan, opts) {
  const lines = [
    `platform=${plan.platform}`,
    `scope=${plan.scope}`,
    `workflow: ${plan.workflowSrc} → ${plan.workflowDest}`,
    `references: ${plan.refsSrc} → ${plan.refsDest}`,
    `grill-me dependency step: ${plan.fetchArgs.join(" ")}`,
    `grill-me vendor fallback: ${plan.vendorSkills[0]} → ${plan.skillDests[0]}`,
    `grilling vendor fallback: ${plan.vendorSkills[1]} → ${plan.skillDests[1]}`,
  ];
  if (plan.standardsDest) {
    lines.push(`CODING_STANDARDS.md: ${plan.standardsSrc} → ${plan.standardsDest} (if missing)`);
  }
  if (opts.skipDeps) {
    lines.push("deps: skipped (--skip-deps); vendor copies only");
  }
  if (opts.dryRun) {
    lines.push("dry-run: no files written, no network");
  }
  return lines.join("\n");
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function apply(plan, opts) {
  mkdirSync(dirname(plan.workflowDest), { recursive: true });
  writeFileSync(plan.workflowDest, readFileSync(plan.workflowSrc));
  copyDir(plan.refsSrc, plan.refsDest);
  for (let i = 0; i < plan.skillDests.length; i += 1) {
    copyDir(plan.vendorSkills[i], plan.skillDests[i]);
  }
  if (plan.standardsDest && !existsSync(plan.standardsDest)) {
    mkdirSync(dirname(plan.standardsDest), { recursive: true });
    writeFileSync(plan.standardsDest, readFileSync(plan.standardsSrc));
  }
  if (!opts.skipDeps) {
    const result = spawnSync(plan.fetchArgs[0], plan.fetchArgs.slice(1), {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error(
        "Upstream grill-me fetch failed; vendor copies are already in place. Re-run without --skip-deps when network works.",
      );
    }
  }
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || (!opts.platform && !opts.scope)) {
    console.log(helpText());
    process.exit(0);
  }
  const plan = planInstall(opts);
  console.log(describe(plan, opts));
  if (opts.dryRun) {
    return;
  }
  if (!existsSync(plan.workflowSrc)) {
    throw new Error(`Missing workflow definition: ${plan.workflowSrc}`);
  }
  apply(plan, opts);
  console.log(`installed ${NAME} (${plan.scope})`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
