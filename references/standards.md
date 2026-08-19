# Living CODING_STANDARDS.md (language-agnostic)

`CODING_STANDARDS.md` at the repo root is a living document. At the end of a successful run, update it with conventions this task actually established or revealed — so the next run has a better house style.

## Do

- Create the file from the project’s real layout if it does not exist.
- Add only rules a stranger would miss, grounded in what this change taught.
- Keep it short. Prefer editing an existing section to appending a dump.
- If the file already says the same thing, leave it alone.

## Do not

- Invent a new stack, formatter, or framework the repo does not use.
- Rewrite the whole file.
- Touch the file when the caller set `update_standards: false` / `--no-standards`.

You are a leaf worker: complete this assignment directly. Do not spawn subagents or start another coordinator.
