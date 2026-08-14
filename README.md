# retemper

A project-agnostic **plan → accept → build → harden → review → QA → PR** cycle.

The conductor is a [Grok Build](https://grok.x.ai) workflow: a program, not a prompt. Later phases never skip after Development. A return from Cleaner, Testing, Review, Final QA, or a code-caused pipeline failure goes back to Development and replays every later phase in order.

Named after re-tempering steel — heat, quench, inspect, repeat — not after “workflow-dev”.

## Cycle

1. **Planning** — modular, domain-driven, hexagonal / plug-in architecture. Runs a [grill-me](https://github.com/mattpocock/skills) / grilling interview unless you already have a plan or ticket.
2. **Acceptance tests** — user-facing end-to-end criteria. If they all pass, the task is done from the user’s point of view.
3. **Development** — TDD first, then Clean Code / Clean Coder, SOLID, KISS, YAGNI, DRY.
4. **Cleaner** — same behaviour, cleaner design. May return to Development.
5. **Testing** — cover what TDD and acceptance missed; automate if it was just forgotten. May return to Development.
6. **Code review** — real diff; missing tests are blockers. May return to Development.
7. **Final QA Review** — boot what exists, re-run acceptance tests, try to break it. May return to Development.
8. **Pipeline monitoring** — open a PR, merge only on a real green signal. Code-caused CI failure returns to Development.

Planning is the only legal skip: `no_plan=true` **and** a `plan` or `ticket`.

## Install

Grok Build only for now. User scope (every project):

```bash
node install.mjs --platform grok --scope user
```

Project scope (this repo only):

```bash
node install.mjs --platform grok --scope project --target /path/to/repo
```

See the plan without writing files or hitting the network:

```bash
node install.mjs --help
node install.mjs --dry-run --platform grok --scope user
```

The installer copies the workflow and role references, then fetches Matt Pocock’s **grill-me** (and the **grilling** primitive it requires) via `npx skills@latest add mattpocock/skills`. Vendor copies ship in `vendor/` for offline fallback.

Add `--standards` on a project install to copy `templates/CODING_STANDARDS.md` to the repo root if that file is missing.

## Run

```
/retemper
```

or

```
/workflow retemper
```

```json
{ "task": "Add CSV export for completed sessions" }
```

Skip planning when you already have the brief:

```json
{ "task": "Add CSV export", "no_plan": true, "ticket": "P2-014" }
```

Optional: `plan` (text or path), `focus`, `ticket`.

## Extending a project

Drop a `CODING_STANDARDS.md` at the repo root. Every role reads it when present and ignores it when absent. A starter lives in `templates/CODING_STANDARDS.md`.

Role playbooks live in `.grok/retemper/references/` (or `~/.grok/retemper/references/` for a user install). Edit those — do not paste stack-specific ceremony into the workflow script.

## Layout

```
.grok/workflows/retemper.rhai     Grok conductor
.grok/retemper/references/        language-agnostic roles
lib/cycle.mjs                     shipped control-flow helpers
install.mjs                       platform + scope + grill-me
vendor/grill-me grilling          offline copies of the interview skills
templates/CODING_STANDARDS.md     optional project hook
```

## Tests

```bash
npm test
```

Other harnesses (Codex, Claude Code, Copilot) are a later port. This package only fills the `.grok` slot.
