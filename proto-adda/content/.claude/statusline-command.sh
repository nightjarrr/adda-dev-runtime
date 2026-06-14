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

# Compute left-side visible length (no ANSI codes)
if [[ "$state" == "CLOSED" ]]; then
    left_len=$(( 1 + ${#id} + 1 + 8 + 1 + ${#title} ))
else
    left_len=$(( 1 + ${#id} + 1 + ${#title} ))
fi

# Right-align: pad between left content and right info
cols=$(( ${COLUMNS:-80} - 5 ))
pad=$(( cols - left_len - ${#ctx_right} ))

# If there's not enough room, suppress the right side rather than overflow
if [[ $pad -lt 2 ]]; then
    ctx_right=""
fi

# ctx part color: bold red if ctx_pct >= threshold (only when threshold env var is set), dark grey otherwise
if [[ -n "$ctx_pct" && -n "$ADDA_STATUSLINE_CTX_RED_THRESHOLD" ]] \
    && awk -v pct="$ctx_pct" -v thr="$ADDA_STATUSLINE_CTX_RED_THRESHOLD" \
           'BEGIN { exit !(pct >= thr) }'; then
    ctx_part_color='\033[1;31m'
else
    ctx_part_color='\033[1;38;5;238m'
fi

if [[ "$state" == "CLOSED" ]]; then
    left_part="$(printf '\033[1;36m#%s\033[0m \033[2;36m[CLOSED]\033[0m \033[1;36m%s\033[0m' "$id" "$title")"
else
    left_part="$(printf '\033[1;36m#%s\033[0m \033[1;36m%s\033[0m' "$id" "$title")"
fi

if [[ -n "$ctx_right" ]]; then
    printf '%s%*s\033[1;38;5;238m%s%s'"${ctx_part_color}"'%s\033[0m\n' \
        "$left_part" "$pad" "" "$model_part" "$ctx_sep" "$ctx_pct_part"
else
    printf '%s\n' "$left_part"
fi

if [[ -n "$pr" ]]; then
    printf '\033[38;5;238m%s  %s  PR #%s\033[0m\n' "$issue_type" "$phase" "$pr"
else
    printf '\033[38;5;238m%s  %s\033[0m\n' "$issue_type" "$phase"
fi
