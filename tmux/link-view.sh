#!/usr/bin/env bash
# A link read in a pane to the right, as the PR (M-v) and ticket (M-i) views
# show theirs, rather than in the browser: a GitHub pull request as the PR
# view lays it out, a Linear ticket as the ticket view does, a Notion page or
# Google Doc as Claude's connector gives it (lib/link-view.js doc), and any
# other web page as its main text in Markdown (lib/link-view.js), drawn by glow and paged
# with less. A Slack message can't be read without Claude's connector, so its
# pane only offers to open it. M-p's "Open the link being read in the
# browser" opens it, in the Chrome profile its host is given
# (tmux/open-url.sh); q closes the pane.
#
# Usage:
#   link-view.sh pick <pane>         M-p: choose a link shown in <pane>, with fzf;
#                                    Enter reads it beside the pane, Ctrl-O opens
#                                    it in the browser
#   link-view.sh open <pane> <url>   read <url> in a pane beside <pane>
#   link-view.sh show <url>          in that pane: read it
#   link-view.sh browser <pane>      open the link read in <pane>'s window
#
# The pane carries @link_view and the link in @link_url. It runs under an
# interactive zsh, for the PATH (gh, glow, node) the tmux server lacks, and a
# link goes into that command line only when it has nothing but a URL's
# characters, no quote among them.

