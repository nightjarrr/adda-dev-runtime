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
#   Base image:    debian:bookworm-slim
#   GitHub CLI:    2.91.0                        # Apr 22, 2026
#   Micro:         2.0.15
#   Delta:         0.19.2
# ======================================================================


# ======================================================================
# BASE — generic dev runtime (project-agnostic, AI-tool-agnostic)
# ======================================================================

FROM debian:bookworm-slim

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
#   - git: source control (used by the entrypoint and by Claude)
#   - tmux: in-container session survivability
#   - jq: JSON parsing (entrypoint and helpers)
#
# Operational tooling:
#   - bubblewrap: namespace-based sandbox used by Claude's `bash --sandbox`
#   - ripgrep: fast code search
#   - fd-find: fast file finder
#
# Network isolation tooling:
#   - socat: socket relay used to create a proxy bridge from
#     container-internal HTTP proxy (e.g., 127.0.0.1:8080) to
#     the sidecar proxy listening socket (mounted as Unix socket)
# ----------------------------------------------------------------------
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
    && sed -i '/^#.* en_US.UTF-8 /s/^#//' /etc/locale.gen \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

# ----------------------------------------------------------------------
# GitHub CLI (gh) — installed from the official .deb release
# ----------------------------------------------------------------------
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v2.91.0/gh_2.91.0_linux_amd64.deb" \
        -o /tmp/gh.deb \
    && apt-get install -y /tmp/gh.deb \
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
# Bootstrap entrypoint script
# Copied from docker/adda-dev-runtime/entrypoint.sh into the image at
# build time; invoked as the container's ENTRYPOINT (see COMMON section).
# ----------------------------------------------------------------------
RUN mkdir -p /usr/local/libexec/claude-dev/entrypoint.d
COPY docker/adda-dev-runtime/entrypoint.sh /usr/local/libexec/claude-dev/entrypoint.sh
RUN chmod +x /usr/local/libexec/claude-dev/entrypoint.sh


# ======================================================================
# COMMON — user, working directory, entrypoint, default command
# ======================================================================

# Create the runtime user explicitly. UID/GID align with the launcher's
# CLAUDE_DEV_USER/UID/GID defaults. Higher-tier images FROM this image
# and inherit the user without re-creating it.
ARG USERNAME=node
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
ENTRYPOINT ["/usr/local/libexec/claude-dev/entrypoint.sh"]
CMD ["/bin/bash"]
