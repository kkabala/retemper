#!/usr/bin/env node
/**
 * Retemper installer — Grok Build workflows and a shared Agent Skill.
 *
 *   node install.ts --help
 *   node install.ts --dry-run --platform grok --scope user
 *   node install.ts --platform grok --scope user
 *   node install.ts --platform grok,codex --scope user
 *   node install.ts --platform grok --platform copilot --scope user
 *   node install.ts --platform grok --scope project --target /path/to/repo
 *   node install.ts --dry-run --platform codex --scope user
 *   node install.ts --platform copilot --scope project --target /path/to/repo
 *   node install.ts --platform cursor --scope project --target /path/to/repo
 *   node install.ts --update
 *
 * Codex, GitHub Copilot, and Cursor install the same SKILL.md tree under
 * .agents/skills. Cursor discovers that tree at both project and user scope.
 * Codex CLI user discovery is $CODEX_HOME/skills (default ~/.codex/skills),
 * so user-scope installs also symlink there. Platform-specific copies are not
 * created under .github/skills, ~/.copilot/skills, or .cursor/skills.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  assertInstallPlanPhysicalContainment,
  createInstallManifest,
  writeCoherentInstallManifests,
} from "./lib/install-manifest.ts";
import { rotateStateGeneration, withStateLock } from "./lib/install-state.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const NAME = "retemper";
export const SUPPORTED_PLATFORMS = ["grok", "codex", "copilot", "cursor"];
export const SKILL_PLATFORMS = ["codex", "copilot", "cursor"];
export const SUPPORTED_SCOPES = ["user", "project"];

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
export type Scope = (typeof SUPPORTED_SCOPES)[number];

export type ParsedArgs = {
  help: boolean;
  dryRun: boolean;
  skipDeps: boolean;
  platforms: string[];
  scope: string;
  target: string;
  standards: boolean;
  update: boolean;
};

export type SkillLink = { src: string; dest: string };

export type SharedSources = {
  refsSrc: string;
  orchestrateSrc: string;
  vendorGrillMe: string;
  vendorGrilling: string;
  standardsSrc: string;
};

export type InstallPlan = {
  platform: string;
  scope: string;
  targetRoot: string;
  workflowSrc: string | null;
  workflowDest: string | null;
  skillSrc: string | null;
  skillDest: string | null;
  refsSrc: string;
  refsDest: string;
  skillDests: string[];
  vendorSkills: string[];
  standardsSrc: string;
  standardsDest: string | null;
  fetchCommands: string[][];
  orchestrateSrc: string;
  orchestrateDest: string;
  skillLinks: SkillLink[];
};

export type ValidInstall = {
  platform: string;
  scope: string;
  path: string;
  invalid?: false;
};

export type InvalidInstall = {
  invalid: true;
  raw: string;
};

export type InstallEntry = ValidInstall | InvalidInstall;

type GrillSkill = { name: string; source: string };

const GRILL_SKILLS: GrillSkill[] = [
  { name: "grill-me", source: "mattpocock/skills/skills/productivity/grill-me" },
  { name: "grilling", source: "mattpocock/skills/skills/productivity/grilling" },
];

const GRILL_FETCH_AGENT: Record<string, string> = {
  grok: "grok",
  codex: "cline",
  copilot: "cline",
  cursor: "cline",
};

function grillFetchCommands(scope: string, platform: string): string[][] {
  return GRILL_SKILLS.map(({ name, source }) => {
    const args = [
      "npx",
      "--yes",
      "skills@latest",
      "add",
      source,
      "--skill",
      name,
      "-y",
      "--copy",
      "--agent",
      GRILL_FETCH_AGENT[platform],
    ];
    if (scope === "user") args.push("--global");
    return args;
  });
}

function splitPlatformList(value: unknown): string[] {
  return String(value)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function takePlatforms(
  rest: string[],
  index: number,
  token: string,
): { names: string[]; index: number } {
  const names: string[] = [];
  if (token.startsWith("--platform=")) {
    names.push(...splitPlatformList(token.slice("--platform=".length)));
    return { names, index };
  }
  let i = index;
  while (i + 1 < rest.length && !String(rest[i + 1]).startsWith("-")) {
    names.push(...splitPlatformList(rest[i + 1]));
    i += 1;
  }
  return { names, index: i };
}

function takeOptionValue(
  rest: string[],
  index: number,
  token: string,
  option: string,
): { value: string; index: number } {
  const prefix = `${option}=`;
  if (token.startsWith(prefix)) {
    const value = token.slice(prefix.length);
    if (!value) {
      throw new Error(`${option} requires a value.`);
    }
    return { value, index };
  }

  const value = rest[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`);
  }
  return { value, index: index + 1 };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    dryRun: false,
    skipDeps: false,
    platforms: [],
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
    else if (token === "--platform" || token.startsWith("--platform=")) {
      const taken = takePlatforms(rest, i, token);
      out.platforms.push(...taken.names);
      i = taken.index;
    } else if (token === "--scope" || token.startsWith("--scope=")) {
      const taken = takeOptionValue(rest, i, token, "--scope");
      out.scope = taken.value;
      i = taken.index;
    } else if (token === "--target" || token.startsWith("--target=")) {
      const taken = takeOptionValue(rest, i, token, "--target");
      out.target = taken.value;
      i = taken.index;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  out.platforms = uniqueNames(out.platforms);
  return out;
}

export function helpText(): string {
  return [
    "retemper installer",
    "",
    "A project-agnostic plan → accept → build → harden → review → QA → PR cycle.",
    "Platforms: grok (Grok Build workflow); codex, copilot, and cursor (shared Agent Skill).",
    "Also installs the orchestrate skill (generic coordinator) next to grill-me.",
    "",
    "Usage:",
    "  node install.ts --platform grok --scope user [--dry-run] [--skip-deps]",
    "  node install.ts --platform grok,codex --scope user",
    "  node install.ts --platform grok --platform copilot --scope user",
    "  node install.ts --platform grok --scope project --target <repo> [--standards]",
    "  node install.ts --platform codex --scope user [--dry-run] [--skip-deps]",
    "  node install.ts --platform copilot --scope project --target <repo> [--standards]",
    "  node install.ts --platform cursor --scope project --target <repo> [--standards]",
    "  node install.ts --update [--dry-run] [--skip-deps] [--standards]",
    "",
    "Options:",
    "  --platform grok|codex|copilot|cursor[,...]",
    "                           Repeat the flag, commas, or spaces: grok,codex or grok codex",
    "                           grok → .rhai workflow under ~/.grok",
    "                           codex, copilot, and cursor → same SKILL.md under .agents/skills",
    "                           Codex CLI user also $CODEX_HOME/skills (symlink)",
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
    "  cursor:  /retemper <task>              (or type / and pick retemper)",
    "",
    "Dependencies:",
    "  grill-me  (mattpocock/skills) — front door; body is “run a grilling session”",
    "  grilling  (mattpocock/skills) — the interview primitive grill-me requires",
    `  Fetch: ${GRILL_SKILLS.map(({ source }) => `npx --yes skills@latest add ${source}`).join(" ; ")}`,
    "          [--global for user scope]. Each skill is added from its folder so sibling",
    "          SKILL.md files with unquoted descriptions are never parsed.",
    "  Offline fallback: vendor/grill-me and vendor/grilling shipped in this package.",
  ].join("\n");
}

export function grokHome(): string {
  return process.env.GROK_HOME ? resolve(process.env.GROK_HOME) : join(homedir(), ".grok");
}

export function agentsHome(): string {
  return process.env.AGENTS_HOME ? resolve(process.env.AGENTS_HOME) : join(homedir(), ".agents");
}

export function codexHome(): string {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}

export function retemperHome(): string {
  return process.env.RETEMPER_HOME ? resolve(process.env.RETEMPER_HOME) : join(homedir(), ".retemper");
}

export function installsPath(): string {
  return join(retemperHome(), "installs.txt");
}

export function parseInstalls(text: string): InstallEntry[] {
  const records: InstallEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parsed = parseInstallLine(trimmed);
    records.push(parsed || { invalid: true, raw: line });
  }
  return records;
}

function parseInstallLine(trimmed: string): ValidInstall | null {
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

export function formatInstalls(entries: InstallEntry[]): string {
  if (!entries.length) return "";
  return `${entries
    .map((entry) =>
      entry.invalid ? entry.raw : `${entry.platform} ${entry.scope} ${entry.path}`,
    )
    .join("\n")}\n`;
}

function sameDestination(left: ValidInstall, right: ValidInstall): boolean {
  if (left.platform !== right.platform || left.scope !== right.scope) return false;
  if (left.scope === "user") return true;
  return resolve(left.path) === resolve(right.path);
}

function asInstallRecord(record: ValidInstall): ValidInstall {
  return { platform: record.platform, scope: record.scope, path: record.path };
}

export function upsertInstalls(entries: InstallEntry[], record: ValidInstall): InstallEntry[] {
  const next: InstallEntry[] = [];
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

export function recordFromPlan(plan: InstallPlan): ValidInstall {
  return asInstallRecord({
    platform: plan.platform,
    scope: plan.scope,
    path: plan.targetRoot,
  });
}

export function missingInstallsMessage(filePath = installsPath()): string {
  return [
    `No install record found at ${filePath}.`,
    "Update cannot run until a normal install has been recorded.",
    "Run a normal install first, for example:",
    "  node install.ts --platform grok --scope user",
    "  node install.ts --platform grok --scope project --target <repo>",
    "  node install.ts --platform codex --scope user",
    "  node install.ts --platform codex --scope project --target <repo>",
    "  node install.ts --platform cursor --scope user",
    "  node install.ts --platform cursor --scope project --target <repo>",
  ].join("\n");
}

function writeInstalls(entries: InstallEntry[], filePath = installsPath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, formatInstalls(entries));
  renameSync(tmp, filePath);
}

function readInstallRecords(filePath = installsPath()): InstallEntry[] | null {
  if (!existsSync(filePath)) return null;
  return parseInstalls(readFileSync(filePath, "utf8"));
}

function recordInstall(plan: InstallPlan): void {
  const filePath = installsPath();
  const record = recordFromPlan(plan);
  const entries = readInstallRecords(filePath) || [];
  const trackedRecords = entries.filter((entry): entry is ValidInstall => !entry.invalid);
  writeCoherentInstallManifests(retemperHome(), createInstallManifest(plan, record), trackedRecords);
  writeInstalls(upsertInstalls(entries, record), filePath);
}

function sharedSources(): SharedSources {
  return {
    refsSrc: join(here, "references"),
    orchestrateSrc: join(here, ".agents", "skills", "orchestrate"),
    vendorGrillMe: join(here, "vendor", "grill-me"),
    vendorGrilling: join(here, "vendor", "grilling"),
    standardsSrc: join(here, "templates", "CODING_STANDARDS.md"),
  };
}

function skillLinksFor(plan: InstallPlan): SkillLink[] {
  if (plan.platform !== "codex" || plan.scope !== "user") return [];
  const root = join(codexHome(), "skills");
  const srcs: string[] = [];
  if (plan.skillDest) srcs.push(plan.skillDest);
  if (plan.orchestrateDest) srcs.push(plan.orchestrateDest);
  srcs.push(...plan.skillDests);
  return srcs.map((src) => ({ src, dest: join(root, basename(src)) }));
}

function withOrchestrate(plan: Omit<InstallPlan, "orchestrateSrc" | "orchestrateDest" | "skillLinks">, dest: string, sources: SharedSources): InstallPlan {
  const next: InstallPlan = {
    ...plan,
    orchestrateSrc: sources.orchestrateSrc,
    orchestrateDest: dest,
    skillLinks: [],
  };
  next.skillLinks = skillLinksFor(next);
  return next;
}

function planGrok(opts: ParsedArgs & { platform: string }, sources: SharedSources): InstallPlan {
  const workflowSrc = join(here, ".grok", "workflows", `${NAME}.rhai`);
  const platform = opts.platform;
  if (opts.scope === "user") {
    const home = grokHome();
    return withOrchestrate(
      {
        platform,
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
        fetchCommands: grillFetchCommands("user", platform),
      },
      join(home, "skills", "orchestrate"),
      sources,
    );
  }

  const target = resolve(opts.target);
  return withOrchestrate(
    {
      platform,
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
      fetchCommands: grillFetchCommands("project", platform),
    },
    join(target, ".grok", "skills", "orchestrate"),
    sources,
  );
}

function planSkillPlatform(platform: string, opts: ParsedArgs, sources: SharedSources): InstallPlan {
  const skillSrc = join(here, ".agents", "skills", NAME);
  if (opts.scope === "user") {
    const home = agentsHome();
    const skillDest = join(home, "skills", NAME);
    return withOrchestrate(
      {
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
        fetchCommands: grillFetchCommands("user", platform),
      },
      join(home, "skills", "orchestrate"),
      sources,
    );
  }

  const target = resolve(opts.target);
  const skillDest = join(target, ".agents", "skills", NAME);
  return withOrchestrate(
    {
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
      fetchCommands: grillFetchCommands("project", platform),
    },
    join(target, ".agents", "skills", "orchestrate"),
    sources,
  );
}

function unsupportedPlatformError(platform: string): Error {
  return new Error(
    `Unsupported platform "${platform || "(missing)"}". Pick platform=grok, platform=codex, platform=copilot, or platform=cursor.`,
  );
}

function assertSupportedPlatforms(platforms: string[]): void {
  if (!platforms.length) {
    throw unsupportedPlatformError("");
  }
  for (const platform of platforms) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw unsupportedPlatformError(platform);
    }
  }
}

export function planInstall(opts: { platform: string; scope: string; target?: string; standards?: boolean }): InstallPlan {
  if (!SUPPORTED_PLATFORMS.includes(opts.platform)) {
    throw unsupportedPlatformError(opts.platform);
  }
  if (!SUPPORTED_SCOPES.includes(opts.scope)) {
    throw new Error(`Unsupported scope "${opts.scope || "(missing)"}". Pick scope=user or scope=project.`);
  }
  if (opts.scope === "project" && (!opts.target || opts.target.trim() === "")) {
    throw new Error("--target <dir> is required for project scope.");
  }

  const sources = sharedSources();
  const parsed: ParsedArgs = {
    help: false,
    dryRun: false,
    skipDeps: false,
    platforms: [opts.platform],
    scope: opts.scope,
    target: opts.target || "",
    standards: Boolean(opts.standards),
    update: false,
  };
  if (SKILL_PLATFORMS.includes(opts.platform)) {
    return planSkillPlatform(opts.platform, parsed, sources);
  }
  return planGrok({ ...parsed, platform: opts.platform }, sources);
}

export function describe(plan: InstallPlan, opts: { skipDeps?: boolean; dryRun?: boolean }): string {
  const lines = [`platform=${plan.platform}`, `scope=${plan.scope}`];
  if (plan.workflowDest) {
    lines.push(`workflow: ${plan.workflowSrc} → ${plan.workflowDest}`);
  }
  if (plan.skillDest) {
    lines.push(`skill: ${plan.skillSrc} → ${plan.skillDest}`);
  }
  if (plan.orchestrateDest) {
    lines.push(`orchestrate: ${plan.orchestrateSrc} → ${plan.orchestrateDest}`);
  }
  lines.push(`references: ${plan.refsSrc} → ${plan.refsDest}`);
  for (const argv of plan.fetchCommands) {
    lines.push(`grill dependency step: ${argv.join(" ")}`);
  }
  lines.push(`grill-me vendor fallback: ${plan.vendorSkills[0]} → ${plan.skillDests[0]}`);
  lines.push(`grilling vendor fallback: ${plan.vendorSkills[1]} → ${plan.skillDests[1]}`);
  for (const link of plan.skillLinks) {
    lines.push(`codex skill link: ${link.src} → ${link.dest}`);
  }
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

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function nodeErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

function isMissingOrLoop(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code === "ENOENT" || code === "ELOOP";
}

function samePhysicalEntry(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch (error) {
    if (isMissingOrLoop(error)) return false;
    throw error;
  }
}

function namesSameEntry(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  if (basename(left) !== basename(right)) return false;
  return samePhysicalEntry(dirname(left), dirname(right));
}

function repairLegacySelfLink(src: string, dest: string): void {
  if (!namesSameEntry(src, dest)) return;
  try {
    if (!lstatSync(dest).isSymbolicLink()) return;
    const target = resolve(dirname(dest), readlinkSync(dest));
    if (!namesSameEntry(target, dest)) return;
    unlinkSync(dest);
  } catch (error) {
    if (isMissingOrLoop(error)) return;
    throw error;
  }
}

function replaceWithSymlink(src: string, dest: string): void {
  const absSrc = resolve(src);
  if (absSrc === resolve(dest) || samePhysicalEntry(absSrc, dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink() && resolve(dirname(dest), readlinkSync(dest)) === absSrc) return;
    rmSync(dest, { recursive: true, force: true });
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") throw error;
  }
  try {
    symlinkSync(absSrc, dest);
  } catch {
    copyDir(absSrc, dest);
  }
}

export function apply(plan: InstallPlan, opts: { skipDeps?: boolean }): void {
  for (const link of plan.skillLinks) {
    repairLegacySelfLink(link.src, link.dest);
  }
  assertInstallPlanPhysicalContainment(plan);
  if (plan.workflowSrc && plan.workflowDest) {
    mkdirSync(dirname(plan.workflowDest), { recursive: true });
    writeFileSync(plan.workflowDest, readFileSync(plan.workflowSrc));
  }
  if (plan.skillSrc && plan.skillDest) {
    copyDir(plan.skillSrc, plan.skillDest);
  }
  copyDir(plan.refsSrc, plan.refsDest);
  if (plan.orchestrateSrc && plan.orchestrateDest) {
    copyDir(plan.orchestrateSrc, plan.orchestrateDest);
    const destRefDir = join(plan.orchestrateDest, "references");
    mkdirSync(destRefDir, { recursive: true });
    writeFileSync(
      join(destRefDir, "orchestrator.md"),
      readFileSync(join(plan.refsSrc, "orchestrator.md")),
    );
  }
  for (let i = 0; i < plan.skillDests.length; i += 1) {
    copyDir(plan.vendorSkills[i], plan.skillDests[i]);
  }
  if (plan.standardsDest && !existsSync(plan.standardsDest)) {
    mkdirSync(dirname(plan.standardsDest), { recursive: true });
    writeFileSync(plan.standardsDest, readFileSync(plan.standardsSrc));
  }
  if (!opts.skipDeps) {
    let failed = false;
    const cwd = plan.scope === "project" ? plan.targetRoot : undefined;
    for (const argv of plan.fetchCommands) {
      const result = spawnSync(argv[0], argv.slice(1), { cwd, stdio: "inherit" });
      if (result.status !== 0) failed = true;
    }
    if (failed) {
      console.error(
        "Upstream grill-me fetch failed; vendor copies are already in place. Re-run without --skip-deps when network works.",
      );
    }
  }
  for (const link of plan.skillLinks) {
    replaceWithSymlink(link.src, link.dest);
  }
}

function payloadPath(plan: InstallPlan): string | null {
  return plan.skillSrc || plan.workflowSrc;
}

function applyPlan(plan: InstallPlan, opts: { skipDeps?: boolean }): void {
  const payload = payloadPath(plan);
  if (!payload || !existsSync(payload)) {
    throw new Error(`Missing install payload: ${payload || "(none)"}`);
  }
  apply(plan, opts);
}

function invokedAsThisModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}

function isCli(): boolean {
  return invokedAsThisModule(import.meta.url);
}

type UpdateOutcome = {
  keep: boolean;
  entry: InstallEntry;
  failed: boolean;
};

type PreparedUpdate =
  | { kind: "malformed"; entry: InstallEntry }
  | { kind: "missing"; entry: ValidInstall }
  | { kind: "failed"; entry: ValidInstall; message: string }
  | { kind: "ready"; entry: ValidInstall; plan: InstallPlan };

function prepareUpdate(entry: InstallEntry, opts: ParsedArgs): PreparedUpdate {
  if (entry.invalid) {
    return { kind: "malformed", entry };
  }
  if (entry.scope === "project" && !existsSync(entry.path)) {
    return { kind: "missing", entry };
  }
  try {
    const plan = planInstall({
      platform: entry.platform,
      scope: entry.scope,
      target: entry.path,
      standards: opts.standards,
    });
    return { kind: "ready", entry, plan };
  } catch (error) {
    return {
      kind: "failed",
      entry,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function updateOne(prepared: PreparedUpdate, opts: ParsedArgs, trackedRecords: ValidInstall[]): UpdateOutcome {
  if (prepared.kind === "malformed") {
    console.error(`Skipping malformed install record: ${prepared.entry.invalid ? prepared.entry.raw : ""}`);
    return { keep: true, entry: prepared.entry, failed: false };
  }
  if (prepared.kind === "missing") {
    console.error(`Skipping missing project path: ${prepared.entry.path}`);
    return { keep: Boolean(opts.dryRun), entry: prepared.entry, failed: false };
  }
  if (prepared.kind === "failed") {
    console.error(prepared.message);
    return { keep: true, entry: prepared.entry, failed: true };
  }
  console.log(describe(prepared.plan, opts));
  try {
    if (!opts.dryRun) {
      applyPlan(prepared.plan, opts);
      const record = recordFromPlan(prepared.plan);
      writeCoherentInstallManifests(retemperHome(), createInstallManifest(prepared.plan, record), trackedRecords);
    }
    return { keep: true, entry: recordFromPlan(prepared.plan), failed: false };
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return { keep: true, entry: prepared.entry, failed: true };
  }
}

function reportUpdateNoOp(entries: InstallEntry[] | null, filePath: string): number | null {
  if (entries === null) {
    console.error(missingInstallsMessage(filePath));
    return 1;
  }
  if (entries.length === 0) {
    console.log("Nothing to update.");
    return 0;
  }
  return null;
}

function runPreparedUpdate(
  opts: ParsedArgs,
  entries: InstallEntry[],
  prepared: PreparedUpdate[],
  persist: boolean,
): number {
  const filePath = installsPath();
  let kept: InstallEntry[] = [];
  let failed = 0;
  const trackedRecords = entries.filter((entry): entry is ValidInstall => !entry.invalid);
  for (const item of prepared) {
    const outcome = updateOne(item, opts, trackedRecords);
    if (outcome.keep) {
      if (outcome.entry.invalid) kept.push(outcome.entry);
      else kept = upsertInstalls(kept, outcome.entry);
    }
    if (outcome.failed) failed += 1;
  }
  if (persist) writeInstalls(kept, filePath);
  return failed === 0 ? 0 : 1;
}

function hasUpdateMutation(prepared: PreparedUpdate[]): boolean {
  return prepared.some((item) => item.kind === "ready" || item.kind === "missing");
}

function runUpdate(opts: ParsedArgs): number {
  const filePath = installsPath();
  const entries = readInstallRecords(filePath);
  const noOp = reportUpdateNoOp(entries, filePath);
  if (noOp !== null) return noOp;
  const prepared = entries.map((entry) => prepareUpdate(entry, opts));
  return runPreparedUpdate(opts, entries, prepared, false);
}

function runMutatingUpdate(opts: ParsedArgs): number {
  const filePath = installsPath();
  const initial = readInstallRecords(filePath);
  const initialNoOp = reportUpdateNoOp(initial, filePath);
  if (initialNoOp !== null) return initialNoOp;
  return withStateLock(retemperHome(), () => {
    const entries = readInstallRecords(filePath);
    const lockedNoOp = reportUpdateNoOp(entries, filePath);
    if (lockedNoOp !== null) return lockedNoOp;
    const prepared = entries.map((entry) => prepareUpdate(entry, opts));
    if (!hasUpdateMutation(prepared)) return runPreparedUpdate(opts, entries, prepared, false);
    rotateStateGeneration(retemperHome());
    return runPreparedUpdate(opts, entries, prepared, true);
  });
}

function prepareInstall(opts: ParsedArgs): InstallPlan[] {
  assertSupportedPlatforms(opts.platforms);
  return opts.platforms.map((platform) => planInstall({ ...opts, platform }));
}

function installOne(plan: InstallPlan, opts: ParsedArgs): void {
  console.log(describe(plan, opts));
  if (opts.dryRun) return;
  applyPlan(plan, opts);
  recordInstall(plan);
  console.log(`installed ${NAME} (${plan.scope})`);
}

function runInstall(opts: ParsedArgs, plans: InstallPlan[]): number {
  let failed = 0;
  for (const plan of plans) {
    try {
      installOne(plan, opts);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      failed += 1;
    }
  }
  return failed === 0 ? 0 : 1;
}

export function main(argv: string[] = process.argv): number {
  const opts = parseArgs(argv);
  if (opts.help || (!opts.update && !opts.platforms.length && !opts.scope)) {
    console.log(helpText());
    return 0;
  }
  if (opts.update) return opts.dryRun ? runUpdate(opts) : runMutatingUpdate(opts);
  const plans = prepareInstall(opts);
  if (opts.dryRun) return runInstall(opts, plans);
  return withStateLock(retemperHome(), () => {
    rotateStateGeneration(retemperHome());
    return runInstall(opts, plans);
  });
}

export function runCli(moduleUrl: string = import.meta.url): void {
  if (!invokedAsThisModule(moduleUrl)) {
    return;
  }
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

if (isCli()) {
  runCli();
}
