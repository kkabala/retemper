/**
 * Retemper cycle control flow.
 * This module is the shipped state machine: launch-arg parsing, phase
 * order, grill-by-default, the only legal Planning skip, fail-closed
 * returns to Development, no-skip replay, living standards, and the
 * max-cycle stop. The Grok workflow script follows the same rules.
 * Skill-path shows a visible verdict on each handoff and waits for an
 * explicit go after Planning before Acceptance tests.
 */

export const NAME = "retemper";

export const PHASES = Object.freeze([
  "Planning",
  "Acceptance tests",
  "Development",
  "Cleaner",
  "Testing",
  "Code review",
  "Final QA Review",
  "Pipeline monitoring",
  "Standards",
]);

export type Phase = (typeof PHASES)[number];

/** Compute bands for each cycle phase. Not vendor model ids. */
export const PHASE_BANDS = Object.freeze({
  Planning: "deep",
  "Acceptance tests": "standard",
  Development: "standard",
  Cleaner: "standard",
  Testing: "standard",
  "Code review": "deep",
  "Final QA Review": "deep",
  "Pipeline monitoring": "standard",
  Standards: "standard",
});

export const HARDENING_PHASES = Object.freeze([
  "Development",
  "Cleaner",
  "Testing",
  "Code review",
  "Final QA Review",
  "Pipeline monitoring",
]);

export const RETURN_GATES = Object.freeze([
  "Cleaner",
  "Testing",
  "Code review",
  "Final QA Review",
  "Pipeline monitoring",
]);

export const DEFAULT_MAX_CYCLES = 3;

export type LaunchBag = {
  task: string;
  plan: string;
  ticket: string;
  focus: string;
  no_plan: boolean;
  grill: boolean;
  update_standards: boolean;
};

export type LaunchObject = {
  task?: unknown;
  plan?: unknown;
  ticket?: unknown;
  focus?: unknown;
  no_plan?: unknown;
  grill?: unknown;
  grill_me?: unknown;
  no_grill?: unknown;
  no_grill_me?: unknown;
  update_standards?: unknown;
  living_standards?: unknown;
  no_standards?: unknown;
};

export type LaunchInput = string | LaunchObject | null | undefined;

export type CycleVerdict = {
  return_to_dev?: unknown;
  evidence?: unknown;
  merged?: unknown;
} | null;

export type CycleStatus = "blocked" | "stopped" | "complete";

export type CycleResult = {
  walk: string[];
  status: CycleStatus;
  reason: string;
  cycles: number;
  launch: LaunchBag;
};

export type Decide = (phase: string, cycle: number) => CycleVerdict | unknown;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isFalse(value: unknown): boolean {
  return value === false || value === "false";
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function emptyLaunch(): LaunchBag {
  return {
    task: "",
    plan: "",
    ticket: "",
    focus: "",
    no_plan: false,
    grill: true,
    update_standards: true,
  };
}

function applyGrillFlags(out: LaunchBag, raw: LaunchObject): void {
  if (isFalse(raw.grill) || isFalse(raw.grill_me) || isTrue(raw.no_grill) || isTrue(raw.no_grill_me)) {
    out.grill = false;
  }
}

function applyStandardsFlags(out: LaunchBag, raw: LaunchObject): void {
  if (
    isFalse(raw.update_standards) ||
    isFalse(raw.living_standards) ||
    isTrue(raw.no_standards)
  ) {
    out.update_standards = false;
  }
}

/**
 * Turn a launch value into a normalized bag.
 * Accepts:
 *   - a plain string task, optionally with --no-grill / --no-plan / --no-standards / --ticket X
 *   - a JSON object { task, ticket, plan, no_plan, grill, grill_me, update_standards }
 */
export function parseLaunch(raw: LaunchInput): LaunchBag {
  const out = emptyLaunch();
  if (raw == null || raw === "") {
    return out;
  }
  if (typeof raw === "string") {
    return parseCommandLine(raw);
  }
  if (typeof raw !== "object") {
    return out;
  }
  out.task = text(raw.task);
  out.plan = text(raw.plan);
  out.ticket = text(raw.ticket);
  out.focus = text(raw.focus);
  out.no_plan = isTrue(raw.no_plan);
  applyGrillFlags(out, raw);
  applyStandardsFlags(out, raw);
  return out;
}

export function parseCommandLine(line: string): LaunchBag {
  const out = emptyLaunch();
  const tokens = text(line).split(/\s+/).filter(Boolean);
  const taskParts: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--no-grill" || token === "--no-grill-me") {
      out.grill = false;
    } else if (token === "--no-plan") {
      out.no_plan = true;
    } else if (token === "--no-standards") {
      out.update_standards = false;
    } else if (token === "--ticket" && tokens[i + 1]) {
      out.ticket = tokens[i + 1];
      i += 1;
    } else if (token.startsWith("--ticket=")) {
      out.ticket = token.slice("--ticket=".length);
    } else if (token === "--plan" && tokens[i + 1]) {
      out.plan = tokens[i + 1];
      i += 1;
    } else if (!token.startsWith("--")) {
      taskParts.push(token);
    }
  }
  out.task = taskParts.join(" ");
  return out;
}

