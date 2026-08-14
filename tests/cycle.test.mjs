import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  HARDENING_PHASES,
  PHASES,
  planningGateError,
  runCycle,
  shouldReturnToDevelopment,
  shouldSkipPlanning,
  walkHasNoSkipReplay,
} from "../lib/cycle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rhaiPath = join(root, ".grok", "workflows", "retemper.rhai");

function alwaysAdvance() {
  return { return_to_dev: false, evidence: "ok" };
}

function bounceOn(phaseName, atCycle = 1) {
  return (phase, cycle) => {
    if (phase === phaseName && cycle === atCycle) {
      return { return_to_dev: true, evidence: `${phase} found a real gap` };
    }
    return { return_to_dev: false, evidence: "ok", merged: phase === "Pipeline monitoring" };
  };
}

test("planning is skipped only when no_plan is true and a plan or ticket exists", () => {
  assert.equal(shouldSkipPlanning({ no_plan: true, ticket: "T-1", task: "x" }), true);
  assert.equal(shouldSkipPlanning({ no_plan: true, plan: "ship it", task: "x" }), true);
  assert.equal(shouldSkipPlanning({ no_plan: true, task: "x" }), false);
  assert.equal(shouldSkipPlanning({ ticket: "T-1", task: "x" }), false);
  assert.equal(shouldSkipPlanning({ no_plan: false, ticket: "T-1", task: "x" }), false);
});

test("planningGateError requires a task and a brief when no_plan is set", () => {
  assert.match(planningGateError({ no_plan: true }), /plan or args\.ticket/);
  assert.match(planningGateError({}), /args\.task/);
  assert.equal(planningGateError({ task: "ship login", no_plan: true, ticket: "T-1" }), null);
});

test("shouldReturnToDevelopment is fail-closed on missing verdicts and fail-closed on empty claims", () => {
  assert.equal(shouldReturnToDevelopment(null), true);
  assert.equal(shouldReturnToDevelopment(undefined), true);
  assert.equal(shouldReturnToDevelopment({ return_to_dev: true, evidence: "  " }), false);
  assert.equal(shouldReturnToDevelopment({ return_to_dev: true, evidence: "tests fail" }), true);
  assert.equal(shouldReturnToDevelopment({ return_to_dev: false, evidence: "ok" }), false);
});

test("happy path walks Planning then Acceptance then every hardening phase once", () => {
  const result = runCycle({
    args: { task: "add export" },
    decide: alwaysAdvance,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.walk, PHASES);
});

test("no_plan plus a ticket omits only Planning", () => {
  const result = runCycle({
    args: { task: "add export", no_plan: true, ticket: "T-9" },
    decide: alwaysAdvance,
  });
  assert.equal(result.walk.includes("Planning"), false);
  assert.equal(result.walk[0], "Acceptance tests");
  assert.deepEqual(result.walk.slice(1), HARDENING_PHASES);
});

test("return from Code review replays Development then every later phase in order", () => {
  const result = runCycle({
    args: { task: "add export", no_plan: true, ticket: "T-9" },
    decide: bounceOn("Code review", 1),
  });
  assert.equal(result.status, "complete");
  assert.equal(walkHasNoSkipReplay(result.walk), true);
  const secondDev = result.walk.indexOf("Development", result.walk.indexOf("Development") + 1);
  assert.deepEqual(result.walk.slice(secondDev, secondDev + HARDENING_PHASES.length), [
    ...HARDENING_PHASES,
  ]);
  assert.equal(result.walk.includes("Acceptance tests", secondDev), false);
});

test("return from Cleaner, Testing, Final QA Review, or Pipeline all restart at Development", () => {
  for (const gate of ["Cleaner", "Testing", "Final QA Review", "Pipeline monitoring"]) {
    const result = runCycle({
      args: { task: "fix", no_plan: true, plan: "existing plan" },
      decide: bounceOn(gate, 1),
    });
    assert.equal(walkHasNoSkipReplay(result.walk), true, gate);
    const secondDev = result.walk.lastIndexOf("Development");
    assert.equal(result.walk[secondDev + 1], "Cleaner", gate);
    assert.equal(result.walk[secondDev + 2], "Testing", gate);
  }
});

test("max-cycle stop fires instead of looping forever", () => {
  const result = runCycle({
    args: { task: "fix", no_plan: true, ticket: "T-1" },
    maxCycles: 2,
    decide: (phase) =>
      phase === "Cleaner"
        ? { return_to_dev: true, evidence: "still messy" }
        : { return_to_dev: false, evidence: "ok" },
  });
  assert.equal(result.status, "stopped");
  assert.equal(result.reason, "max-cycles");
  const developments = result.walk.filter((phase) => phase === "Development").length;
  assert.equal(developments, 2);
  assert.equal(result.walk.includes("Pipeline monitoring"), false);
});

test("a failed gate (null verdict) returns to Development", () => {
  const result = runCycle({
    args: { task: "fix", no_plan: true, ticket: "T-1" },
    decide: (phase, cycle) => {
      if (phase === "Testing" && cycle === 1) {
        return null;
      }
      return { return_to_dev: false, evidence: "ok", merged: true };
    },
  });
  assert.equal(result.walk.filter((phase) => phase === "Development").length, 2);
  assert.equal(walkHasNoSkipReplay(result.walk), true);
});

test("role references stay stack-agnostic and match the named sources", () => {
  const refs = join(root, ".grok", "retemper", "references");
  const architect = readFileSync(join(refs, "architect.md"), "utf8");
  const developer = readFileSync(join(refs, "developer.md"), "utf8");
  const tester = readFileSync(join(refs, "tester.md"), "utf8");
  const reviewer = readFileSync(join(refs, "reviewer.md"), "utf8");
  const finalQa = readFileSync(join(refs, "final-qa.md"), "utf8");

  assert.match(architect, /hexagonal/i);
  assert.match(architect, /grill/i);
  assert.match(architect, /CODING_STANDARDS\.md/);
  assert.doesNotMatch(architect, /React Native/);
  assert.doesNotMatch(architect, /npx nx/);
  assert.doesNotMatch(architect, /Jira/);

  assert.match(developer, /TDD/);
  assert.match(developer, /Clean Code/);
  assert.match(developer, /CODING_STANDARDS\.md/);
  assert.doesNotMatch(developer, /React Native/);
  assert.doesNotMatch(developer, /Jira/);

  assert.match(tester, /Missing tests are blockers/);
  assert.match(reviewer, /Missing tests are blockers/);
  assert.match(finalQa, /acceptance tests/i);
  assert.doesNotMatch(reviewer, /Jira MCP/);
});

test("workflow script declares the same phase titles and the no-skip loop", () => {
  const source = readFileSync(rhaiPath, "utf8");
  for (const title of PHASES) {
    assert.match(source, new RegExp(`title: "${title}"`));
    assert.match(source, new RegExp(`phase\\("${title}"\\)`));
  }
  assert.match(source, /no_plan/);
  assert.match(source, /MAX_CYCLES/);
  assert.match(source, /return_to_dev/);
  assert.match(source, /CODING_STANDARDS\.md/);
  assert.match(source, /grill-me/);
  assert.doesNotMatch(source, /React Native/);
  assert.doesNotMatch(source, /npx nx/);
  assert.doesNotMatch(source, /Jira MCP/);
});
