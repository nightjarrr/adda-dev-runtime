#!/bin/bash
# Purpose: Strip non-runtime files from a node_modules directory to reduce image size.
# Usage:   prune-node-modules.sh <node_modules_dir>
# Outputs: Four lines to stdout — size before, size after, files pruned, percent saved.
#
# Removes declaration files, documentation, test directories, CI/lint configs,
# and license files that are not needed at runtime.

set -euo pipefail

# ---
# Input
# ---

dir="${1:?Usage: prune-node-modules.sh <node_modules_dir>}"

# ---
# Stats — before
# ---

size_before_bytes=$(du -sb "$dir" | cut -f1)
size_before_human=$(du -sh "$dir" | cut -f1)
files_before=$(find "$dir" -type f | wc -l)

# ---
# Prune — extensions
# ---

find "$dir" -type f \( \
    -name "*.ts" \
    -o -name "*.d.mts" \
    -o -name "*.d.cts" \
    -o -name "*.md" \
    -o -name "*.markdown" \
    -o -name "*.mkd" \
    -o -name "*.jst" \
    -o -name "*.coffee" \
    -o -name "*.tgz" \
    -o -name "*.swp" \
\) -delete

# ---
# Prune — named files
# ---

find "$dir" -type f \( \
    -name "Makefile" \
    -o -name "Jenkinsfile" \
    -o -name "Gulpfile.js" \
    -o -name "Gruntfile.js" \
    -o -name "gulpfile.js" \
    -o -name ".DS_Store" \
    -o -name ".tern-project" \
    -o -name ".gitattributes" \
    -o -name ".editorconfig" \
    -o -name ".eslintrc" \
    -o -name ".eslintrc.js" \
    -o -name ".eslintrc.json" \
    -o -name ".eslintrc.yml" \
    -o -name ".eslintignore" \
    -o -name ".stylelintrc" \
    -o -name "stylelint.config.js" \
    -o -name ".stylelintrc.json" \
    -o -name ".stylelintrc.yaml" \
    -o -name ".stylelintrc.yml" \
    -o -name ".stylelintrc.js" \
    -o -name ".htmllintrc" \
    -o -name "htmllint.js" \
    -o -name ".lint" \
    -o -name ".npmrc" \
    -o -name ".npmignore" \
    -o -name ".jshintrc" \
    -o -name ".flowconfig" \
    -o -name ".documentup.json" \
    -o -name ".yarn-metadata.json" \
    -o -name ".travis.yml" \
    -o -name "appveyor.yml" \
    -o -name ".gitlab-ci.yml" \
    -o -name "circle.yml" \
    -o -name ".coveralls.yml" \
    -o -name "CHANGES" \
    -o -name "changelog" \
    -o -name "LICENSE.txt" \
    -o -name "LICENSE" \
    -o -name "LICENSE-MIT" \
    -o -name "LICENSE.BSD" \
    -o -name "license" \
    -o -name "LICENCE.txt" \
    -o -name "LICENCE" \
    -o -name "LICENCE-MIT" \
    -o -name "LICENCE.BSD" \
    -o -name "licence" \
    -o -name "AUTHORS" \
    -o -name "CONTRIBUTORS" \
    -o -name ".yarn-integrity" \
    -o -name ".yarnclean" \
    -o -name "_config.yml" \
    -o -name ".babelrc" \
    -o -name ".yo-rc.json" \
    -o -name "jest.config.js" \
    -o -name "karma.conf.js" \
    -o -name "wallaby.js" \
    -o -name "wallaby.conf.js" \
    -o -name ".prettierrc" \
    -o -name ".prettierrc.yml" \
    -o -name ".prettierrc.toml" \
    -o -name ".prettierrc.js" \
    -o -name ".prettierrc.json" \
    -o -name "prettier.config.js" \
    -o -name ".appveyor.yml" \
    -o -name "tsconfig.json" \
    -o -name "tslint.json" \
\) -delete

# ---
# Prune — named directories
# ---

find "$dir" -type d \( \
    -name "__tests__" \
    -o -name "test" \
    -o -name "tests" \
    -o -name "powered-test" \
    -o -name "docs" \
    -o -name "doc" \
    -o -name ".idea" \
    -o -name ".vscode" \
    -o -name "website" \
    -o -name "images" \
    -o -name "assets" \
    -o -name "example" \
    -o -name "examples" \
    -o -name "coverage" \
    -o -name ".nyc_output" \
    -o -name ".circleci" \
    -o -name ".github" \
\) -prune -exec rm -rf {} +

# ---
# Stats — after
# ---

size_after_bytes=$(du -sb "$dir" | cut -f1)
size_after_human=$(du -sh "$dir" | cut -f1)
files_after=$(find "$dir" -type f | wc -l)
pruned_count=$((files_before - files_after))

if [ "$size_before_bytes" -gt 0 ]; then
    saved_pct=$(( (size_before_bytes - size_after_bytes) * 100 / size_before_bytes ))
else
    saved_pct=0
fi

# ---
# Report
# ---

echo "  before: ${size_before_human}"
echo "  after:  ${size_after_human}"
echo "  pruned: ${pruned_count} files"
echo "  saved:  ${saved_pct}%"
