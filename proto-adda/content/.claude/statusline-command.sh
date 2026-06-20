#!/usr/bin/env bash
# Purpose: Output a Claude Code status line showing the current issue identity
#          with right-aligned model/effort/context-usage info.
# Inputs:  JSON payload on stdin from Claude Code.
# Outputs: Two formatted lines (id/title+ctx and type/phase/pr) to stdout,
#          or a single dim line when no issue is active.

stdin_json="$(cat)"

model_name="$(printf '%s' "$stdin_json" | jq -r '.model.display_name // empty' 2>/dev/null)"
effort="$(printf '%s' "$stdin_json" | jq -r '.effort.level // empty' 2>/dev/null)"
ctx_pct="$(printf '%s' "$stdin_json" | jq -r 'if .context_window.used_percentage then (.context_window.used_percentage | round | tostring) else empty end' 2>/dev/null)"

# Build right-side: model/effort part (always dark) + ctx part (colored by threshold)
if [[ -n "$effort" ]]; then
    model_part="${model_name} (${effort})"
else
    model_part="${model_name}"
fi
ctx_sep=""
ctx_pct_part=""
if [[ -n "$ctx_pct" ]]; then
    ctx_sep=" / "
    ctx_pct_part="${ctx_pct}% ctx"
fi
ctx_right="${model_part}${ctx_sep}${ctx_pct_part}"

# ctx part color: bold red if ctx_pct >= threshold (only when threshold env var is set), dark grey otherwise
if [[ -n "$ctx_pct" && -n "$ADDA_STATUSLINE_CTX_RED_THRESHOLD" ]] \
    && awk -v pct="$ctx_pct" -v thr="$ADDA_STATUSLINE_CTX_RED_THRESHOLD" \
           'BEGIN { exit !(pct >= thr) }'; then
    ctx_part_color='\033[1;31m'
else
    ctx_part_color='\033[1;38;5;238m'
fi

output="$(/usr/local/libexec/adda-dev-runtime/bin/current-issue show 2>/dev/null)"
id="$(printf '%s' "$output" | jq -r '.result.issue.id // empty' 2>/dev/null)"

if [[ -z "$id" ]]; then
    no_issue_text="(no current issue)"
    cols=$(( ${COLUMNS:-80} - 5 ))
    pad=$(( cols - ${#no_issue_text} - ${#ctx_right} ))
    if [[ -n "$ctx_right" && $pad -ge 2 ]]; then
        printf '\033[2;36m%s\033[0m%*s\033[1;38;5;238m%s%s'"${ctx_part_color}"'%s\033[0m\n' \
            "$no_issue_text" "$pad" "" "$model_part" "$ctx_sep" "$ctx_pct_part"
    else
        printf '\033[2;36m%s\033[0m\n' "$no_issue_text"
    fi
    exit 0
fi

title="$(printf '%s' "$output" | jq -r '.result.issue.title // empty')"
issue_type="$(printf '%s' "$output" | jq -r '.result.issue.type // empty')"
phase="$(printf '%s' "$output" | jq -r '.result.issue.phase // empty')"
state="$(printf '%s' "$output" | jq -r '.result.issue.state // empty')"
pr="$(printf '%s' "$output" | jq -r '.result.issue.pr // empty')"
owner="$(printf '%s' "$output" | jq -r '.result.issue.owner // empty')"
repo="$(printf '%s' "$output" | jq -r '.result.issue.repo // empty')"

# Line 1: #id title (type, phase, PR #n)
if [[ -n "$pr" ]]; then
    meta="(${issue_type}, ${phase}, PR #${pr})"
else
    meta="(${issue_type}, ${phase})"
fi

# Dynamic title truncation: title gets whatever cols remain after #id and meta
cols=$(( $(tput cols 2>/dev/null || echo "${COLUMNS:-80}") - 5 ))
if [[ "$state" == "closed" ]]; then
    id_overhead=$(( 1 + ${#id} + 1 + 9 ))
else
    id_overhead=$(( 1 + ${#id} + 1 ))
fi
max_left=$(( cols * 2 / 3 ))
title_max=$(( max_left - id_overhead - 2 - ${#meta} ))
[[ $title_max -lt 15 ]] && title_max=15
if [[ ${#title} -gt $title_max ]]; then
    title="${title:0:$(( title_max - 1 ))}…"
fi

# Compute left-side visible length (no ANSI codes)
if [[ "$state" == "closed" ]]; then
    left_len=$(( 1 + ${#id} + 1 + 8 + 1 + ${#title} + 1 + ${#meta} ))
else
    left_len=$(( 1 + ${#id} + 1 + ${#title} + 1 + ${#meta} ))
fi

# Right-align: pad between left content and right info
pad=$(( cols - left_len - ${#ctx_right} ))

# If there's not enough room, suppress the right side rather than overflow
if [[ $pad -lt 2 ]]; then
    ctx_right=""
fi

if [[ "$state" == "closed" ]]; then
    left_part="$(printf '\033[1;36m#%s\033[0m \033[2;36m[CLOSED]\033[0m \033[1;36m%s\033[0m \033[38;5;238m%s\033[0m' "$id" "$title" "$meta")"
else
    left_part="$(printf '\033[1;36m#%s\033[0m \033[1;36m%s\033[0m \033[38;5;238m%s\033[0m' "$id" "$title" "$meta")"
fi

if [[ -n "$ctx_right" ]]; then
    printf '%s%*s\033[1;38;5;238m%s%s'"${ctx_part_color}"'%s\033[0m\n' \
        "$left_part" "$pad" "" "$model_part" "$ctx_sep" "$ctx_pct_part"
else
    printf '%s\n' "$left_part"
fi

# Line 2: owner/repo in bold magenta (omit when owner is empty)
if [[ -n "$owner" ]]; then
    printf '\033[1;35m%s/%s\033[0m\n' "$owner" "$repo"
fi
