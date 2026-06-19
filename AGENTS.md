# Grantry Codex Instructions

For implementation work in this repository, a task is not complete until the scoped change is on `origin/main`, unless the user explicitly asks for local-only, branch-only, or PR-only work.

Default completion flow:

1. Make the scoped change.
2. Run `npm run check`.
3. Run `git diff --check`.
4. Commit only the intended files.
5. Push with `git push origin HEAD:main`.
6. Verify `git ls-remote origin refs/heads/main` points at the pushed commit.
7. In the final response, report the commit hash and state that `origin/main` was updated.

Do not treat edits, local validation, a feature-branch commit, or a direct deploy as done. If the current worktree has unrelated changes or cannot switch to `main`, use a clean temporary worktree based on `origin/main` and apply only the intended files.