function hasBrief(bag: LaunchBag): boolean {
  return bag.plan !== "" || bag.ticket !== "";
}

export function hasExistingBrief(args: LaunchInput): boolean {
  return hasBrief(parseLaunch(args));
}

export function shouldGrill(args: LaunchInput): boolean {
  return parseLaunch(args).grill === true;
}

export function shouldUpdateStandards(args: LaunchInput): boolean {
  return parseLaunch(args).update_standards === true;
}

/**
 * Skip the whole Planning phase only when the caller both declined a new
 * plan (no_plan + a brief) AND turned grilling off. A provided plan still
 * gets grilled unless grill is explicitly false.
 */
export function shouldSkipPlanning(args: LaunchInput): boolean {
  const bag = parseLaunch(args);
  return bag.no_plan === true && hasBrief(bag) && bag.grill === false;
}

export function planningGateError(args: LaunchInput): string | null {
  const bag = parseLaunch(args);
  if (bag.no_plan === true && !hasBrief(bag)) {
    return "Pass a plan or ticket when no_plan is set (JSON no_plan, or --no-plan).";
  }
  if (bag.task === "") {
    return "Say what to ship — a plain sentence or { task: \"...\" }.";
  }
  return null;
}

/**
 * Fail closed: a missing verdict, a non-boolean decision, or blank evidence
 * returns the cycle to Development.
 */
export function shouldReturnToDevelopment(verdict: unknown): boolean {
  if (verdict == null || typeof verdict !== "object" || Array.isArray(verdict)) {
    return true;
  }
  const bag = verdict as CycleVerdict;
  if (typeof bag?.return_to_dev !== "boolean" || text(bag.evidence) === "") {
    return true;
  }
  return bag.return_to_dev;
}

export function replayFromDevelopment(walk: string[]): string[] {
  return walk.concat(HARDENING_PHASES);
}

/**
 * Drive one retemper run.
 *
 * `decide(phase, cycle)` returns a verdict object. Tests call this with
 * real inputs; they must not reimplement the loop.
 */
export function runCycle({
  args,
  maxCycles = DEFAULT_MAX_CYCLES,
  decide,
}: {
  args: LaunchInput;
  maxCycles?: number;
  decide: Decide;
}): CycleResult {
  if (typeof decide !== "function") {
    throw new TypeError("runCycle requires a decide(phase, cycle) function");
  }

  const walk: string[] = [];
  const bag = parseLaunch(args);
  const gate = planningGateError(args);
  if (gate) {
    return { walk, status: "blocked", reason: gate, cycles: 0, launch: bag };
  }

  const cap = Number(maxCycles);
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_MAX_CYCLES;

  if (!shouldSkipPlanning(args)) {
    walk.push("Planning");
    decide("Planning", 1);
  }

  walk.push("Acceptance tests");
  decide("Acceptance tests", 1);

  let cycle = 1;
  let completed = false;
  let pipeReason = "pipeline-finished";
  while (cycle <= limit) {
    let bounced = false;

    for (const phase of HARDENING_PHASES) {
      walk.push(phase);
      const verdict = decide(phase, cycle);

      if (!RETURN_GATES.includes(phase)) {
        continue;
      }

      if (shouldReturnToDevelopment(verdict)) {
        cycle += 1;
        bounced = true;
        if (cycle > limit) {
          return {
            walk,
            status: "stopped",
            reason: "max-cycles",
            cycles: limit,
            launch: bag,
          };
        }
        break;
      }

      if (phase === "Pipeline monitoring") {
        completed = true;
        if (verdict && typeof verdict === "object" && (verdict as CycleVerdict)?.merged === true) {
          pipeReason = "merged";
        }
      }
    }

    if (completed || !bounced) {
      break;
    }
  }

  if (completed) {
    if (bag.update_standards) {
      walk.push("Standards");
      decide("Standards", cycle);
    }
    return {
      walk,
      status: "complete",
      reason: pipeReason,
      cycles: cycle,
      launch: bag,
    };
  }

  return {
    walk,
    status: "stopped",
    reason: "max-cycles",
    cycles: limit,
    launch: bag,
  };
}

export function walkHasNoSkipReplay(walk: string[]): boolean {
  const firstDev = walk.indexOf("Development");
  if (firstDev < 0) {
    return false;
  }
  const secondDev = walk.indexOf("Development", firstDev + 1);
  if (secondDev < 0) {
    return false;
  }
  const expected = HARDENING_PHASES;
  for (let i = 0; i < expected.length; i += 1) {
    if (walk[secondDev + i] !== expected[i]) {
      return false;
    }
  }
  return true;
}
