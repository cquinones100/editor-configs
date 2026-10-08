---
name: wt
description: Replace this Claude session with `wt <ticket>` in the same tmux pane, so the ticket's worktree opens in this tab with a fresh Claude session working on it. For the end of a ticket-shaping conversation.
disable-model-invocation: true
---

# wt

Hand this tab over to `wt` for a Linear ticket. This session ends, and in its place `wt` creates the ticket's worktree, moves the pane's shell into it, and starts a new Claude session there with the usual ticket prompt. Because the pane itself now runs from the worktree, tmux sees that directory: splits, new tabs, the tab name, and the status line all follow it, which a `cd` from inside this session could never do.

The conversation does not carry over. The ticket is the hand-off, and the new session starts by reading it.

Arguments: a Linear ticket ID or URL. Without one, use the ticket this conversation produced or settled on. If there is no such ticket, or more than one candidate, ask which before doing anything.

## Steps

1. Work out the ticket ID, as above, and check it has the shape `ABC-123`. Accept a Linear URL and take the ID from its `/issue/<ID>/` part. Anything else is not a ticket ID: say so and stop. The ID is placed into a shell command below, so nothing else may go in.

2. Check that this session is running in tmux: `$TMUX_PANE` must be set. If it is not, there is no pane to hand over. Tell the user to run `wt <ID>` themselves and stop.

3. Read the tab's name, as its own command:

   ```
   tmux show-options -wqv -t "$TMUX_PANE" @tab_name
   ```

   If it starts with `Shaping: `, the name the `shape` command gave the tab, clear it so the tab takes the ticket's title once the worktree opens:

   ```
   tmux set-option -wu -t "$TMUX_PANE" @tab_name
   ```

   Leave any other name alone: the user set it with M-n.

4. Say, in one line, that this session is handing the tab to `wt <ID>`. That line is the last thing the user will see from this session, so put nothing after it.

5. Run this as your final action, on its own, with the ID filled in:

   ```
   tmux respawn-pane -k -t "$TMUX_PANE" -c "$PWD" "zsh -i -c 'wt <ID>; exec zsh -i'"
   ```

   `-k` stops this session, and the new command starts in the same pane. `zsh -i` reads `~/.zshrc`, which defines `wt` and puts node on the PATH. `-c "$PWD"` starts it in this directory, so `wt` finds the same repository. When the new Claude session exits, or if `wt` refuses (a closed ticket it asks about, or a worktree another session is already working in), `exec zsh -i` leaves a shell in the pane: in the worktree if `wt` got that far, here otherwise.

Run each tmux command above as a separate, plain command, not chained or wrapped in shell logic. The user's settings allow exactly these three by name (`tmux show-options`, `tmux set-option -wu`, `tmux respawn-pane`), and a compound command would not match those rules and would be stopped for approval.

Do not run anything after the respawn. It ends this session, so there is nothing to report and no one to report it to.
