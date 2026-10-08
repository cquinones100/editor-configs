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

3. Say, in one line, that this session is handing the tab to `wt <ID>`. That line is the last thing the user will see from this session, so put nothing after it.

4. Run this as your final action, with the ID filled in:

   ```
   case "$(tmux show -wqv -t "$TMUX_PANE" @tab_name)" in "Shaping: "*) tmux set -wu -t "$TMUX_PANE" @tab_name ;; esac
   tmux respawn-pane -k -t "$TMUX_PANE" -c "$PWD" "zsh -i -c 'wt <ID>; exec zsh -i'"
   ```

   The first line drops the "Shaping: ..." name the `shape` command gave the tab, so it takes the ticket's title once the worktree opens. A name you set yourself with M-n is left alone. `-k` stops this session, and the new command starts in the same pane. `zsh -i` reads `~/.zshrc`, which defines `wt` and puts node on the PATH. `-c "$PWD"` starts it in this directory, so `wt` finds the same repository. When the new Claude session exits, or if `wt` refuses (a closed ticket it asks about, or a worktree another session is already working in), `exec zsh -i` leaves a shell in the pane: in the worktree if `wt` got that far, here otherwise.

Do not run anything after it. The command ends this session, so there is nothing to report and no one to report it to.
