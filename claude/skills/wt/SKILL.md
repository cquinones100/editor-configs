---
name: wt
description: Replace this Claude session with `wt <ticket>` in the same tmux pane, so the ticket's worktree opens in this tab with a fresh Claude session working on it. For the end of a ticket-shaping conversation.
argument-hint: "[ticket ID or URL]"
disable-model-invocation: true
---

# wt

Hand this tab over to `wt` for a Linear ticket. This session ends, and in its place `wt` creates the ticket's worktree, moves the pane's shell into it, and starts a new Claude session there with the usual ticket prompt. Because the pane itself now runs from the worktree, tmux sees that directory: splits, new tabs, the tab name, and the status line all follow it, which a `cd` from inside this session could never do.

The conversation does not carry over. The ticket is the hand-off, and the new session starts by reading it.

Usually run with no argument: the ticket comes from this session. A Linear ticket ID or URL may be passed instead, and then it wins.

## Steps

1. Work out the ticket ID.

   - **Passed as an argument:** use it. Accept a Linear URL and take the ID from its `/issue/<ID>/` part.
   - **No argument:** take the first of these that gives an answer, and do not ask for an ID:
     1. A ticket this session created or saved through Linear. If it saved more than one, the most recent.
     2. The one ticket ID (`ABC-123`) the conversation centered on.
     3. The current branch, from the first line of `git status --porcelain --branch` (`## <branch>`, then `...<upstream>` if it has one; a detached HEAD has no branch), when it starts with a ticket ID such as `abc-123-…`; uppercase it.

     If the answer is a guess between several tickets (more than one saved, or a conversation about two or three), name the most likely one and ask the user to confirm it before going on. Ask which ticket outright only when none of the three gives anything.

   Whichever way it was found, check the ID has the shape `ABC-123`. Anything else is not a ticket ID: say so and stop. The ID is placed into a shell command below, so nothing else may go in.

2. Check that this session is running in tmux: `$TMUX_PANE` must be set. If it is not, there is no pane to hand over. Tell the user to run `wt <ID>` themselves and stop.

3. Clear the tab's name, whether `shape` set it ("Shaping: …") or the user did with "Rename the tab" in M-p:

   ```
   tmux set-option -wu -t "$TMUX_PANE" @tab_name
   ```

   A tab working on a ticket is named for it: once the worktree opens, `wt` renames the tabs, and with no name set this one takes the ticket ID and title from the worktree's branch (`tmux/tab-label.sh`), the same name every other ticket tab has.

4. Say, in one line, that this session is handing the tab to `wt <ID>`. That line is the last thing the user will see from this session, so put nothing after it.

5. Run this as your final action, on its own, with the ID filled in:

   ```
   tmux respawn-pane -k -t "$TMUX_PANE" -c "$PWD" "zsh -i -c 'wt <ID>; exec zsh -i'"
   ```

   `-k` stops this session, and the new command starts in the same pane. `zsh -i` reads `~/.zshrc`, which defines `wt` and puts node on the PATH. `-c "$PWD"` starts it in this directory, so `wt` finds the same repository. When the new Claude session exits, or if `wt` refuses (a closed ticket it asks about, or a worktree another session is already working in), `exec zsh -i` leaves a shell in the pane: in the worktree if `wt` got that far, here otherwise.

Run each tmux command above as a separate, plain command, not chained or wrapped in shell logic. The user's settings allow exactly these two by name (`tmux set-option -wu`, `tmux respawn-pane`), and a compound command would not match those rules and would be stopped for approval.

Do not run anything after the respawn. It ends this session, so there is nothing to report and no one to report it to.
