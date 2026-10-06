#!/bin/bash
# Keeps Claude from getting around git hooks: no `git commit --no-verify` (or
# its short form -n), and no changing core.hooksPath, which would switch a
# repository's hooks off. editor-configs relies on its pre-commit hook to keep
# machine-specific Claude settings out of commits. Reading the setting is fine.
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
if [[ -z "$CMD" ]]; then
  exit 0
fi
# Global options before the subcommand, including the ones that take a value (git -C <path> commit).
VALUE='("[^"]*"|'\''[^'\'']*'\''|\S+)'
OPTION="(-[Cc]\s+${VALUE}|--(git-dir|work-tree|namespace|config-env|exec-path)\s+${VALUE}|-\S+)"
GIT="(^|;|&&|\|\||\|)\s*git\s+(${OPTION}\s+)*"
# Quoted strings are dropped first, so a commit message that mentions -n or
# --no-verify is not mistaken for the flag. Only the first line is read, which
# leaves out the body of a heredoc message.
LINE=$(echo "$CMD" | head -1 | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")
if echo "$LINE" | grep -qE "${GIT}commit\b" &&
  echo "$LINE" | grep -qE '\s(--no-verify|-[a-zA-Z]*n[a-zA-Z]*)(\s|$)'; then
  echo "Do not skip git hooks with --no-verify or -n. If a hook refuses the commit, fix what it reports." >&2
  exit 2
fi
if echo "$CMD" | grep -qiE '(^|;|&&|\|\||\|)\s*git\s+(\S+\s+)*-c\s*core\.hooksPath' ||
  { echo "$CMD" | grep -qE "${GIT}config\b.*core\.hooksPath" &&
    ! echo "$CMD" | grep -qE "${GIT}config\s+(--(get|get-all|list)|-l)\b"; }; then
  echo "Do not change core.hooksPath; it decides whether a repository's git hooks run." >&2
  exit 2
fi
exit 0
