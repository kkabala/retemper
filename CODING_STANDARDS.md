# Coding standards

Living document. Retemper reads this file every run and, by default, updates
it at the end with conventions this task actually established.
Disable that with `--no-standards` / `update_standards: false`.

Keep this file short. Put only rules a stranger would miss.

## Language and runtime

- Node ESM (`"type": "module"`). Run tests with `npm test` (`node --test tests/*.test.mjs`).
- No extra runtime dependencies; the installer stays on Node built-ins.

## Layout

- `install.mjs` is the install/update CLI. `lib/cycle.mjs` is the cycle. Do not dump one-off helpers into `lib/` unless they are a second idea.
- Destinations this machine has already installed into live in `~/.retemper/installs.txt` (or `$RETEMPER_HOME/installs.txt`), not in the clone.
- Role files live once in `references/`. The installer copies that tree into each platform dest. Do not fork platform-specific copies in source.
- Thin skills live under `.agents/skills/<name>/SKILL.md`. Extra skills (`orchestrate`, grill-me) are first-class dests — do not stuff them into the `vendorSkills` / `skillDests` parallel arrays used for grill vendor copies.
- Grill upstream fetch is one `npx skills add` per skill folder (`mattpocock/skills/skills/productivity/grill-me` and `…/grilling`). Do not add the whole `mattpocock/skills` repo: the CLI parses every `SKILL.md` and skips siblings whose unquoted `description:` contains `: `.
- `--platform` is a list: commas, spaces after one flag, or a repeated flag. Names stay unique in the given order. An unknown name fails before any dest is written.

## Orchestration

- Compute bands are `fast`, `standard`, and `deep`. Shared files never name vendor model slugs.
- `references/orchestrator.md` is generic: it fans out one worker per ready independent item and must not name cycle roles. The retemper phase list, band map, and which specialist each phase spawns live in `lib/cycle.mjs` (`PHASES`, `PHASE_BANDS`), the retemper skill, and the Grok workflow. Keep those three aligned.
- Skill-path parents announce each phase and stop; a visible child verdict is required; Grok’s control plane is the registered workflow.

## Tests

- Test behaviour, not implementation.
- Installer CLI tests that apply or update must set `RETEMPER_HOME` to a temp dir so they never write the real `~/.retemper`.
- Grok user-scope CLI tests must also set `GROK_HOME` to a temp dir. Skill user-scope CLI tests must set `AGENTS_HOME` and `CODEX_HOME` to temp dirs. Do not write into the real `~/.agents` or `~/.codex` from tests.
- Skill user-scope payload stays under `~/.agents/skills`. Codex CLI user discovery is `$CODEX_HOME/skills` (default `~/.codex/skills`): symlink the skill folders there after the copy. Project-scope `<repo>/.agents/skills` is enough for Codex.

## Style

- Prefer small, well-named functions over comments.
- Follow the existing file’s shape before inventing a new one.

## Definition of done

- Acceptance tests describe the user-facing bar.
- If they pass and Final QA cannot break the work, the task is done.
