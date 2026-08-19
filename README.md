# retemper

A project-agnostic **plan → accept → build → harden → review → QA → PR** cycle
for **Grok Build**, **Codex**, and **GitHub Copilot**.

| Platform | What you install | How you launch |
| --- | --- | --- |
| Grok Build | `.rhai` workflow + `orchestrate` skill | `/workflow retemper …` (or `/retemper`) |
| Codex | Agent Skills (`retemper`, `orchestrate`) | `$retemper …` or pick **retemper** from `/skills` |
| GitHub Copilot | same Agent Skills | `/retemper …` or pick **retemper** from `/skills` |

**Grok:** the control plane is `/workflow retemper`. When that workflow is available, do **not** walk `.agents/skills/retemper/SKILL.md` or simulate the cycle in chat. Codex stays `$retemper`; Copilot stays `/retemper`.

Codex and Copilot share one shipped skill: `.agents/skills/retemper/`. The installer writes that tree under `.agents/skills` (user or project). Codex CLI user discovery is `$CODEX_HOME/skills` (default `~/.codex/skills`), so a user-scope install also **symlinks** `retemper`, `orchestrate`, `grill-me`, and `grilling` there. There is no second copy under `.github/skills` or `~/.copilot/skills`.

## Cycle

1. **Planning** — modular, domain-driven, hexagonal / plug-in architecture. Always runs **grill-me**, even if you already have a plan or ticket. Turn grilling off only with `--no-grill` / `grill: false`. After Planning, wait for an **explicit proceed** before Acceptance tests. Answering grill questions is not proceed.
2. **Acceptance tests** — user-facing end-to-end criteria. If they all pass, the task is done from the user’s point of view.
3. **Development** — TDD first, then Clean Code / Clean Coder, SOLID, KISS, YAGNI, DRY.
4. **Cleaner** — same behaviour, cleaner design. May return to Development.
5. **Testing** — cover what TDD and acceptance missed; automate if it was just forgotten. May return to Development.
6. **Code review** — real diff; missing tests are blockers. May return to Development.
7. **Final QA Review** — skeptic of “done”: boot what exists, re-run acceptance, try to break it. May return to Development.
8. **Pipeline monitoring** — open a PR and leave it **unmerged** by default. Invoking the cycle licenses specialist commits. Merge only if the user asked to merge and CI is really green. Wait on real CI until it is terminal. If you cannot wait, **stop** and wait for a human continue; then re-check the real status. Code-caused CI failure returns to Development.
9. **Standards** — update living `CODING_STANDARDS.md` unless you pass `--no-standards`.

Skip writing a *new* architecture plan with `--no-plan` plus a ticket or existing plan. That does **not** skip the grill.

## How to launch

### Grok Build

When `/workflow retemper` is available, launch it and **stop**. Do not simulate the cycle in-chat with the retemper skill.

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

```
$retemper Add CSV export
$retemper Add CSV export --ticket P2-014 --no-plan
$retemper Add CSV export --no-grill
$retemper Add CSV export --no-standards
```

### GitHub Copilot

```
/retemper Add CSV export
/retemper Add CSV export --ticket P2-014 --no-plan
/retemper Add CSV export --no-grill
/retemper Add CSV export --no-standards
```

On Codex and Copilot (skill-path), the parent announces each phase and **stops**. A visible child verdict is required before the next phase.

### Shared flags

| Intent | Flag | JSON |
| --- | --- | --- |
| Don’t write a new plan (still grill) | `--no-plan` + `--ticket ID` or `--plan …` | `no_plan: true`, `ticket` or `plan` |
| Don’t grill | `--no-grill` / `--no-grill-me` | `grill: false` or `grill_me: false` |
| Don’t edit `CODING_STANDARDS.md` | `--no-standards` | `update_standards: false` |

`--ticket=ID` and `--plan=…` are the same as the spaced forms.

## Waiting on a pipeline

No harness should invent a green build. Open the PR and leave it **unmerged** unless the user asked to merge. **Wait on the real CI status** (blocking watch, or a 5-minute recheck) until it is terminal. Merge only if the user asked to merge **and** CI is really green; otherwise leave the PR open or return to Development.

If there is no pipeline, the wait fails or times out, or merge needs a human, **stop**.

**Grok.** The run **pauses**. When you can continue, resume:

```
/workflow resume retemper
```

The script then re-checks the real status. It merges only if the user asked to merge and CI is really green; otherwise it leaves the PR unmerged or returns to Development.

**Codex.** There is no `pause()` / `/workflow resume`. Continue / re-invoke `$retemper` (or `/skills`) after CI, then re-check the real status.

