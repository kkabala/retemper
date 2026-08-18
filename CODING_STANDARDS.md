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

## Tests

- Test behaviour, not implementation.
- Installer CLI tests that apply or update must set `RETEMPER_HOME` to a temp dir so they never write the real `~/.retemper`.
- Grok user-scope CLI tests must also set `GROK_HOME` to a temp dir. Do not write into the real `~/.agents` from tests.

## Style

- Prefer small, well-named functions over comments.
- Follow the existing file’s shape before inventing a new one.

## Definition of done

- Acceptance tests describe the user-facing bar.
- If they pass and Final QA cannot break the work, the task is done.
