# review-loop

A Claude Code skill that has Codex review the current branch, fixes what it
finds, commits, and reviews again until two consecutive rounds come back clean.
`SKILL.md` is the skill itself; this file is what you need to run it somewhere
else.

## What it depends on

- **`codex-review`** on your `PATH`. It is a single Node script that runs Codex
  non-interactively as a read-only reviewer and prints the findings as JSON.
  The source is
  [`bin/codex-review`](https://github.com/cquinones100/editor-configs/blob/main/bin/codex-review)
  in this repository. Download it, make it executable, and put it on your
  `PATH`, for example in `~/.local/bin`.
- **Node** 18 or newer, for the script.
- **`codex`**, the OpenAI Codex CLI, logged in (`codex login`). `codex exec`
  uses the same login as the interactive tool.
- **`gh`**, the GitHub CLI, logged in. The script uses it to fetch the PR title,
  body, and base branch so Codex never needs GitHub access of its own.

## Install the skill

Copy this directory to `~/.claude/skills/review-loop/` so that
`~/.claude/skills/review-loop/SKILL.md` exists. Claude Code picks it up on the
next session, and `/review-loop` invokes it.

## What Codex is allowed to do

The script runs Codex with the read-only sandbox, no approval path out of it,
your Codex configuration ignored so no MCP servers or plugins load, and only
core environment variables visible to the commands it runs. Contributor-written
text such as the PR description is fenced in the prompt as data, not
instructions. No per-repository trust step is needed.

## Using it

In a Claude Code session on a branch that is ready for review, type
`/review-loop`. Add `all` to also act on low-severity findings from the first
round. The skill commits per round, records disputed findings and accepted
known gaps in a notes file it passes back to Codex, stops after two consecutive
clean rounds or five rounds, and asks before pushing.

`codex-review` can also be run by hand for a one-off second opinion. Run
`codex-review --help` for the flags.
