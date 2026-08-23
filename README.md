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
`~/.retemper/installs.txt` (`$RETEMPER_HOME/installs.txt`) is removed and the
matching records are dropped.

Every planned path is printed first, marked `[present]` or `[missing]`; nothing
is deleted before you answer **y/yes** at the prompt. Anything else — including
EOF — aborts with no changes. `--yes` skips the prompt; `--dry-run` never prompts.

Notes:

- `CODING_STANDARDS.md` is never removed.
- `grill-me`, `grilling`, and `orchestrate`, installed alongside retemper, are
  removed with it — including `$CODEX_HOME/skills` symlinks for user scope.
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
