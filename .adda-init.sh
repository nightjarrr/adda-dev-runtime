#!/bin/bash
# Repo-level init hook for adda-dev-runtime.
# Sourced by entrypoint.sh after entrypoint.d hooks; inherits set -euo pipefail.
# Inputs:  $BUN_VERSION (required env, validated by entrypoint before this runs)
#          package.json at /workspace root
# Outputs: node_modules/ installed; /workspace/CLAUDE.local.md written on
#          mismatch with correction details (happy path: no notes file created)

_declared="$(jq -r '.devDependencies["@types/bun"] // empty' package.json)"

if [[ "$_declared" != "$BUN_VERSION" ]]; then
    warning "@types/bun mismatch (declared: '${_declared:-missing}', image: '$BUN_VERSION'). Auto-correcting..."
    bun add --dev "@types/bun@${BUN_VERSION}"
    cat > /workspace/CLAUDE.local.md <<EOF
# Bootstrap notes

\`@types/bun\` must match the image's \`BUN_VERSION\` so TypeScript type definitions align with the actual Bun runtime APIs. It was outdated (package.json: ${_declared:-missing}, image BUN_VERSION: ${BUN_VERSION}) and auto-corrected during bootstrap. \`package.json\` and \`bun.lock\` have local changes.

If on a feature branch, commit them:

    git add package.json bun.lock
    git commit -m "chore: sync @types/bun to BUN_VERSION ${BUN_VERSION}"

If on \`main\`, route through the normal SDLC (chore issue).
EOF
else
    bun install --frozen-lockfile
fi

rm -rf node_modules/@oxlint/binding-linux-x64-musl \
       node_modules/@oxfmt/binding-linux-x64-musl

rm -rf "${HOME}/.bun/install/cache"
export PATH="/workspace/node_modules/.bin:$PATH"
