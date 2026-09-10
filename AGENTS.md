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

## Commit attribution and DCO

Every PR commit requires a `Signed-off-by` trailer. Use `git commit --signoff`
with your verified effective Git identity (`git config user.name` and
`git config user.email`); stop if that identity is missing or incorrect.
Preserve actual authorship. Do not substitute the requesting human's identity
or add their sign-off merely because they requested or reviewed the work.

DCO sign-off is separate from cryptographic signing and co-author credit;
formatting hooks do not supply it. Before pushing, audit **every commit in the
PR range against its base**, not just HEAD, including after rebases and
cherry-picks. Preserve valid existing trailers and add only certifications you
can make. After a repair, verify the hosted **DCO Check** at the new PR head.

## Before pushing

- Use the agreed feature worktree and the pinned `bin/` tools. Install hooks
  once per worktree with `bin/pnpm hooks:install` after
  `bin/pnpm install --frozen-lockfile`; preserve custom hooks and do not bypass
  failures. See [hook scope and setup](docs/contributing.md#pre-commit-checks).
- Confirm the destination remote, PR base, and head branch; refresh remote refs
  before publishing. Review `git status`, the full PR diff, and
  `git diff --check` against the PR base. Include only intended files, with no
  credentials, local configuration, or raw agent/session data. Audit all commit
  identities and DCO trailers as described above.
- Follow the [validation workflow](docs/contributing.md#interactive-product-iteration):
  focused checks during iteration; one `bin/just scan` at the agreed batch gate
  before review/integration. Documentation-only follow-ups need content, link,
  and diff checks, not a repeat source build. Keep incomplete work in a draft PR
  with deferred checks listed; do not label a draft push as validated. Hook
  success alone does not establish types, tests, builds, or DCO success.
- Push to the PR's actual head ref. Do not rewrite others' commits; an authorized
  rewrite must use `--force-with-lease`, never plain force. Confirm the remote PR
  head matches the commit whose checks you report.
- Inspect the current hosted checks and repository rules, including externally
  installed checks not represented in `.github/workflows`. Resolve relevant
  failures before declaring readiness; obtain required reviewer/code-owner
  approval. These instructions are a manual preflight, not an installed
  pre-push hook or automatic permission to merge.
