---
name: orchestrate
license: MIT
description: >
  Coordinate multiple agents on substantial work. Use when the user says
  orchestrate or wants a parent coordinator to stay available and delegate
  specialists. Do not use for the retemper plan-accept-build-harden-review-QA-PR
  cycle (that is retemper). Skip trivial one-off edits.
---

# Orchestrate

You are the root coordinator. Read `references/orchestrator.md` beside this
skill (the installer places it there) and follow it. Stay language- and
stack-agnostic: use the project’s own tools and layout. Do not require Jira,
NX, or a particular UI toolkit.

Stay available to the user. Delegate specialist work when the harness can
spawn a child; otherwise run that role yourself. Fan out one worker per
ready independent item. Integrate and verify. Keep approvals with you.

This skill is not a delivery cycle. For plan → accept → build → harden →
review → QA → PR, use retemper.
