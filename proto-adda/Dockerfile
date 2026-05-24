# syntax=docker/dockerfile:1.7
# ======================================================================
# proto-adda — AI harness layer (Tier 2)
#
# FROM adda-dev-runtime (Tier 1). Adds:
#   - Node.js 24 LTS (direct binary from nodejs.org)
#   - Claude Code (npm global, version-pinned)
#   - Bootstrap hook: Claude config init
#
# Pinned versions:
#   Node.js:      24.1.0
#   Claude Code:  2.1.112
# ======================================================================

ARG BASE_TAG=latest
FROM ghcr.io/nightjarrr/adda-dev-runtime:${BASE_TAG}

# Build steps require root to write to /usr/local; Tier 1 leaves USER as adda.
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
COPY proto-adda/content/entrypoint.d/ /usr/local/libexec/adda-dev-runtime/entrypoint.d/
RUN for f in /usr/local/libexec/adda-dev-runtime/entrypoint.d/*.sh.source; do \
        mv "$f" "${f%.source}"; \
    done \
    && chmod +x /usr/local/libexec/adda-dev-runtime/entrypoint.d/*.sh

# ----------------------------------------------------------------------
# Claude config — staged in image; hook copies to ~/.claude/ at container start
# ----------------------------------------------------------------------
COPY proto-adda/content/.claude/ /usr/local/share/adda-dev-runtime/.claude/
COPY proto-adda/content/templates/.claude.json.template /usr/local/share/adda-dev-runtime/templates/.claude.json.template

# Restore runtime user before handoff.
USER adda

# Override Tier 1's generic CMD; proto-adda's purpose is to run Claude Code.
CMD ["claude"]
