---
name: retemper
license: MIT
description: >
  Run the retemper cycle — Planning, Acceptance tests, Development, Cleaner,
  Testing, Code review, Final QA Review, Pipeline monitoring, and Standards —
  with grill-by-default and no skipped gates after Development. Use when the
  user says retemper, $retemper, or wants a plan-accept-build-harden-review-QA-PR
  loop. Do not use for a one-off edit that should skip this cycle.
---

# Retemper

You are the orchestrator of one retemper run. First read and follow
`references/orchestrator.md` beside this skill (the installer places the role
files there). Then follow this file as the cycle control flow. Load only the
current phase’s reference from `references/` while you walk. Stay language-
and stack-agnostic: use the project’s own tools and layout. Do not require
Jira, NX, or a particular UI toolkit.

When the harness can spawn a child, dispatch that phase’s specialist(s) at
the phase’s compute band. Follow `references/orchestrator.md` for fan-out:
one worker per ready, independent item; dependent items wait for the next
wave. This file names which specialist that is. Otherwise run the role
yourself. Tell leaf workers not to spawn.

**Invocation:** `$retemper` (Codex), `/retemper` (GitHub Copilot), or pick
**retemper** from `/skills`. Codex and Copilot have no Grok workflow runner —
do not tell the user to launch or resume a `/workflow`.

## Launch

Parse the user’s text after `$retemper` or `/retemper` (or the rest of the
prompt). A plain sentence is the task. Also accept a JSON object `{ "task": "..." }`.

| Intent | Flag | JSON |
| --- | --- | --- |
| Don’t write a new plan (still grill) | `--no-plan` plus `--ticket ID` or `--plan …` | `no_plan: true` plus `ticket` or `plan` |
| Don’t grill | `--no-grill` / `--no-grill-me` | `grill: false` or `grill_me: false` |
| Don’t edit `CODING_STANDARDS.md` | `--no-standards` | `update_standards: false` |

`--ticket=ID` and `--plan=…` are the same as the spaced forms.

Grill is **on** by default. A provided plan or ticket is still grilled unless
`--no-grill` / `--no-grill-me` is set.

If there is no task sentence and no `{ "task": "..." }`, stop and ask what to
ship.

If `--no-plan` / `no_plan` is set and there is neither a ticket nor an existing
plan, stop and ask for one.

## When to omit Planning

Skip the whole **Planning** phase only when all three are true: `no_plan`, a
brief (`--ticket` / `--plan` or those JSON fields), and grill is off. Otherwise
Planning runs.

## Phase order

Walk these titles in order. Do not rename them. Read the named reference for
the phase you are in; do not load every reference up front.

1. **Planning** — `references/architect.md` — compute band **deep**. Modular,
   domain-driven, hexagonal / plug-in. Do not implement. One architect.
   The plan must list work items (`id`, summary, `depends_on`, writable
   scope). The architect proposes grill questions in its payload. You
   synthesize and ask (Matt Pocock **grill-me** / grilling if those skills
   are installed: `$grill-me` / `$grilling` on Codex, `/grill-me` /
   `/grilling` on Copilot). Decisions belong to the user; facts belong to
   you. If grill is off, do not interview.
2. **Acceptance tests** — `references/qa-acceptance.md` — compute band **standard**.
   User-facing end-to-end definition of done. Do not implement the feature.
   One acceptance author unless that work itself partitions.
3. **Development** — `references/developer.md` — compute band **standard**.
   TDD first, then Clean Code / Clean Coder, SOLID, KISS, YAGNI, DRY.
   Spawn **one developer per ready plan item** in the same parallel batch
   when items have no remaining `depends_on` and disjoint writable scopes.
   Then the next wave. Do not fold independent items into one developer
   when you can spawn. A return-to-Development fix is one developer
   unless the bounce itself lists independent items.
4. **Cleaner** — `references/cleaner.md` — compute band **standard**. Same
   behaviour, cleaner design.
5. **Testing** — `references/tester.md` — compute band **standard**. Cover
   what TDD and acceptance missed. Missing tests are blockers.
6. **Code review** — `references/reviewer.md` — compute band **deep**. Read
   the real diff. Missing tests are blockers. Do not modify the code.
7. **Final QA Review** — `references/final-qa.md` — compute band **deep**.
   Skeptic of “done”: boot what exists, re-run acceptance yourself, try to
   refute. Do not trust earlier summaries.
8. **Pipeline monitoring** — `references/pipeline.md` — compute band **standard**.
   Open a PR. See **Waiting on CI** below.
9. **Standards** — `references/standards.md` — compute band **standard**.
   Living `CODING_STANDARDS.md` unless `--no-standards`.

If this repo has `CODING_STANDARDS.md` at the root, follow it in every phase.
If it does not, continue.

## Hardening loop

Phases **Development** through **Pipeline monitoring** are the hardening
sequence.

After Development, **Cleaner**, **Testing**, **Code review**, **Final QA Review**,
and **Pipeline monitoring** are return gates.

Record a verdict object:

```
{ return_to_dev, reason, evidence, summary, needs_user, merged }
```

Fail closed: a missing or unusable verdict is a return to **Development**.
A `return_to_dev: true` claim with empty evidence is **not** a return.

On a real return: go back to **Development** and replay every later hardening
phase in order with **no-skip replay**. Do not skip Cleaner, Testing, Code
review, Final QA Review, or Pipeline monitoring. Do not re-run Planning or
Acceptance tests.

Cap at **3** cycles. If a return would start a fourth Development, **max-cycles**
stop. Do not run Standards after a max-cycles stop.

## Waiting on CI

Follow `references/pipeline.md`. Wait on the **real** CI status (blocking
watch, or a 5-minute recheck) until it is terminal, then merge or return to
Development. Never invent a green build. Never prescribe a Grok workflow
resume command.

Set `needs_user` only when pipeline.md says to (no pipeline, wait failed or
timed out, or merge needs a human). Then **stop**. Tell the human to continue /
re-invoke `$retemper` (Codex), `/retemper` (Copilot), or `/skills` → retemper
after CI finishes, then **re-check the real status**.

When they continue after a CI stop, resume at **Pipeline monitoring**. Re-check
once. Then merge or return to Development.

## Standards

If the run finished the pipeline (not max-cycles) and `--no-standards` was not
set, update living `CODING_STANDARDS.md`. If nothing new was learned, leave it
alone.

## Report

End with a short report: task, status (`complete` or `stopped`), reason,
cycles used / 3, plan summary, acceptance note.
