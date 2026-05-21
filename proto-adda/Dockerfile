# syntax=docker/dockerfile:1.7
# ======================================================================
# proto-adda — AI harness layer (Tier 2)
#
# FROM adda-dev-runtime (Tier 1). Adds:
#   - Node.js 24 LTS (direct binary from nodejs.org)
#   - Claude Code (npm global, version-pinned)
#   - Bootstrap hook: overlay-apply + Claude config init
#   - quality-gates.sh at fixed absolute path
#
# Pinned versions:
#   Node.js:      24.1.0
#   Claude Code:  2.1.112
# ======================================================================

ARG BASE_TAG=latest
FROM adda-dev-runtime:${BASE_TAG}

# Build steps require root to write to /usr/local; Tier 1 leaves USER as node.
USER root

# ----------------------------------------------------------------------
# Node.js 24 LTS — direct binary from nodejs.org
# ----------------------------------------------------------------------
ENV NODE_VERSION=24.1.0
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
        -o /tmp/node.tar.gz \
    && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
    && rm /usr/local/LICENSE /usr/local/CHANGELOG.md /usr/local/README.md \
    && rm /tmp/node.tar.gz

# ----------------------------------------------------------------------
# Claude Code — official npm package, version-pinned
# ----------------------------------------------------------------------
ENV CLAUDE_CODE_VERSION=2.1.112
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# ----------------------------------------------------------------------
# Bootstrap hook — sourced by Tier 1 entrypoint after BASE init
# ----------------------------------------------------------------------
COPY proto-adda/overlay/entrypoint.d/ /usr/local/libexec/claude-dev/entrypoint.d/
RUN chmod +x /usr/local/libexec/claude-dev/entrypoint.d/*.sh

# ----------------------------------------------------------------------
# Overlay — staged in image; hook copies to ~/.claude/ at container start
# ----------------------------------------------------------------------
COPY proto-adda/overlay/.claude/ /usr/local/share/claude-dev/templates/.claude/
COPY proto-adda/.claude.json.template /usr/local/share/claude-dev/templates/.claude.json.template

# ----------------------------------------------------------------------
# quality-gates.sh — baked at fixed absolute path; overlay/scripts/ is
# the source-of-truth in the repo but ships here, not to ~/
# ----------------------------------------------------------------------
COPY proto-adda/overlay/scripts/quality-gates.sh /usr/local/libexec/claude-dev/quality-gates.sh
RUN chmod +x /usr/local/libexec/claude-dev/quality-gates.sh

# Restore runtime user before handoff.
USER node

# Override Tier 1's generic CMD; proto-adda's purpose is to run Claude Code.
CMD ["claude"]
