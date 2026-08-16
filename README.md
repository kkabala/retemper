# retemper

A project-agnostic **plan → accept → build → harden → review → QA → PR** cycle.

## Cycle

1. **Planning** — modular, domain-driven, hexagonal / plug-in architecture. Always runs **grill-me**, even if you already have a plan or ticket. Turn grilling off only with `--no-grill` / `grill: false`.
2. **Acceptance tests** — user-facing end-to-end criteria. If they all pass, the task is done from the user’s point of view.
3. **Development** — TDD first, then Clean Code / Clean Coder, SOLID, KISS, YAGNI, DRY.
4. **Cleaner** — same behaviour, cleaner design. May return to Development.
5. **Testing** — cover what TDD and acceptance missed; automate if it was just forgotten. May return to Development.
6. **Code review** — real diff; missing tests are blockers. May return to Development.
7. **Final QA Review** — skeptic of “done”: boot what exists, re-run acceptance, try to break it. May return to Development.
8. **Pipeline monitoring** — open a PR. If CI is still running, **stop** and wait for a human continue; then re-check the real status. Code-caused CI failure returns to Development.
9. **Standards** — update living `CODING_STANDARDS.md` unless you pass `--no-standards`.

Skip writing a *new* architecture plan with `--no-plan` plus a ticket or existing plan. That does **not** skip the grill.

## How to launch

### Grok Build

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

### Codex

Codex has no Grok workflow engine. After a Codex install, mention the skill with `$` (OpenAI’s skill prefix — not `/`), or type `/skills` and pick **retemper**. Saying “retemper …” in plain language also works via implicit matching.

```
$retemper Add CSV export
$retemper Add CSV export --ticket P2-014 --no-plan
$retemper Add CSV export --no-grill
$retemper Add CSV export --no-standards
```

| Intent | Flag | JSON |
| --- | --- | --- |
| Don’t write a new plan (still grill) | `--no-plan` + `--ticket ID` | `no_plan: true`, `ticket` or `plan` |
| Don’t grill | `--no-grill` / `--no-grill-me` | `grill: false` or `grill_me: false` |
| Don’t edit `CODING_STANDARDS.md` | `--no-standards` | `update_standards: false` |

## Waiting on a 15-minute pipeline

Neither harness should invent a green build. Open the PR, check CI once, and if the job is still running, **stop**.

**Grok.** The run **pauses**. When the build finishes, resume:

```
/workflow resume retemper
```

The script then re-checks the real status and merges or returns to Development.

**Codex.** There is no `pause()` / `/workflow resume`. Stop and have the human continue / re-invoke `$retemper` (or `/skills`) after CI, then re-check the real status. Do not busy-loop.

## Living `CODING_STANDARDS.md`

On by default. After a successful run, retemper updates (or creates) `CODING_STANDARDS.md` with conventions this task actually established. Disable with `--no-standards` / `update_standards: false`. A starter file lives in `templates/CODING_STANDARDS.md`.

## Install

User scope (every project):

```bash
node install.mjs --platform grok --scope user
node install.mjs --platform codex --scope user
```

Project scope:

```bash
node install.mjs --platform grok --scope project --target /path/to/repo
node install.mjs --platform codex --scope project --target /path/to/repo
```

```bash
node install.mjs --help
node install.mjs --dry-run --platform grok --scope user
node install.mjs --dry-run --platform codex --scope user
```

Role files live once in `references/` (architect, acceptance, developer, cleaner, tester, reviewer, Final QA skeptic, pipeline, standards). The installer copies that shared tree into each platform’s dest. Grok still installs the `.rhai` workflow under `~/.grok` (or `$GROK_HOME`) / `<repo>/.grok`. Codex still installs an Agent Skill (`SKILL.md` with `name` + `description`) plus grill-me/grilling under `$HOME/.agents/skills` / `<repo>/.agents/skills`. Both then fetch Matt Pocock’s **grill-me** and **grilling** via `npx skills@latest add mattpocock/skills`. Offline copies in `vendor/` are MIT-licensed (Copyright 2026 Matt Pocock) — see `vendor/LICENSE` and `vendor/NOTICE`.

Codex invocation after install is `$retemper` or `/skills`, not `/workflow retemper`.

## Tests

```bash
npm test
```

Claude Code and Copilot are a later port.
