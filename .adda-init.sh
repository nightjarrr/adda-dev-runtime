#!/bin/bash
set -euo pipefail
# Repo-level init hook for adda-dev-runtime.
# Invoked as a subprocess by the entrypoint at bootstrap and by current-issue switch mid-session.
# Inputs:  $BUN_VERSION (required env, validated by caller before this runs)
#          /workspace/package.json
# Outputs: node_modules/ installed; /workspace/CLAUDE.local.md written on
#          mismatch with correction details (happy path: no notes file created)

_declared="$(jq -r '.devDependencies["@types/bun"] // empty' /workspace/package.json)"

if [[ "$_declared" != "$BUN_VERSION" ]]; then
    printf '\033[1;33mWarning:\033[0m %s\n' "@types/bun mismatch (declared: '${_declared:-missing}', image: '$BUN_VERSION'). Auto-correcting..." >&2
    bun add --dev "@types/bun@${BUN_VERSION}"
    cat > /workspace/CLAUDE.local.md <<EOF
# Branch init notes

\`@types/bun\` must match the image's \`BUN_VERSION\` so TypeScript type definitions align with the actual Bun runtime APIs. It was outdated (package.json: ${_declared:-missing}, image BUN_VERSION: ${BUN_VERSION}) and auto-corrected. \`package.json\` and \`bun.lock\` have local changes.

Commit them:

    git add package.json bun.lock
    git commit -m "chore: sync @types/bun to BUN_VERSION ${BUN_VERSION}"
EOF
else
    bun install --frozen-lockfile
fi

rm -rf node_modules/@oxlint/binding-linux-x64-musl \
       node_modules/@oxfmt/binding-linux-x64-musl

rm -rf "${HOME}/.bun/install/cache"
