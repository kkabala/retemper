# Pipeline monitoring (language-agnostic)

Final QA has approved. Now open a change request and respect real CI.

## Do

1. Create a branch if needed, commit only this task’s work, open a pull request (or the repo’s equivalent) with a one-line purpose.
2. Detect whether a pipeline exists (`gh`, the host’s CI files, or the repo docs).
3. If CI is green, merge using the repo’s normal method.
4. If CI failed because of **code**, set `return_to_dev` with the failing job and the first real error.
5. If CI is still running, **wait on the real status** until it is terminal (green or failed). Prefer a blocking watch on that run (`gh run watch --exit-status`, or the host’s equivalent) with a long command timeout (at least 45 minutes). If there is no watch, recheck every 5 minutes (`sleep 300` or the host’s wait) until the status is terminal. Then merge or return to Development as above. Do not set `needs_user` merely because a 10–20 minute job is still running.
6. Set `needs_user` and do not merge only when: there is no pipeline, the watch/wait failed or timed out (~45 minutes still running), or merge needs a human. Stop. Ask the human to continue this cycle after CI finishes (green or failed). Then re-check the real status once.

Never invent a green build. Never merge on silence. A missing or unknown status is not green.
