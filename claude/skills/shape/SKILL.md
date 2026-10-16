---
name: shape
description: Shape a Linear ticket with the user. Read the code first, check Linear for tickets that already cover the work, draft the ticket in the team's usual form, and create or update it once the user approves. Given an existing ticket, asks whether to run a review loop on it or keep shaping it. Hands off to /wt afterwards.
disable-model-invocation: true
---

# Shape

Turn a rough idea into a Linear ticket someone can pick up and build: clear on the problem, grounded in the code as it is, honest about scope. The `shape` command in `bin/` starts a session with this skill; it also works in a session that is already running.

Arguments: a description of the problem or idea, or a Linear ticket ID or URL (`ABC-123`, or a link with `/issue/ABC-123/` in it) to work on an existing ticket. With neither, ask what the ticket is about. Given a ticket, read it first and then ask what to do with it (see "Given a ticket" below).

## Ground rules

- Read only. Do not edit, create, or delete files in the repository, and do not commit, branch, or push. Shaping ends with a ticket, not a change; `/wt` starts the work.
- Answer what the code can answer yourself. Ask the user about intent, priority, and scope, not about how the code works today.
- Nothing is written to Linear until the user approves a draft.

## Given a ticket

When the argument names an existing ticket, fetch it and its comments with the Linear connector before anything else. If it doesn't exist or can't be read, say so and stop. Then give a two-line summary of where it stands (its title, state, and whether it already has a problem statement, an approach and acceptance criteria) and ask which of these to do, with `AskUserQuestion`:

- **Run a review loop on it.** Hand the ticket to the repository's `/review-loop` skill in ticket mode, which has Codex review the ticket's text against the code as it is (see that skill and its `references/ticket-mode.md`). Use it when the ticket looks ready and you want it checked before anyone builds it. If this repository has no `review-loop` skill, say so and continue shaping instead. When the loop finishes, show its findings and ask whether to fold them into the ticket by continuing below from step 5; nothing is written to Linear without approval, as always.
- **Continue shaping it.** Carry on with the steps below, refining this ticket rather than drafting a new one. Use it when the ticket is still rough, or the user wants to change its scope.

Put the one the ticket's state suggests first, marked as recommended: a review loop for a ticket that already reads as complete, shaping for one that doesn't.

## Steps

1. **Settle the team.** Read `linearTeam` (a team key such as `ABC`) and `linearLabels` (an array of label names) from `~/.config/worktree-from-ticket/config.json`, the file `wt` already reads its Linear key from. If `linearTeam` is missing, take the team of the ticket being refined, or ask, and suggest adding it to that file. Keep team names and keys out of this repository: it is public.

2. **Learn the team's ticket shape.** Read three or four recent tickets from that team with the Linear connector, preferring ones that were built and closed. Note how they are laid out (headings, acceptance criteria, how much implementation detail) and write the draft the same way. Their conventions win over any layout suggested here.

3. **Understand the problem in the code.** Find where the behaviour lives, how it works now, and what a change would touch. Name the files and functions you looked at, so the draft points at real places. When refining an existing ticket, read it and its comments first, and check whether anything it assumes has changed since it was written.

4. **Look for existing tickets.** Search Linear for open and recently closed tickets that already cover this, overlap with it, or that it depends on. If one already covers it, say so and ask whether to refine that one instead of opening another.

5. **Ask only what is left.** Usually a few questions about intent and scope: what the user wants to be true afterwards, and what is deliberately out. Keep them to what changes the ticket.

6. **Draft.** Show the full ticket: a title that says what changes, the problem, the approach grounded in the code you read, acceptance criteria, and what is out of scope, in the layout from step 2. Note related tickets as links rather than copying them in. Then wait for the user's approval or edits. Revise until they approve.

7. **Write it to Linear.** Create the ticket in the team, with `linearLabels` if set, or update the ticket being refined. Link the related tickets from step 4. Reply with the ticket ID and URL, and offer `/wt <ID>` to start the work in this tab.
