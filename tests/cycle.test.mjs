import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  HARDENING_PHASES,
  PHASES,
  parseLaunch,
  planningGateError,
  runCycle,
  shouldGrill,
  shouldReturnToDevelopment,
  shouldSkipPlanning,
  shouldUpdateStandards,
  walkHasNoSkipReplay,
} from "../lib/cycle.mjs";
import { planInstall } from "../install.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rhaiPath = join(root, ".grok", "workflows", "retemper.rhai");
const skillPath = join(root, ".agents", "skills", "retemper", "SKILL.md");

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

test("parseLaunch accepts a plain sentence and object fields", () => {
  assert.deepEqual(parseLaunch("Add CSV export").task, "Add CSV export");
  assert.equal(parseLaunch("Add CSV export").grill, true);
  assert.equal(parseLaunch("Add CSV --no-grill --ticket P2-014").grill, false);
  assert.equal(parseLaunch("Add CSV --no-grill --ticket P2-014").ticket, "P2-014");
  assert.equal(parseLaunch({ task: "Add CSV", grill_me: false }).grill, false);
  assert.equal(parseLaunch({ task: "Add CSV", no_grill: true }).grill, false);
  assert.equal(parseLaunch({ task: "Add CSV" }).grill, true);
  assert.equal(parseLaunch("Add CSV --no-standards").update_standards, false);
  assert.equal(parseLaunch({ task: "Add CSV", update_standards: false }).update_standards, false);
  assert.equal(parseLaunch({ task: "Add CSV" }).update_standards, true);
});

test("a provided plan still grills unless grill is turned off", () => {
  assert.equal(shouldGrill({ task: "x", no_plan: true, ticket: "T-1" }), true);
  assert.equal(shouldGrill({ task: "x", plan: "done", grill: false }), false);
  assert.equal(shouldGrill("ship it --no-grill-me"), false);
  assert.equal(shouldSkipPlanning({ task: "x", no_plan: true, ticket: "T-1" }), false);
  assert.equal(shouldSkipPlanning({ task: "x", no_plan: true, ticket: "T-1", grill: false }), true);
  assert.equal(shouldSkipPlanning({ task: "x", ticket: "T-1" }), false);
});

test("planningGateError requires a task; no_plan still needs a brief", () => {
  assert.match(planningGateError({ no_plan: true }), /plan or ticket/);
  assert.match(planningGateError({}), /what to ship/);
  assert.equal(planningGateError("Add CSV export"), null);
  assert.equal(planningGateError({ task: "ship login", no_plan: true, ticket: "T-1" }), null);
});

test("shouldReturnToDevelopment is fail-closed on missing verdicts and fail-closed on empty claims", () => {
  assert.equal(shouldReturnToDevelopment(null), true);
  assert.equal(shouldReturnToDevelopment(undefined), true);
  assert.equal(shouldReturnToDevelopment({ return_to_dev: true, evidence: "  " }), false);
  assert.equal(shouldReturnToDevelopment({ return_to_dev: true, evidence: "tests fail" }), true);
  assert.equal(shouldReturnToDevelopment({ return_to_dev: false, evidence: "ok" }), false);
});

test("happy path walks Planning through Standards", () => {
  const result = runCycle({
    args: "add export",
    decide: alwaysAdvance,
  });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.walk, PHASES);
  assert.equal(result.launch.grill, true);
});

test("no_plan plus a ticket still includes Planning so the plan can be grilled", () => {
  const result = runCycle({
    args: { task: "add export", no_plan: true, ticket: "T-9" },
    decide: alwaysAdvance,
  });
  assert.equal(result.walk[0], "Planning");
  assert.deepEqual(result.walk, PHASES);
});

test("Planning is omitted only when no_plan and grill are both off", () => {
  const result = runCycle({
    args: { task: "add export", no_plan: true, ticket: "T-9", grill: false },
    decide: alwaysAdvance,
  });
  assert.equal(result.walk.includes("Planning"), false);
  assert.equal(result.walk[0], "Acceptance tests");
  assert.ok(result.walk.includes("Standards"));
});

