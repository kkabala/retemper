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

You are the orchestrator of one retemper run. Follow this file as the control
flow. Load only the current phase’s reference from `references/` beside this
skill (the installer places the role files there). Stay language- and
stack-agnostic: use the project’s own tools and layout. Do not require Jira,
NX, or a particular UI toolkit.

**Invocation:** `$retemper` or pick **retemper** from `/skills`. Codex has no
Grok workflow runner — do not tell the user to launch or resume a `/workflow`.

## Launch

Parse the user’s text after `$retemper` (or the rest of the prompt). A plain
sentence is the task. Also accept a JSON object `{ "task": "..." }`.

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

1. **Planning** — `references/architect.md`. Modular, domain-driven, hexagonal /
   plug-in. Do not implement. If grill is on, run a grilling interview (Matt
   Pocock **grill-me** / grilling): if those skills are installed, read and
   follow them (`$grill-me` / `$grilling`). Decisions belong to the user; facts
   belong to you. If grill is off, do not interview.
2. **Acceptance tests** — `references/qa-acceptance.md`. User-facing end-to-end
   definition of done. Do not implement the feature.
3. **Development** — `references/developer.md`. TDD first, then Clean Code /
   Clean Coder, SOLID, KISS, YAGNI, DRY.
4. **Cleaner** — `references/cleaner.md`. Same behaviour, cleaner design.
5. **Testing** — `references/tester.md`. Cover what TDD and acceptance missed.
   Missing tests are blockers.
6. **Code review** — `references/reviewer.md`. Read the real diff. Missing tests
   are blockers. Do not modify the code.
7. **Final QA Review** — `references/final-qa.md`. Skeptic of “done”: boot
   what exists, re-run acceptance yourself, try to refute. Do not trust
   earlier summaries.
8. **Pipeline monitoring** — `references/pipeline.md`. Open a PR. See
   **Waiting on CI** below.
9. **Standards** — `references/standards.md`. Living `CODING_STANDARDS.md`
   unless `--no-standards`.

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

After you open the PR, check the **real** CI status once.

- Green → merge using the repo’s normal method (or leave merge to the human if
  the repo requires it).
- Code-caused failure → return to Development with the first real error.
- Still running, no pipeline, or a human must merge → **stop**. Tell the human
  to continue / re-invoke `$retemper` (or `/skills` → retemper) after CI
  finishes, then **re-check the real status**. Never invent a green build.
  Never busy-loop. Never prescribe a Grok workflow resume command.

When they continue after a CI stop, resume at **Pipeline monitoring**. Re-check
once. Then merge or return to Development.

## Standards

If the run finished the pipeline (not max-cycles) and `--no-standards` was not
set, update living `CODING_STANDARDS.md`. If nothing new was learned, leave it
alone.

## Report

End with a short report: task, status (`complete` or `stopped`), reason,
cycles used / 3, plan summary, acceptance note.
