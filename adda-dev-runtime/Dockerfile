# syntax=docker/dockerfile:1.7
# ======================================================================
# Tier 1 base — generic dev runtime, no AI tool.
#
# This Dockerfile produces the adda-dev-runtime base image. It is
# project-agnostic and AI-tool-agnostic. Higher-tier images (proto-adda,
# dawe-claude-dev-runtime, per-project images) FROM this image and add
# AI tooling and project-specific dependencies.
#
# Pinned versions (update via chore Issue when bumping):
#   Base image:    debian:12.11-slim              # 2026-05-22 (current Debian 12 point release)
#   GitHub CLI:    2.91.0                        # Apr 22, 2026
#   Micro:         2.0.15
#   Delta:         0.19.2
#   Bun:           1.3.14                        # 2026-05-24
#   Biome:         2.4.15
#   TypeScript:    6.0.3
# ======================================================================

ARG BUN_VERSION=1.3.14

# ======================================================================
# BUN BUILDER — compile TypeScript scripts to extensionless executables
# ======================================================================
FROM oven/bun:${BUN_VERSION}-slim AS bun-builder
WORKDIR /build
COPY adda-dev-runtime/src/ /build/
RUN bun build /build/*.ts \
        --outdir /build/out/ \
        --target bun \
        --sourcemap=inline \
        --banner '#!/usr/bin/env bun' \
    && for f in /build/out/*.js; do mv "$f" "${f%.js}"; done \
    && chmod +x /build/out/*

# ======================================================================
# BASE — generic dev runtime (project-agnostic, AI-tool-agnostic)
# ======================================================================

FROM debian:12.11-slim

# ----------------------------------------------------------------------
# Environment defaults that apply for both build and runtime.
# TZ is supplied by the launcher at run time (-e TZ=...) and read by
# libc and TZ-aware tools from the process environment; no ENV TZ here.
# ----------------------------------------------------------------------
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TERM=xterm-256color \
    COLORTERM=truecolor

# ----------------------------------------------------------------------
# System packages required by the dev environment
#
# General:
#   - locales: for the en_US.UTF-8 locale
#   - tzdata: zoneinfo files; required for run-time TZ env var resolution
#   - ca-certificates, curl: TLS + bootstrap downloads
#   - git: source control (used by the entrypoint and AI tooling)
#   - tmux: in-container session survivability
#   - jq: JSON parsing (entrypoint and helpers)
#
# Operational tooling:
#   - bubblewrap: namespace-based sandbox used by the AI tool's `bash --sandbox`
#   - ripgrep: fast code search
#   - fd-find: fast file finder
#
# Network isolation tooling:
#   - socat: socket relay used to create a proxy bridge from
#     container-internal HTTP proxy (e.g., 127.0.0.1:8080) to
#     the sidecar proxy listening socket (mounted as Unix socket)
# ----------------------------------------------------------------------
# Why: apt package versions are intentionally not pinned. Debian stable's release policy
# (security/bug-fix updates only within a minor release) is the structural version anchor;
# pinning individual apt version strings would be brittle without improving reproducibility.
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
        locales \
        tzdata \
        ca-certificates \
        curl \
        git \
        jq \
        bubblewrap \
        socat \
        ripgrep \
        fd-find \
        unzip \
    && sed -i '/^#.* en_US.UTF-8 /s/^#//' /etc/locale.gen \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------
# GitHub CLI (gh) — installed from the official .deb release
# ----------------------------------------------------------------------
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v2.91.0/gh_2.91.0_linux_amd64.deb" \
        -o /tmp/gh.deb \
    && apt-get install -y --no-install-recommends /tmp/gh.deb \
    && rm /tmp/gh.deb \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------
# Micro — TUI text editor, installed from official GitHub release.
# Static binary; no runtime dependencies.
# ----------------------------------------------------------------------
ENV MICRO_VERSION=2.0.15 \
    EDITOR=micro \
    VISUAL=micro
RUN curl -fsSL "https://github.com/micro-editor/micro/releases/download/v${MICRO_VERSION}/micro-${MICRO_VERSION}-linux64-static.tar.gz" \
        -o /tmp/micro.tar.gz \
    && tar -xzf /tmp/micro.tar.gz -C /tmp \
    && mv /tmp/micro-${MICRO_VERSION}/micro /usr/local/bin/micro \
    && rm /tmp/micro.tar.gz \
    && rm -rf /tmp/micro-${MICRO_VERSION}

# ----------------------------------------------------------------------
# delta — syntax-highlighting diff pager for git, from official GitHub release.
# Static (musl) binary; no runtime dependencies.
# ----------------------------------------------------------------------
ENV DELTA_VERSION=0.19.2
RUN curl -fsSL "https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/delta-${DELTA_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
        -o /tmp/delta.tar.gz \
    && tar -xzf /tmp/delta.tar.gz -C /tmp \
    && mv /tmp/delta-${DELTA_VERSION}-x86_64-unknown-linux-musl/delta /usr/local/bin/delta \
    && rm /tmp/delta.tar.gz \
    && rm -rf /tmp/delta-${DELTA_VERSION}-x86_64-unknown-linux-musl \
    && git config --system core.pager delta \
    && git config --system interactive.diffFilter "delta --color-only" \
    && git config --system delta.line-numbers true \
    && git config --system delta.navigate true \
    && mkdir -p /etc/delta \
    && curl -fsSL "https://raw.githubusercontent.com/dandavison/delta/${DELTA_VERSION}/themes.gitconfig" \
        -o /etc/delta/themes.gitconfig \
    && git config --system include.path /etc/delta/themes.gitconfig \
    && git config --system delta.features mellow-barbet \
    && git config --system delta.side-by-side false

# ----------------------------------------------------------------------
# Bun — JS runtime and package manager, from official GitHub release.
# Static binary; no runtime dependencies.
# ----------------------------------------------------------------------
ARG BUN_VERSION
ENV BUN_VERSION=${BUN_VERSION}
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" \
        -o /tmp/bun.zip \
    && unzip -j /tmp/bun.zip 'bun-linux-x64-baseline/bun' -d /usr/local/bin/ \
    && rm /tmp/bun.zip \
    && ln -s /usr/local/bin/bun /usr/local/bin/node

# ----------------------------------------------------------------------
# Biome — standalone binary linter/formatter, from official GitHub release.
# TypeScript + @types/bun — installed globally via bun for tsc and type
# checking in container sessions; BUN_INSTALL sets the global prefix.
# @types/bun version matches BUN_VERSION (same runtime).
# ----------------------------------------------------------------------
ENV BIOME_VERSION=2.4.15 \
    TYPESCRIPT_VERSION=6.0.3
RUN curl -fsSL \
        "https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%40${BIOME_VERSION}/biome-linux-x64-musl" \
        -o /usr/local/bin/biome \
    && chmod +x /usr/local/bin/biome \
    && BUN_INSTALL=/usr/local bun install -g typescript@${TYPESCRIPT_VERSION} @types/bun@${BUN_VERSION}

# ----------------------------------------------------------------------
# Bootstrap scripts — all Tier 1 scripts baked at build time.
# .sh.source files have no exec bit in the repo; chmod is set here.
# ----------------------------------------------------------------------
COPY adda-dev-runtime/content/scripts/ /usr/local/libexec/adda-dev-runtime/
RUN mkdir -p /usr/local/libexec/adda-dev-runtime/entrypoint.d \
    && for f in /usr/local/libexec/adda-dev-runtime/*.sh.source; do \
        mv "$f" "${f%.source}"; \
    done \
    && chmod +x /usr/local/libexec/adda-dev-runtime/*.sh
COPY --from=bun-builder /build/out/ /usr/local/libexec/adda-dev-runtime/


# ======================================================================
# COMMON — user, working directory, entrypoint, default command
# ======================================================================

# Create the runtime user explicitly. UID/GID align with the launcher's
# ADDA_DEV_USER/UID/GID defaults. Higher-tier images FROM this image
# and inherit the user without re-creating it.
ARG USERNAME=adda
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} \
       --create-home --shell /bin/bash ${USERNAME}

USER ${USERNAME}
WORKDIR /workspace

# ENTRYPOINT runs unconditionally on container start; CMD is the default
# final command after bootstrap. CMD is overridable at `docker run` time
# for troubleshooting (e.g., `docker run ... adda-dev-runtime ls /workspace`
# bootstraps and runs ls instead of bash).
ENTRYPOINT ["/usr/local/libexec/adda-dev-runtime/entrypoint.sh"]
CMD ["/bin/bash"]
