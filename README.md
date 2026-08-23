# retemper

A project-agnostic **plan → accept → build → harden → review → QA → PR** cycle
for Grok Build, Codex, GitHub Copilot, and Cursor.

- Grok: `/workflow retemper <task>` (or `/retemper`)
- Codex: `$retemper <task>`
- Copilot: `/retemper <task>`
- Cursor: `/retemper <task>` (or type `/` and select **retemper**)

## Install

```bash
node install.ts --help
node install.ts --platform grok --scope user
node install.ts --platform cursor --scope user
node install.ts --platform grok,codex,cursor --scope project --target /path/to/repo
node install.ts --update
```

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

Cursor npm shortcuts are also available:

```bash
npm run install:user:cursor
npm run install:user:cursor:dry
```

## Uninstall

```bash
node uninstall.ts                       # --all by default: every recorded install
node uninstall.ts --dry-run             # list paths, remove nothing, never prompts
node uninstall.ts --platform grok --scope user
node uninstall.ts --platform codex --scope project --target /path/to/repo
node uninstall.ts --all --yes           # skip the y/N prompt (CI)
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
node retemper.ts install --platform grok --scope user
node retemper.ts uninstall --all
node retemper.ts update --dry-run
node retemper.ts help
```

When packaged for npx, this becomes `npx retemper install|uninstall|update`;
the dedicated `retemper-install` / `retemper-uninstall` bins stay available.

npm shortcuts:

```bash
npm run uninstall:all        # interactive --all
npm run uninstall:all:dry
```

## Tests

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