set -u
here=${0%/*}
repo=${SWITCHBOARD_DIR:-$HOME/switchboard}
safe='^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$'

case "${1:-}" in
  pick)
    pane=${2:-}
    [ -n "$pane" ] || exit 0
    # Every link in what the pane shows and has scrolled past, newest first, a
    # line each: what fzf shows, a tab, the URL. A link written into text (an
    # OSC 8 hyperlink, kept by capture-pane -e) shows its text before its URL.
    # perl, not node: popups have no nvm.
    links=$(tmux capture-pane -p -e -J -S -3000 -t "$pane" | perl -CSD -ne '
      s/\e\[[0-9;:?<=>]*[ -\/]*[@-~]//g;
      while (m{\e\]8;[^;\e\a]*;([^\e\a]*)(?:\e\\|\a)(.*?)\e\]8;[^;\e\a]*;(?:\e\\|\a)|(https?://[A-Za-z0-9._~:/?#\@!\$&()*+,;=%-]+)}g) {
        if (defined $3) { (my $url = $3) =~ s/[.,;:!?)]+$//; push @found, [$url, ""]; next }
        my ($url, $text) = ($1, $2);
        $text =~ s/\e[^\\]*\\?//g; $text =~ s/[\x00-\x1f]+/ /g; $text =~ s/\s+/ /g; $text =~ s/^ | $//g;
        push @found, [$url, $text eq $url ? "" : $text] if $url =~ m{^https?://[A-Za-z0-9._~:/?#\@!\$&()*+,;=%-]+$};
      }
      END {
        my (%text, %seen, @order);
        for (reverse @found) {
          my ($url, $text) = @$_;
          push @order, $url unless $seen{$url}++;
          $text{$url} //= $text if length $text;
        }
        for (@order) {
          my $text = $text{$_} // "";
          $text = substr($text, 0, 57) . "..." if length $text > 60;
          print length $text ? "$text  \e[38;5;244m$_\e[0m\t$_\n" : "$_\t$_\n";
        }
      }')
    if [ -z "$links" ]; then
      tmux display-message "No links in this pane"
      exit 0
    fi
    choice=$(printf '%s\n' "$links" | fzf --ansi --delimiter '\t' --with-nth 1 --prompt 'Read: ' --header 'Enter reads it beside the pane · Ctrl-O opens it in the browser' --expect ctrl-o --layout reverse) || exit 0
    key=$(printf '%s' "$choice" | sed -n 1p)
    url=$(printf '%s' "$choice" | sed -n 2p | cut -f2)
    [ -n "$url" ] || exit 0
    if [ "$key" = ctrl-o ]; then exec "$here/open-url.sh" "$url"; fi
    exec "$0" open "$pane" "$url"
    ;;

  open)
    pane=${2:-} url=${3:-}
    [[ -n $pane && $url =~ $safe ]] || { tmux display-message "That isn't a link that can be read here"; exit 0; }
    # The window's link view, if it has one, gives way to this one.
    old=$(tmux list-panes -t "$pane" -F '#{pane_id} #{@link_view}' | awk '$2 == "1" { print $1; exit }')
    [ -n "$old" ] && tmux kill-pane -t "$old"
    dir=$(tmux display -p -t "$pane" '#{pane_current_path}')
    view=$(tmux split-window -h -l 50% -t "$pane" -c "${dir//\#/##}" -P -F '#{pane_id}' "zsh -i -c '$here/link-view.sh show $url'") || exit 0
    tmux set-option -p -t "$view" @link_view 1
    tmux set-option -p -t "$view" @link_url "$url"
    ;;

  show)
    url=${2:-}
    dim=$'\e[38;5;244m' red=$'\e[31m' reset=$'\e[0m'
    wait_key() {
      printf '\n  %s\n\n  %sPress any key to close.%s' "$1" "$dim" "$reset"
      read -rsn 1
      exit 0
    }
    [[ $url =~ $safe ]] || wait_key "${red}That isn't a link that can be read here.${reset}"
    command -v glow >/dev/null || wait_key "${red}glow isn't installed.${reset} Install it with: brew install glow"
    # A Linear ticket: the ticket view.
    if [[ $url =~ ^https://linear\.app/[^/]+/issue/([A-Za-z][A-Za-z0-9]*-[0-9]+) ]]; then
      exec "$here/ticket-view.sh" show "$(printf '%s' "${BASH_REMATCH[1]}" | tr 'a-z' 'A-Z')"
    fi
    # Slack: only Claude's connector reads it.
    if [[ $url =~ ^https://[^/]*slack\.com/ ]]; then
      printf '\n  A Slack message can'"'"'t be read here, only in Slack.\n\n  %so opens it in the browser · any other key closes%s' "$dim" "$reset"
      read -rsn 1 key
      [ "$key" = o ] && "$here/open-url.sh" "$url"
      exit 0
    fi
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    # A GitHub pull request: the PR view's layout.
    if [[ $url =~ ^https://github\.com/[^/]+/[^/]+/pull/[0-9]+ ]]; then
      printf '\n  %sReading the PR...%s' "$dim" "$reset"
      gh pr view "${BASH_REMATCH[0]}" --json number,title,url,state,isDraft,author,baseRefName,headRefName,body > "$work/pr.json" 2>/dev/null ||
        wait_key "${red}GitHub won't show that PR${reset} (gh)."
      "$here/pr-view.sh" page prepare "$work/pr.json" "$work"
      exit 0
    fi
    # A Notion page, Google Doc or Slides deck: through Claude's connectors,
    # unless the link_view_docs setting is off.
    if [[ $url =~ ^https://([a-z0-9-]+\.)?notion\.(so|site|com)/|^https://docs\.google\.com/(document|presentation)/d/ ]] &&
      [ "$(tmux show -gqv @setting_link_view_docs 2>/dev/null)" != off ]; then
      printf '\n  %sReading it through Claude'"'"'s connector...%s' "$dim" "$reset"
      why=$(node "$repo/lib/link-view.js" doc "$url" "$work/page.md" 2>&1 >/dev/null) ||
        wait_key "${red}Couldn't read it:${reset} ${why:-no answer}. M-p's \"Open the link being read in the browser\" opens it there."
      "$here/pr-view.sh" page page "$work/page.md" "$work"
      exit 0
    fi
    # Any other page: its main text, as Markdown.
    printf '\n  %sReading %s...%s' "$dim" "$url" "$reset"
    why=$(node "$repo/lib/link-view.js" page "$url" "$work/page.md" 2>&1 >/dev/null) ||
      wait_key "${red}Couldn't read it:${reset} ${why:-no answer}. M-p's \"Open the link being read in the browser\" opens it there."
    "$here/pr-view.sh" page page "$work/page.md" "$work"
    ;;

  browser)
    pane=${2:-}
    url=$(tmux list-panes -t "$pane" -F '#{@link_view} #{@link_url}' | awk '$1 == "1" { print $2; exit }')
    [ -n "$url" ] || { tmux display-message "No link is being read in this tab"; exit 0; }
    exec "$here/open-url.sh" "$url"
    ;;

  *)
    echo "Usage: $0 pick <pane> | open <pane> <url> | show <url> | browser <pane>" >&2
    exit 1
    ;;
esac
exit 0
