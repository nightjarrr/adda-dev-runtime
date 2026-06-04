#!/usr/bin/env bash
# Purpose: Output a Claude Code status line showing the current issue identity.
# Inputs:  None — reads current issue state from current-issue show.
# Outputs: Two formatted lines (id/title and type/phase/pr) to stdout,
#          or a single dim line when no issue is active.
cat > /dev/null

output="$(/usr/local/libexec/adda-dev-runtime/bin/current-issue show 2>/dev/null)"
id="$(printf '%s' "$output" | jq -r '.issue.id // empty' 2>/dev/null)"

if [[ -z "$id" ]]; then
    printf '\033[2;36m(no current issue)\033[0m\n'
    exit 0
fi

title="$(printf '%s' "$output" | jq -r '.issue.title // empty')"
issue_type="$(printf '%s' "$output" | jq -r '.issue.type // empty')"
phase="$(printf '%s' "$output" | jq -r '.issue.phase // empty')"
state="$(printf '%s' "$output" | jq -r '.issue.state // empty')"
pr="$(printf '%s' "$output" | jq -r '.issue.pr // empty')"

if [[ "$state" == "CLOSED" ]]; then
    printf '\033[1;36m#%s\033[0m \033[2;36m[CLOSED]\033[0m \033[1;36m%s\033[0m\n' "$id" "$title"
else
    printf '\033[1;36m#%s\033[0m \033[1;36m%s\033[0m\n' "$id" "$title"
fi

if [[ -n "$pr" ]]; then
    printf '\033[38;5;238m%s  %s  PR #%s\033[0m\n' "$issue_type" "$phase" "$pr"
else
    printf '\033[38;5;238m%s  %s\033[0m\n' "$issue_type" "$phase"
fi
