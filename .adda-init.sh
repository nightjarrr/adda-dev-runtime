#!/bin/bash
# Repo-level init hook for adda-dev-runtime.
# Sourced by entrypoint.sh after entrypoint.d hooks; inherits set -euo pipefail.
# Inputs:  $BUN_VERSION (required env, validated by entrypoint before this runs)
#          package.json at /workspace root
# Outputs: node_modules/ installed; /workspace/.adda-init-notes.md written
#          (empty on happy path, populated with correction details on mismatch)

_declared="$(jq -r '.devDependencies["@types/bun"] // empty' package.json)"

if [[ "$_declared" != "$BUN_VERSION" ]]; then
    warning "@types/bun mismatch (declared: '${_declared:-missing}', image: '$BUN_VERSION'). Auto-correcting..."
    bun add --dev "@types/bun@${BUN_VERSION}"
    cat > /workspace/.adda-init-notes.md <<EOF
# Bootstrap notes

\`@types/bun\` was outdated (package.json: ${_declared:-missing}, image BUN_VERSION: ${BUN_VERSION}) and auto-corrected during bootstrap. \`package.json\` and \`bun.lock\` have local changes.

If on a feature branch, commit them:

    git add package.json bun.lock
    git commit -m "chore: sync @types/bun to BUN_VERSION ${BUN_VERSION}"

If on \`main\`, route through the normal SDLC (chore issue).
EOF
else
    bun install --frozen-lockfile
    touch /workspace/.adda-init-notes.md
fi
