# syntax=docker/dockerfile:1.7
# ======================================================================
# proto-adda — AI harness layer (Tier 2)
#
# FROM adda-dev-runtime (Tier 1). Adds:
#   - Claude Code (Bun global, version-pinned)
#   - Bootstrap hook: Claude config init
#   - render-adda-shell-tools Bun executable
#
# Pinned versions:
#   Claude Code:  2.1.170
# ======================================================================

ARG BUN_VERSION=1.3.14
ARG BASE_TAG=latest

# ======================================================================
# BUN BUILDER — compile Tier 2 TypeScript scripts to extensionless executables
# ======================================================================
FROM oven/bun:${BUN_VERSION}-slim AS bun-builder
WORKDIR /build
COPY package.json bun.lock tsconfig.json /build/
COPY adda-dev-runtime/src/lib/ /build/adda-dev-runtime/src/lib/
COPY proto-adda/src/ /build/proto-adda/src/
RUN bun install --frozen-lockfile \
    && for src in /build/proto-adda/src/runtime/*.ts; do \
        bun build "$src" \
            --outdir /build/out/bin/ \
            --target bun \
            --packages=external \
            --sourcemap=inline \
            --banner '#!/usr/bin/env bun' \
        || exit 1; \
    done \
    && for f in /build/out/bin/*.js; do mv "$f" "${f%.js}"; done \
    && chmod +x /build/out/bin/*

FROM ghcr.io/nightjarrr/adda-dev-runtime:${BASE_TAG}

# Build steps require root to write to /usr/local; Tier 1 leaves USER as adda.
USER root

# ----------------------------------------------------------------------
# Claude Code — official Bun package, version-pinned.
# BUN_INSTALL is set inline (not as a persistent ENV) so the global install
# lands at /usr/local/bin/claude, which is already on PATH.
# ----------------------------------------------------------------------
ENV CLAUDE_CODE_VERSION=2.1.170
RUN BUN_INSTALL=/usr/local bun install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && rm -rf /usr/local/install/global/node_modules/@img/sharp-libvips-linuxmusl-x64 \
              /usr/local/install/global/node_modules/@img/sharp-linuxmusl-x64 \
              /usr/local/install/cache

# ----------------------------------------------------------------------
# Bootstrap hook — sourced by Tier 1 entrypoint after BASE init
# ----------------------------------------------------------------------
COPY proto-adda/content/scripts/bootstrap/entrypoint.d/ /usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/
RUN for f in /usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/*.sh.source; do \
        mv "$f" "${f%.source}"; \
    done \
    && chmod +x /usr/local/libexec/adda-dev-runtime/bootstrap/entrypoint.d/*.sh

# ----------------------------------------------------------------------
# Claude config — staged in image; hook copies to ~/.claude/ at container start
# ----------------------------------------------------------------------
COPY proto-adda/content/.claude/ /usr/local/share/adda-dev-runtime/.claude/
COPY proto-adda/content/templates/.claude.json.template /usr/local/share/adda-dev-runtime/templates/.claude.json.template

# ----------------------------------------------------------------------
# Tier 2 runtime executables — built by bun-builder stage above
# ----------------------------------------------------------------------
COPY --from=bun-builder /build/out/ /usr/local/libexec/adda-dev-runtime/

# Restore runtime user before handoff.
USER adda

# Override Tier 1's generic CMD; proto-adda's purpose is to run Claude Code.
CMD ["claude"]
