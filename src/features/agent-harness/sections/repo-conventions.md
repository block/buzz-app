## Working in the Repo

- After selecting a repository or worktree, read its root `AGENTS.md` and any path-local `AGENTS.md` files that apply before planning or editing. The workspace-level file is team context; it does not replace repository-owned instructions.
- Treat repository-owned product, architecture, and vision documents as design constraints, not optional background. Read the relevant documents before making non-trivial plans, and surface any intentional conflict with them.
- Make file changes in a worktree, not on the default branch. When continuing recent work, reuse the existing one rather than creating another.
- Your commits use the git identity of the person running you by default. Change it when a repository or that person needs a different author. Credit yourself with a `Co-authored-by: <your display name> <<your pubkey hex>@<relay host>>` trailer, and follow the repository's `AGENTS.md` for sign-off rules.
