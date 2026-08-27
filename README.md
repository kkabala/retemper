# retemper

A project-agnostic **plan → accept → build → harden → review → QA → PR** cycle
for Grok Build, Codex, GitHub Copilot, and Cursor.

- Grok: `/workflow retemper <task>` (or `/retemper`)
- Codex: `$retemper <task>`
- Copilot: `/retemper <task>`
- Cursor: `/retemper <task>` (or type `/` and select **retemper**)

Requires **Node.js 26 or later**. The package declares `"engines": { "node": ">=26" }`
and the CLI exits with that requirement instead of failing inside Node's TypeScript loader.

## Install

```bash
npx retemper install --help
npx retemper install --platform grok --scope user
npx retemper install --platform cursor --scope user
npx retemper install --platform grok,codex,cursor --scope project --target /path/to/repo
npx retemper update
```

From a clone of this repo, `node retemper.ts …` and `node install.ts …` are the same
commands. Dedicated bins `retemper-install` and `retemper-uninstall` stay available.

`--platform` is `grok`, `codex`, `copilot`, or `cursor`. `--scope` is `user` or
`project` (project needs `--target`). `--dry-run` prints the plan and writes
nothing.

Codex, Copilot, and Cursor share the Agent Skills payload in `.agents/skills`:
user installs go to `~/.agents/skills`, and project installs go to
`<repo>/.agents/skills`. Cursor discovers both locations directly, so the
installer does not create a second `.cursor/skills` copy.

The installer includes offline copies of the `grill-me` and `grilling`
dependencies and, unless `--skip-deps` is set, refreshes them with
`npx skills@latest`. Cursor dependency fetches target the same shared
`.agents/skills` tree.

Cursor npm shortcuts are also available from a clone:

```bash
npm run install:user:cursor
npm run install:user:cursor:dry
```

## Uninstall

```bash
npx retemper uninstall                       # --all by default: every recorded install
npx retemper uninstall --dry-run             # list paths, remove nothing, never prompts
npx retemper uninstall --platform grok --scope user
npx retemper uninstall --platform codex --scope project --target /path/to/repo
npx retemper uninstall --all --yes           # skip the y/N prompt (CI)
```

Uninstall accepts the same `--platform` / `--scope` / `--target` grammar as the
installer. With no filters it behaves as `--all`: every install recorded in
`~/.retemper/installs.txt` (`$RETEMPER_HOME/installs.txt`) is selected and the
matching records are dropped after its verified installer-owned entries are
handled.

Every planned path is printed first. Unchanged owned entries are marked
`[present]`; missing, modified, and shared entries are kept and identified in
the plan. Nothing is deleted before you answer **y/yes** at the prompt. Anything
else — including EOF — aborts with no changes. `--yes` skips the prompt;
`--dry-run` never prompts.

Notes:

- `CODING_STANDARDS.md` is never removed.
- Only unchanged files and links recorded in the install ownership manifest are
  removed. Modified files and unowned children are preserved.
- Shared Codex, Copilot, and Cursor files remain until their last recorded owner
  is uninstalled.
- New installs remember their physical destinations, including `$CODEX_HOME`
  compatibility links. A legacy `installs.txt` record is still accepted when
  its destination can be verified safely; otherwise reinstall or update it to
  create ownership metadata before uninstalling.
- Install, update, and uninstall mutations are serialized in `$RETEMPER_HOME`.
  An uninstall prompt is rejected if the recorded state changes while it is
  waiting for confirmation.
- If install or update stops before all ownership manifests and tracking are
  coherent, uninstall fails closed. Rerun the same install or update record set
  to repair and clear the unfinished transaction; an unrelated install cannot
  clear it.
- State locks record their PID, hostname, start time, and owner token. A dead
  same-host owner is recovered automatically. Live, foreign-host, or malformed
  locks are preserved; follow the command's manual-recovery message only after
  verifying that no retemper process is running.
- The manifest expectation digest detects torn or mismatched local state. It is
  not an authentication boundary against another process running as the same
  account.
- Empty folders left behind are pruned; install roots themselves stay.
- Uninstalled records disappear from `installs.txt`; the file is deleted when
  the last record goes.

## Single entry point

One command exposes both directions, matching common npx CLI conventions
(`install` / `uninstall` verbs over a single binary):

```bash
npx retemper install --platform grok --scope user
npx retemper uninstall --all
npx retemper update --dry-run
npx retemper help
```

The dedicated `retemper-install` / `retemper-uninstall` bins stay available.

Clone shortcuts:

```bash
npm run uninstall:all        # interactive --all
npm run uninstall:all:dry
```

## Tests

```bash
npm test
```

GitHub Actions runs that suite on Node 26 and a platform matrix that packs the
npm tarball, then drives `install` → `update` → `uninstall` for grok, codex,
copilot, and cursor against a temp project. The matrix exercises this CLI and
the files it writes. It does not launch the Grok, Codex, Copilot, or Cursor
agent tools (those are not part of install/update/uninstall). Grill upstream
fetch (`npx skills@latest`) is skipped with `--skip-deps`; vendor copies ship
in the package, and a failed fetch currently does not fail the installer.

## Publish

The package is public-ready (`private` is unset). Maintainers publish with a
GitHub Release (tag `v0.1.0` or similar) or **Actions → Publish → Run
workflow**. Both require repository secret `NPM_TOKEN` (an npm automation
token). CI does not publish on push.

Local dry-run of the packed artifact:

```bash
npm pack --dry-run
```

## License

MIT. See [LICENSE](LICENSE).