test("--no-standards skips the living CODING_STANDARDS.md step", () => {
  assert.equal(shouldUpdateStandards("add export --no-standards"), false);
  const result = runCycle({
    args: "add export --no-grill --no-plan --ticket T-1 --no-standards",
    decide: alwaysAdvance,
  });
  assert.equal(result.walk.includes("Standards"), false);
  assert.equal(result.launch.update_standards, false);
});

test("return from Code review replays Development then every later phase in order", () => {
  const result = runCycle({
    args: { task: "add export", no_plan: true, ticket: "T-9", grill: false },
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
      args: { task: "fix", no_plan: true, plan: "existing plan", grill: false },
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
    args: { task: "fix", no_plan: true, ticket: "T-1", grill: false },
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
  assert.equal(result.walk.includes("Standards"), false);
});

test("a failed gate (null verdict) returns to Development", () => {
  const result = runCycle({
    args: { task: "fix", no_plan: true, ticket: "T-1", grill: false },
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
  const refs = planInstall({ platform: "grok", scope: "user" }).refsSrc;
  assert.equal(existsSync(refs), true);
  assert.doesNotMatch(refs, /\.grok[/\\]retemper[/\\]references/);
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
  assert.match(finalQa, /skeptic/i);
  assert.match(finalQa, /refute/i);
  assert.match(finalQa, /Do not trust/);
  assert.doesNotMatch(reviewer, /Jira MCP/);

  const pipeline = readFileSync(join(refs, "pipeline.md"), "utf8");
  assert.match(pipeline, /Never invent a green build/);
  assert.match(pipeline, /wait on the real status/i);
  assert.match(pipeline, /gh run watch --exit-status/);
  assert.match(pipeline, /sleep 300/);
  assert.match(pipeline, /Do not set `needs_user` merely because/);
  assert.doesNotMatch(pipeline, /\/workflow resume/);
  assert.doesNotMatch(pipeline, /\$retemper/);
  assert.doesNotMatch(pipeline, /Do not invent a wait by looping, sleeping/);
});

test("Grok workflow and Codex skill both wait on real CI before needs_user", () => {
  const rhai = readFileSync(rhaiPath, "utf8");
  const skill = readFileSync(skillPath, "utf8");

  assert.match(rhai, /wait on its real status until it is terminal/);
  assert.match(rhai, /gh run watch --exit-status/);
  assert.match(rhai, /sleep 300/);
  assert.match(rhai, /Do not set needs_user merely because CI is still running/);
  assert.match(rhai, /await_user/);

  assert.match(skill, /Wait on the \*\*real\*\* CI status/);
  assert.match(skill, /5-minute recheck/);
  assert.match(skill, /Follow `references\/pipeline\.md`/);
  assert.doesNotMatch(skill, /Never busy-loop/);
  assert.doesNotMatch(skill, /\/workflow resume retemper/);
});

test("workflow script declares the same phase titles and the no-skip loop", () => {
  const source = readFileSync(rhaiPath, "utf8");
  for (const title of PHASES) {
    assert.match(source, new RegExp(`title: "${title}"`));
    assert.match(source, new RegExp(`phase\\("${title}"\\)`));
  }
  assert.match(source, /no_plan/);
  assert.match(source, /no-grill/);
  assert.match(source, /MAX_CYCLES/);
  assert.match(source, /return_to_dev/);
  assert.match(source, /CODING_STANDARDS\.md/);
  assert.match(source, /grill-me/);
  assert.match(source, /update_standards/);
  assert.match(source, /wait on its real status until it is terminal/);
  assert.doesNotMatch(source, /React Native/);
  assert.doesNotMatch(source, /npx nx/);
  assert.doesNotMatch(source, /Jira MCP/);
});
