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
 *   node install.mjs --update
 *
 * Codex and GitHub Copilot install the same SKILL.md tree under .agents/skills
 * (official discovery root for both). There is no second copy under
 * .github/skills or ~/.copilot/skills.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    update: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--help" || token === "-h") out.help = true;
    else if (token === "--dry-run") out.dryRun = true;
    else if (token === "--skip-deps") out.skipDeps = true;
    else if (token === "--standards") out.standards = true;
    else if (token === "--update") out.update = true;
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
    "  node install.mjs --update [--dry-run] [--skip-deps] [--standards]",
    "",
    "Options:",
    "  --platform grok|codex|copilot",
    "                           grok → .rhai workflow under ~/.grok",
    "                           codex and copilot → same SKILL.md under .agents/skills",
    "  --scope user|project     grok user → ~/.grok/workflows   grok project → <repo>/.grok/workflows",
    "                           skill user → ~/.agents/skills   skill project → <repo>/.agents/skills",
    "  --target <dir>           Required for --scope project",
    "  --update                 Re-apply to destinations in ~/.retemper/installs.txt (or $RETEMPER_HOME/installs.txt)",
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

export function retemperHome() {
  return process.env.RETEMPER_HOME ? resolve(process.env.RETEMPER_HOME) : join(homedir(), ".retemper");
}

export function installsPath() {
  return join(retemperHome(), "installs.txt");
}

export function parseInstalls(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parsed = parseInstallLine(trimmed);
    records.push(parsed || { invalid: true, raw: line });
  }
  return records;
}

function parseInstallLine(trimmed) {
  const match = trimmed.match(/^(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) return null;
  const platform = match[1];
  const scope = match[2];
  const dest = match[3].trim();
  if (!SUPPORTED_PLATFORMS.includes(platform) || !SUPPORTED_SCOPES.includes(scope) || !dest) {
    return null;
  }
  return { platform, scope, path: dest };
}

export function formatInstalls(entries) {
  if (!entries.length) return "";
  return `${entries
    .map((entry) =>
      entry.invalid ? entry.raw : `${entry.platform} ${entry.scope} ${entry.path}`,
    )
    .join("\n")}\n`;
}

function sameDestination(left, right) {
  if (left.platform !== right.platform || left.scope !== right.scope) return false;
  if (left.scope === "user") return true;
  return resolve(left.path) === resolve(right.path);
}

function asInstallRecord(record) {
  return { platform: record.platform, scope: record.scope, path: record.path };
}

export function upsertInstalls(entries, record) {
  const next = [];
  let replaced = false;
  for (const entry of entries) {
    if (!entry.invalid && sameDestination(entry, record)) {
      if (!replaced) {
        next.push(asInstallRecord(record));
        replaced = true;
      }
    } else {
      next.push(entry);
    }
  }
  if (!replaced) {
    next.push(asInstallRecord(record));
  }
  return next;
}

export function recordFromPlan(plan) {
  return asInstallRecord({
    platform: plan.platform,
    scope: plan.scope,
    path: plan.targetRoot,
  });
}

export function missingInstallsMessage(filePath = installsPath()) {
  return [
    `No install record found at ${filePath}.`,
    "Update cannot run until a normal install has been recorded.",
    "Run a normal install first, for example:",
    "  node install.mjs --platform grok --scope user",
    "  node install.mjs --platform grok --scope project --target <repo>",
    "  node install.mjs --platform codex --scope user",
    "  node install.mjs --platform codex --scope project --target <repo>",
  ].join("\n");
}

function writeInstalls(entries, filePath = installsPath()) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, formatInstalls(entries));
  renameSync(tmp, filePath);
}

function readInstallRecords(filePath = installsPath()) {
  if (!existsSync(filePath)) return null;
  return parseInstalls(readFileSync(filePath, "utf8"));
}

function recordInstall(plan) {
  const filePath = installsPath();
  writeInstalls(upsertInstalls(readInstallRecords(filePath) || [], recordFromPlan(plan)), filePath);
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
      targetRoot: home,
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
    targetRoot: target,
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
      targetRoot: home,
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
    targetRoot: target,
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

function applyPlan(plan, opts) {
  const payload = payloadPath(plan);
  if (!payload || !existsSync(payload)) {
    throw new Error(`Missing install payload: ${payload || "(none)"}`);
  }
  apply(plan, opts);
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

function updateOne(entry, opts) {
  if (entry.invalid) {
    console.error(`Skipping malformed install record: ${entry.raw}`);
    return { keep: true, entry, failed: false };
  }
  if (entry.scope === "project" && !existsSync(entry.path)) {
    console.error(`Skipping missing project path: ${entry.path}`);
    return { keep: Boolean(opts.dryRun), entry, failed: false };
  }
  try {
    const plan = planInstall({
      platform: entry.platform,
      scope: entry.scope,
      target: entry.path,
      standards: opts.standards,
    });
    console.log(describe(plan, opts));
    if (!opts.dryRun) {
      applyPlan(plan, opts);
    }
    return { keep: true, entry: recordFromPlan(plan), failed: false };
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return { keep: true, entry, failed: true };
  }
}

function runUpdate(opts) {
  const filePath = installsPath();
  const entries = readInstallRecords(filePath);
  if (entries === null) {
    console.error(missingInstallsMessage(filePath));
    return 1;
  }
  if (entries.length === 0) {
    console.log("Nothing to update.");
    return 0;
  }
  let kept = [];
  let failed = 0;
  for (const entry of entries) {
    const outcome = updateOne(entry, opts);
    if (outcome.keep) {
      if (outcome.entry.invalid) kept.push(outcome.entry);
      else kept = upsertInstalls(kept, outcome.entry);
    }
    if (outcome.failed) failed += 1;
  }
  if (!opts.dryRun) {
    writeInstalls(kept, filePath);
  }
  return failed === 0 ? 0 : 1;
}

function runInstall(opts) {
  const plan = planInstall(opts);
  console.log(describe(plan, opts));
  if (opts.dryRun) {
    return 0;
  }
  applyPlan(plan, opts);
  recordInstall(plan);
  console.log(`installed ${NAME} (${plan.scope})`);
  return 0;
}

export function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.help || (!opts.update && !opts.platform && !opts.scope)) {
    console.log(helpText());
    return 0;
  }
  if (opts.update) {
    return runUpdate(opts);
  }
  return runInstall(opts);
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
