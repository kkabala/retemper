/**
 * Retemper cycle control flow.
 * This module is the shipped state machine: phase order, the only legal
 * Planning skip, fail-closed returns to Development, no-skip replay, and
 * the max-cycle stop. The Grok workflow script follows the same rules.
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
]);

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

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function hasExistingBrief(args) {
  if (args == null || typeof args !== "object") {
    return false;
  }
  return text(args.plan) !== "" || text(args.ticket) !== "";
}

export function shouldSkipPlanning(args) {
  return Boolean(args && args.no_plan === true && hasExistingBrief(args));
}

export function planningGateError(args) {
  if (args && args.no_plan === true && !hasExistingBrief(args)) {
    return "Pass args.plan or args.ticket when args.no_plan is true.";
  }
  if (!args || text(args.task) === "") {
    return "Pass args.task — what to ship.";
  }
  return null;
}

/**
 * Fail closed: a missing/unusable verdict is a return.
 * A return_to_dev claim without evidence is not a return.
 */
export function shouldReturnToDevelopment(verdict) {
  if (verdict == null || typeof verdict !== "object") {
    return true;
  }
  if (verdict.return_to_dev !== true) {
    return false;
  }
  return text(verdict.evidence) !== "";
}

export function replayFromDevelopment(walk) {
  return walk.concat(HARDENING_PHASES);
}

/**
 * Drive one retemper run.
 *
 * `decide(phase, cycle)` returns a verdict object. Tests and the installer
 * self-check call this with real inputs; they must not reimplement the loop.
 *
 * @param {{
 *   args: object,
 *   maxCycles?: number,
 *   decide: (phase: string, cycle: number) => object | null,
 * }} options
 */
export function runCycle({ args, maxCycles = DEFAULT_MAX_CYCLES, decide }) {
  if (typeof decide !== "function") {
    throw new TypeError("runCycle requires a decide(phase, cycle) function");
  }

  const walk = [];
  const gate = planningGateError(args);
  if (gate) {
    return { walk, status: "blocked", reason: gate, cycles: 0 };
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
          };
        }
        break;
      }

      if (phase === "Pipeline monitoring") {
        if (verdict && verdict.merged === true) {
          return {
            walk,
            status: "complete",
            reason: "merged",
            cycles: cycle,
          };
        }
        return {
          walk,
          status: "complete",
          reason: "pipeline-finished",
          cycles: cycle,
        };
      }
    }

    if (!bounced) {
      return {
        walk,
        status: "complete",
        reason: "pipeline-finished",
        cycles: cycle,
      };
    }
  }

  return {
    walk,
    status: "stopped",
    reason: "max-cycles",
    cycles: limit,
  };
}

export function walkHasNoSkipReplay(walk) {
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