**Copilot.** Same as Codex — no `pause()` / `/workflow resume`. Continue / re-invoke `/retemper` (or `/skills`) after CI, then re-check the real status.

## Living `CODING_STANDARDS.md`

On by default. After a successful run, retemper updates (or creates) `CODING_STANDARDS.md` with conventions this task actually established. Disable with `--no-standards` / `update_standards: false`. A starter file lives in `templates/CODING_STANDARDS.md`.

## Install

Role files live once in `references/` (orchestrator, architect, acceptance, developer, cleaner, tester, reviewer, Final QA skeptic, pipeline, standards). The installer copies that tree next to each payload, and also installs a thin `orchestrate` skill that loads `orchestrator.md` for non-cycle work.

| Platform | User scope | Project scope | Payload |
| --- | --- | --- | --- |
| Grok | `~/.grok` (or `$GROK_HOME`) | `<repo>/.grok` | `.grok/workflows/retemper.rhai`, `retemper/references/`, `.grok/skills/orchestrate/` |
| Codex / Copilot | `~/.agents/skills` (or `$AGENTS_HOME/skills`); Codex CLI also `$CODEX_HOME/skills` (symlink) | `<repo>/.agents/skills` | `retemper/SKILL.md`, `retemper/references/`, `orchestrate/` |

`--platform copilot` and `--platform codex` write the same dests. Installing one is enough for both skill-based harnesses. Official Copilot roots also include `.github/skills` and `~/.copilot/skills`; this installer does **not** duplicate the tree there.

User scope (every project):

```bash
node install.mjs --platform grok --scope user
node install.mjs --platform codex --scope user
node install.mjs --platform copilot --scope user
node install.mjs --platform grok,codex --scope user
node install.mjs --platform grok --platform copilot --scope user
```

`--platform` takes one or more names. Repeat the flag, separate with commas, or put spaces after one `--platform`. Names are de-duplicated in the order given. `--update` still ignores `--platform` and uses the tracking file.

Project scope:

```bash
node install.mjs --platform grok --scope project --target /path/to/repo
node install.mjs --platform grok,codex --scope project --target /path/to/repo
node install.mjs --platform copilot --scope project --target /path/to/repo
```

```bash
node install.mjs --help
node install.mjs --dry-run --platform grok --scope user
node install.mjs --dry-run --platform copilot --scope user
node install.mjs --platform grok --scope project --target /path/to/repo --standards
node install.mjs --platform copilot --scope user --skip-deps
```

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Print the plan; write nothing; no network |
| `--skip-deps` | Do not fetch Matt Pocock grill-me / grilling (vendor copies only) |
| `--standards` | Copy `templates/CODING_STANDARDS.md` into the project root if missing |
| `--update` | Re-apply the current payload to every destination recorded on this machine |

Every successful (non-dry-run) install appends or updates a line in `~/.retemper/installs.txt` (`$RETEMPER_HOME/installs.txt` if set). Each line is `platform scope path`: user scope stores the Grok or Codex home, project scope stores the repo root.

### Update

```bash
node install.mjs --update
node install.mjs --update --dry-run
node install.mjs --update --skip-deps
npm run update
npm run update:dry
```

`--update` does not take `--platform` or `--scope`. It reads the tracking file and refreshes every grok/codex user and project dest recorded there.

If `installs.txt` is missing, the installer prints that path, shows the same `--platform` / `--scope` / `--target` flags as a first install, and exits without writing anything. Run a normal install once so the file exists, then `--update` again.

`--dry-run` prints the planned dests and does not copy files or edit the tracking file. A recorded project path that no longer exists is skipped and, unless you passed `--dry-run`, removed from the file.

npm shortcuts:

```bash
npm run install:user            # grok, user scope
npm run install:user:codex      # shared skill → ~/.agents/skills
npm run install:user:copilot    # same dest as install:user:codex
npm run install:user:dry
npm run install:user:codex:dry
npm run install:user:copilot:dry
npm run update
npm run update:dry
```

Every platform then fetches Matt Pocock’s **grill-me** and **grilling** via `npx skills@latest add mattpocock/skills/skills/productivity/<skill>` with `--agent grok` (Grok dests) or `--agent cline` (`.agents/skills` dests). Without `--agent`, `-y --global` also asks PromptScript to install, and PromptScript has no global dest. Adding the whole catalog would make the skills CLI parse every `SKILL.md`; several siblings have unquoted `description:` values with `: ` and are skipped with YAML parse errors. Offline copies in `vendor/` are MIT-licensed (Copyright 2026 Matt Pocock) — see `vendor/LICENSE` and `vendor/NOTICE`.

Codex invocation after install is `$retemper` or `/skills`, not `/workflow retemper`. Copilot invocation is `/retemper` or `/skills`.

## Tests

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
