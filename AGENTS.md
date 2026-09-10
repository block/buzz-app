# Contributor instructions for AI agents

Read `docs/contributing.md` for command scope and review conventions.
For interactive product work, default to edit → human tries the running app →
adjust, in the agreed development worktree. Do not gate each feedback round on
E2E, native builds, or full validation. `just iterate` is an optional checkpoint;
reserve `just scan` for an agreed batch before review/integration, or relevant
native/dependency/build changes. Track deferred checks and distinguish **ready to
try** from **validated**. Check safety-critical changes before live use; see the
contribution workflow for exceptions.

Some files are marked with `FOUNDATION` at the top of the file. Do not edit those
files without explicit guidance to do so. If you determine that edits are required
and have not been explicitly requested, escalate the ask to a human before editing.
Foundation files have stricter code review standards.
