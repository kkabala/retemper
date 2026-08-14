# Pipeline monitoring (language-agnostic)

Final QA has approved. Now open a change request and respect real CI.

## Do

1. Create a branch if needed, commit only this task’s work, open a pull request (or the repo’s equivalent) with a one-line purpose.
2. Detect whether a pipeline exists (`gh`, the host’s CI files, or the repo docs).
3. If CI is green, merge using the repo’s normal method.
4. If CI failed because of **code**, set `return_to_dev` with the failing job and the first real error.
5. If there is no pipeline, or CI is still running, or merge needs a human, set `needs_user` and do not merge.

Never wait by sleeping. Never invent a green build. Never merge on silence.
