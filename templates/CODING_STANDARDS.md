# Coding standards

Living document. Retemper reads this file every run and, by default, updates
it at the end with conventions the work actually established.
Disable that with `--no-standards` / `update_standards: false`.

Keep this file short. Put only rules a stranger would miss.

## Language and runtime

- (e.g. language version, package manager, how to install)

## Layout

- (where new modules go; what must not become a dumping ground)

## Tests

- (how to run unit / acceptance / e2e)
- Test behaviour, not implementation.

## Style

- Prefer small, well-named functions over comments.
- Follow the existing file’s shape before inventing a new one.

## Definition of done

- Acceptance tests describe the user-facing bar.
- If they pass and Final QA cannot break the work, the task is done.
