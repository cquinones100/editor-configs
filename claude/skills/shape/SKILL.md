---
name: shape
description: Shape a Linear ticket with the user. Read the code first, check Linear for tickets that already cover the work, draft the ticket in the team's usual form, and create or update it once the user approves. Hands off to /wt afterwards.
disable-model-invocation: true
---

# Shape

Turn a rough idea into a Linear ticket someone can pick up and build: clear on the problem, grounded in the code as it is, honest about scope. The `shape` command in `bin/` starts a session with this skill; it also works in a session that is already running.

Arguments: a description of the problem or idea, or a Linear ticket ID or URL to refine an existing ticket. With neither, ask what the ticket is about.

## Ground rules

- Read only. Do not edit, create, or delete files in the repository, and do not commit, branch, or push. Shaping ends with a ticket, not a change; `/wt` starts the work.
- Answer what the code can answer yourself. Ask the user about intent, priority, and scope, not about how the code works today.
- Nothing is written to Linear until the user approves a draft.

## Steps

1. **Settle the team.** Read `linearTeam` (a team key such as `ABC`) and `linearLabels` (an array of label names) from `~/.config/worktree-from-ticket/config.json`, the file `wt` already reads its Linear key from. If `linearTeam` is missing, take the team of the ticket being refined, or ask, and suggest adding it to that file. Keep team names and keys out of this repository: it is public.

2. **Learn the team's ticket shape.** Read three or four recent tickets from that team with the Linear connector, preferring ones that were built and closed. Note how they are laid out (headings, acceptance criteria, how much implementation detail) and write the draft the same way. Their conventions win over any layout suggested here.

3. **Understand the problem in the code.** Find where the behaviour lives, how it works now, and what a change would touch. Name the files and functions you looked at, so the draft points at real places. When refining an existing ticket, read it and its comments first, and check whether anything it assumes has changed since it was written.

4. **Look for existing tickets.** Search Linear for open and recently closed tickets that already cover this, overlap with it, or that it depends on. If one already covers it, say so and ask whether to refine that one instead of opening another.

5. **Ask only what is left.** Usually a few questions about intent and scope: what the user wants to be true afterwards, and what is deliberately out. Keep them to what changes the ticket.

6. **Draft.** Show the full ticket: a title that says what changes, the problem, the approach grounded in the code you read, acceptance criteria, and what is out of scope, in the layout from step 2. Note related tickets as links rather than copying them in. Then wait for the user's approval or edits. Revise until they approve.

7. **Write it to Linear.** Create the ticket in the team, with `linearLabels` if set, or update the ticket being refined. Link the related tickets from step 4. Reply with the ticket ID and URL, and offer `/wt <ID>` to start the work in this tab.
