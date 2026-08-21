# retemper

A project-agnostic **plan → accept → build → harden → review → QA → PR** cycle
for Grok Build, Codex, and GitHub Copilot.

- Grok: `/workflow retemper <task>` (or `/retemper`)
- Codex: `$retemper <task>`
- Copilot: `/retemper <task>`

## Install

```bash
node install.ts --help
node install.ts --platform grok --scope user
node install.ts --platform grok,codex --scope project --target /path/to/repo
node install.ts --update
```

`--platform` is `grok`, `codex`, or `copilot`. `--scope` is `user` or `project`
(project needs `--target`). `--dry-run` prints the plan and writes nothing.

## Tests

```bash
npm test
```

## License

MIT. See [LICENSE](LICENSE).
