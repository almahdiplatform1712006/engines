# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in [`almahdiplatform1712006/engines`](https://github.com/almahdiplatform1712006/engines). Use the [`gh`](https://cli.github.com/) CLI. Where `gh` isn't installed, the GitHub MCP tools (`issue_read`, `issue_write`, `add_issue_comment`, `sub_issue_write`, `create_pull_request`, …) do the same jobs.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc or `--body-file` for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`. Use `--json title,body,comments,labels` for machine-readable output.
- **List issues**: `gh issue list --json number,title,labels` with appropriate `--label` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close**: `gh issue close <number> --comment "..."` (the closing comment is optional).
- **Pull requests**: `gh pr create`, `gh pr view`, `gh pr comment`, etc. PRs target `main`, and CI runs on every PR.

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## The spec and its tickets

Issue #1 is the spec. Tickets E-01 … E-22 are GitHub **sub-issues** of #1 and link to its sections (§1 … §10). Each ticket has a **Blocked by** section listing the tickets it waits on.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external pull requests as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --json number,title,author,authorAssociation`, then keep only PRs whose author is not a member/owner (a contributor's PR, not a maintainer's in-flight work).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub numbers issues and PRs from the same sequence, so `#42` is unambiguous.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: a native sub-issue of the map with labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: a `Blocked by: #<n>, #<n>` line (or section) in the child's body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's sub-issues, drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue close <n> --comment "<answer>"`, then append a context pointer (gist + link) to the map's Decisions-so-far.
