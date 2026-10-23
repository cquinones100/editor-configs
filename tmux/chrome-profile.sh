#!/usr/bin/env bash
# Opens the URLs it is given in one Chrome profile, for a command's BROWSER:
# Python's webbrowser module, and so `aws sso login`, runs BROWSER with the URL
# as its argument. A script rather than the open command in BROWSER itself,
# since BROWSER is split like shell words and the spaces in "Google Chrome" and
# in profile directories ("Profile 2") break easily.
#
# Usage: CHROME_PROFILE_DIR="Profile 2" chrome-profile.sh <url>...
#
# The profile is the directory's name under Chrome's user data, as
# chrome://version shows it under "Profile Path"; unset, Chrome picks. Set
# BROWSER to this only for the one command that needs it, never globally:
# other CLIs read it too.

exec open -na "Google Chrome" --args ${CHROME_PROFILE_DIR:+"--profile-directory=$CHROME_PROFILE_DIR"} "$@"
