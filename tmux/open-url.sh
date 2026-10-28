#!/usr/bin/env bash
# Opens a URL in the browser, in the Chrome profile its host is given, for the
# links Switchboard opens (the link view, mission control's menus): the
# profile for a host is in ~/.config/switchboard/browser.json, {"hosts":
# {"linear.app": "Profile 2", "slack.com": "Profile 2"}}, a host matching
# itself and its subdomains, which is yours and never in this repository. A
# host it doesn't name, GitHub among them unless you name it, opens with
# `open`, in the default browser and profile.
#
# Usage: open-url.sh <url>

set -u
url=${1:-}
[[ $url =~ ^https?:// ]] || exit 1
host=$(printf '%s' "$url" | sed -E 's#^https?://([^/:?]+).*#\1#' | tr 'A-Z' 'a-z')
# jq, not node: this also runs from popups, whose PATH has no nvm.
profile=$(jq -r --arg h "$host" '(.hosts // {}) | to_entries | map(select(.key as $k | $h == $k or ($h | endswith("." + $k)))) | sort_by(-(.key | length)) | .[0].value // empty' "$HOME/.config/switchboard/browser.json" 2>/dev/null)
if [ -n "$profile" ]; then
  CHROME_PROFILE_DIR=$profile exec "${0%/*}/chrome-profile.sh" "$url"
fi
exec open "$url"
