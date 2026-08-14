# retemper

A project-agnostic **plan → accept → build → harden → review → QA → PR** cycle.

## Cycle

1. **Planning** — modular, domain-driven, hexagonal / plug-in architecture. Always runs **grill-me**, even if you already have a plan or ticket. Turn grilling off only with `--no-grill` / `grill: false`.
2. **Acceptance tests** — user-facing end-to-end criteria. If they all pass, the task is done from the user’s point of view.
3. **Development** — TDD first, then Clean Code / Clean Coder, SOLID, KISS, YAGNI, DRY.
4. **Cleaner** — same behaviour, cleaner design. May return to Development.
5. **Testing** — cover what TDD and acceptance missed; automate if it was just forgotten. May return to Development.
6. **Code review** — real diff; missing tests are blockers. May return to Development.
7. **Final QA Review** — boot what exists, re-run acceptance tests, try to break it. May return to Development.
8. **Pipeline monitoring** — open a PR. If CI needs 15 minutes, the run **pauses**; you resume it when the build is done. Code-caused CI failure returns to Development.
9. **Standards** — update living `CODING_STANDARDS.md` unless you pass `--no-standards`.

Skip writing a *new* architecture plan with `--no-plan` plus a ticket or existing plan. That does **not** skip the grill.

## How to launch

JSON objects are what Grok’s `/workflow` docs show. You do **not** have to use them.

Plain sentence (preferred):

```
/workflow retemper Add CSV export
```

Same thing with flags:

```
/workflow retemper Add CSV export --ticket P2-014 --no-plan
/workflow retemper Add CSV export --no-grill
/workflow retemper Add CSV export --no-standards
```

JSON still works, if you want it:

```
/workflow retemper {"task":"Add CSV export","ticket":"P2-014","no_plan":true}
/workflow retemper {"task":"Add CSV export","grill":false}
/workflow retemper {"task":"Add CSV export","update_standards":false}
```

`/retemper` is the same workflow once it is installed in `~/.grok/workflows/`.

| Intent | Flag | JSON |
| --- | --- | --- |
| Don’t write a new plan (still grill) | `--no-plan` + `--ticket ID` | `no_plan: true`, `ticket` or `plan` |
| Don’t grill | `--no-grill` / `--no-grill-me` | `grill: false` or `grill_me: false` |
| Don’t edit `CODING_STANDARDS.md` | `--no-standards` | `update_standards: false` |

## Waiting on a 15-minute pipeline

Grok workflows cannot `sleep()`. The Pipeline phase opens the PR, checks CI once, and if the job is still running it **pauses the run**. When the build finishes, resume:

```
/workflow resume retemper
```

The script then re-checks the real status and merges or returns to Development. That is the wait.

## Living `CODING_STANDARDS.md`

On by default. After a successful run, retemper updates (or creates) `CODING_STANDARDS.md` with conventions this task actually established. Disable with `--no-standards` / `update_standards: false`. A starter file lives in `templates/CODING_STANDARDS.md`.

## Install

Grok Build only for now. User scope (every project):

```bash
node install.mjs --platform grok --scope user
```

Project scope:

```bash
node install.mjs --platform grok --scope project --target /path/to/repo
```

```bash
node install.mjs --help
node install.mjs --dry-run --platform grok --scope user
```

The installer copies the workflow and role references, then fetches Matt Pocock’s **grill-me** and **grilling** via `npx skills@latest add mattpocock/skills`. Offline copies in `vendor/` are MIT-licensed (Copyright 2026 Matt Pocock) — see `vendor/LICENSE` and `vendor/NOTICE`.

## Tests

```bash
npm test
```

Other harnesses (Codex, Claude Code, Copilot) are a later port. This package only fills the `.grok` slot.
