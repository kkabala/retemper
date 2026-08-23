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

## Tests

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
