#!/usr/bin/env bash
# Logs in to AWS IAM Identity Center (`aws sso login`), from the M-A popup,
# opening the login page in a chosen Chrome profile rather than whichever
# Chrome window is in front. The popup stays open until the login finishes, so
# the verification code and any error can be read, then waits for a key.
#
# No profile is named: it logs in to the one [sso-session] in ~/.aws/config,
# which covers every profile that uses it. Logging in through a profile that
# has its own sso_start_url instead is cached apart and doesn't cover those.
# With several sessions, it says which there are rather than guess.
#
# Which Chrome profile is yours, not this public repository's: it is read from
# ~/.config/aws-login/config, a line chrome_profile=<a Chrome profile
# directory, such as Profile 2>; without one, Chrome picks.

dim=$'\033[2m' red=$'\033[31m' green=$'\033[32m' reset=$'\033[0m'
config=~/.config/aws-login/config

done_with() {
  printf '\n  %s\n\n  %sPress any key to close.%s' "$1" "$dim" "$reset"
  read -rsn 1
  exit 0
}

chrome_profile=$(sed -n 's/^chrome_profile=//p' "$config" 2>/dev/null | tail -n 1)
command -v aws >/dev/null 2>&1 || done_with "${red}aws isn't on the PATH.${reset} Install it with: brew install awscli"

sessions=$(sed -n 's/^\[sso-session \(.*\)\]$/\1/p' ~/.aws/config 2>/dev/null)
case $(printf '%s' "$sessions" | grep -c .) in
  0) done_with "${red}There is no [sso-session] in ~/.aws/config.${reset}" ;;
  1) ;;
  *) done_with "${red}There are several SSO sessions in ~/.aws/config:${reset} $(printf '%s' "$sessions" | paste -sd ' ' -)" ;;
esac

printf '\n  %sLogging in to %s...%s\n\n' "$dim" "$sessions" "$reset"
# BROWSER for this command alone (see chrome-profile.sh).
if BROWSER=~/.config/tmux/chrome-profile.sh CHROME_PROFILE_DIR=$chrome_profile aws sso login --sso-session "$sessions"; then
  done_with "${green}Logged in.${reset}"
else
  done_with "${red}The login failed.${reset}"
fi
