#!/usr/bin/env node
/**
 * Retemper installer — Grok Build workflows and a shared Agent Skill.
 *
 *   node install.mjs --help
 *   node install.mjs --dry-run --platform grok --scope user
 *   node install.mjs --platform grok --scope user
 *   node install.mjs --platform grok --scope project --target /path/to/repo
 *   node install.mjs --dry-run --platform codex --scope user
 *   node install.mjs --platform copilot --scope project --target /path/to/repo
 *
 * Codex and GitHub Copilot install the same SKILL.md tree under .agents/skills
 * (official discovery root for both). There is no second copy under
 * .github/skills or ~/.copilot/skills.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
export const NAME = "retemper";
export const SUPPORTED_PLATFORMS = ["grok", "codex", "copilot"];
export const SKILL_PLATFORMS = ["codex", "copilot"];
export const SUPPORTED_SCOPES = ["user", "project"];

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

export function parseArgs(argv) {
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

export function helpText() {
  return [
    "retemper installer",
    "",
    "A project-agnostic plan → accept → build → harden → review → QA → PR cycle.",
    "Platforms: grok (Grok Build workflow); codex and copilot (shared Agent Skill).",
    "",
    "Usage:",
    "  node install.mjs --platform grok --scope user [--dry-run] [--skip-deps]",
    "  node install.mjs --platform grok --scope project --target <repo> [--standards]",
    "  node install.mjs --platform codex --scope user [--dry-run] [--skip-deps]",
    "  node install.mjs --platform copilot --scope project --target <repo> [--standards]",
    "",
    "Options:",
    "  --platform grok|codex|copilot",
    "                           grok → .rhai workflow under ~/.grok",
    "                           codex and copilot → same SKILL.md under .agents/skills",
    "  --scope user|project     grok user → ~/.grok/workflows   grok project → <repo>/.grok/workflows",
    "                           skill user → ~/.agents/skills   skill project → <repo>/.agents/skills",
    "  --target <dir>           Required for --scope project",
    "  --dry-run                Print the plan, including the grill-me dependency step",
    "  --skip-deps              Do not fetch Matt Pocock grill-me / grilling",
    "  --standards              Copy templates/CODING_STANDARDS.md into the project root if missing",
    "  --help                   This text",
    "",
    "Launch after install:",
    "  grok:    /workflow retemper <task>     (or /retemper)",
    "  codex:   $retemper <task>              (or pick retemper from /skills)",
    "  copilot: /retemper <task>              (or pick retemper from /skills)",
    "",
    "Dependencies:",
    "  grill-me  (mattpocock/skills) — front door; body is “run a grilling session”",
    "  grilling  (mattpocock/skills) — the interview primitive grill-me requires",
    `  Fetch: ${GRILL_FETCH.join(" ")} [--global for user scope]`,
    "  Offline fallback: vendor/grill-me and vendor/grilling shipped in this package.",
  ].join("\n");
}

export function grokHome() {
  return process.env.GROK_HOME ? resolve(process.env.GROK_HOME) : join(homedir(), ".grok");
}

export function agentsHome() {
  return join(homedir(), ".agents");
}

function sharedSources() {
  return {
    refsSrc: join(here, "references"),
    vendorGrillMe: join(here, "vendor", "grill-me"),
    vendorGrilling: join(here, "vendor", "grilling"),
    standardsSrc: join(here, "templates", "CODING_STANDARDS.md"),
  };
}

function planGrok(opts, sources) {
  const workflowSrc = join(here, ".grok", "workflows", `${NAME}.rhai`);
  if (opts.scope === "user") {
    const home = grokHome();
    return {
      platform: "grok",
      scope: "user",
      workflowSrc,
      workflowDest: join(home, "workflows", `${NAME}.rhai`),
      skillSrc: null,
      skillDest: null,
      refsSrc: sources.refsSrc,
      refsDest: join(home, "retemper", "references"),
      skillDests: [
        join(home, "skills", "grill-me"),
        join(home, "skills", "grilling"),
      ],
      vendorSkills: [sources.vendorGrillMe, sources.vendorGrilling],
      standardsSrc: sources.standardsSrc,
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
    skillSrc: null,
    skillDest: null,
    refsSrc: sources.refsSrc,
    refsDest: join(target, ".grok", "retemper", "references"),
    skillDests: [
      join(target, ".grok", "skills", "grill-me"),
      join(target, ".grok", "skills", "grilling"),
    ],
    vendorSkills: [sources.vendorGrillMe, sources.vendorGrilling],
    standardsSrc: sources.standardsSrc,
    standardsDest: opts.standards ? join(target, "CODING_STANDARDS.md") : null,
    fetchArgs: [...GRILL_FETCH],
  };
}

function planSkillPlatform(platform, opts, sources) {
  const skillSrc = join(here, ".agents", "skills", NAME);
  if (opts.scope === "user") {
    const home = agentsHome();
    const skillDest = join(home, "skills", NAME);
    return {
      platform,
      scope: "user",
      workflowSrc: null,
      workflowDest: null,
      skillSrc,
      skillDest,
      refsSrc: sources.refsSrc,
      refsDest: join(skillDest, "references"),
      skillDests: [
        join(home, "skills", "grill-me"),
        join(home, "skills", "grilling"),
      ],
      vendorSkills: [sources.vendorGrillMe, sources.vendorGrilling],
      standardsSrc: sources.standardsSrc,
      standardsDest: null,
      fetchArgs: [...GRILL_FETCH, "--global"],
    };
  }

  const target = resolve(opts.target || process.cwd());
  const skillDest = join(target, ".agents", "skills", NAME);
  return {
    platform,
    scope: "project",
    workflowSrc: null,
    workflowDest: null,
    skillSrc,
    skillDest,
    refsSrc: sources.refsSrc,
    refsDest: join(skillDest, "references"),
    skillDests: [
      join(target, ".agents", "skills", "grill-me"),
      join(target, ".agents", "skills", "grilling"),
    ],
    vendorSkills: [sources.vendorGrillMe, sources.vendorGrilling],
    standardsSrc: sources.standardsSrc,
    standardsDest: opts.standards ? join(target, "CODING_STANDARDS.md") : null,
    fetchArgs: [...GRILL_FETCH],
  };
}

export function planInstall(opts) {
  if (!SUPPORTED_PLATFORMS.includes(opts.platform)) {
    throw new Error(
      `Unsupported platform "${opts.platform || "(missing)"}". Pick platform=grok, platform=codex, or platform=copilot.`,
    );
  }
  if (!SUPPORTED_SCOPES.includes(opts.scope)) {
    throw new Error(`Unsupported scope "${opts.scope || "(missing)"}". Pick scope=user or scope=project.`);
  }

  const sources = sharedSources();
  if (SKILL_PLATFORMS.includes(opts.platform)) {
    return planSkillPlatform(opts.platform, opts, sources);
  }
  return planGrok(opts, sources);
}

export function describe(plan, opts) {
  const lines = [`platform=${plan.platform}`, `scope=${plan.scope}`];
  if (plan.workflowDest) {
    lines.push(`workflow: ${plan.workflowSrc} → ${plan.workflowDest}`);
  }
  if (plan.skillDest) {
    lines.push(`skill: ${plan.skillSrc} → ${plan.skillDest}`);
  }
  lines.push(`references: ${plan.refsSrc} → ${plan.refsDest}`);
  lines.push(`grill-me dependency step: ${plan.fetchArgs.join(" ")}`);
  lines.push(`grill-me vendor fallback: ${plan.vendorSkills[0]} → ${plan.skillDests[0]}`);
  lines.push(`grilling vendor fallback: ${plan.vendorSkills[1]} → ${plan.skillDests[1]}`);
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

export function apply(plan, opts) {
  if (plan.workflowSrc && plan.workflowDest) {
    mkdirSync(dirname(plan.workflowDest), { recursive: true });
    writeFileSync(plan.workflowDest, readFileSync(plan.workflowSrc));
  }
  if (plan.skillSrc && plan.skillDest) {
    copyDir(plan.skillSrc, plan.skillDest);
  }
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

function payloadPath(plan) {
  return plan.skillSrc || plan.workflowSrc;
}

function isCli() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.help || (!opts.platform && !opts.scope)) {
    console.log(helpText());
    return 0;
  }
  const plan = planInstall(opts);
  console.log(describe(plan, opts));
  if (opts.dryRun) {
    return 0;
  }
  const payload = payloadPath(plan);
  if (!payload || !existsSync(payload)) {
    throw new Error(`Missing install payload: ${payload || "(none)"}`);
  }
  apply(plan, opts);
  console.log(`installed ${NAME} (${plan.scope})`);
  return 0;
}

if (isCli()) {
  try {
    const code = main();
    if (typeof code === "number" && code !== 0) {
      process.exit(code);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
