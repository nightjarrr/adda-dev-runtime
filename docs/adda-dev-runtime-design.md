# ADDA Dev Runtime — Conceptual Design

This document establishes the conceptual design of the ADDA Dev Runtime: its goals, principles, components, security posture, and tier architecture. It is a design rationale document — the place to understand *why* the system looks the way it does and what trade-offs it makes.

For the concrete implementation of this design — entrypoint sequence, configuration variables, network allow-list, authentication specifics, artifact routing — see [`docs/adda-dev-runtime-technical-design.md`](adda-dev-runtime-technical-design.md).

Companion to [adda-sdlc.md](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) — the vendor-agnostic conceptual design of the ADDA SDLC that this runtime implements.

**Audience: human Project Owner only.** Read at setup time and when modifying the environment. Not part of any agent's runtime context.

Throughout, `{owner}` and `{repo}` refer to the GitHub namespace and repository name of the project.

---

## Design principles

### Ephemeral runtime, stateless agent, persistent GitHub

A dev runtime exists for one feature workflow and is destroyed on exit. The AI agent carries no state across container exits — it rebuilds context at session start by reading GitHub state and repository artifacts. Anything not pushed before exit is lost. This is an intentional and accepted trade-off for isolation and reproducibility.

GitHub is the persistence layer for all project work. Project state flows to GitHub through:

- commits pushed to feature branches;
- Issues — including hierarchies, cross-links, and comments — tracking requirements, design decisions, and outcomes;
- Pull Requests and their review trails;
- GitHub API state (labels, milestones, phase tracking).

Nothing outside GitHub persists: no host source bind mount, no persistent AI harness config volume, no SSH agent forwarding, and no shared host clone are used.

### Defense in depth

Three concentric boundaries protect the host and project from code running inside the development environment:

1. **Container isolation** — the AI harness container has no host filesystem, process, device, display, container engine socket, or network namespace access beyond what the launcher explicitly grants.
2. **Proxy-based network perimeter** — the AI harness container has no general network access. All intended outbound traffic goes through a launcher-managed network sidecar proxy that enforces a default-deny domain allow-list.
3. **AI harness permission configuration** — enforces least privilege when granting permissions to AI actors: agents, skills, and tools.

Two further protections bound the impact of credential exposure:

- **Host-side keyring** — authentication tokens never reside in plaintext on host disk; the keyring is encrypted at rest and unlocked only by an active login session.
- **Token scoping** — the GitHub Token is scoped to a single repository with no administration permissions, bounding GitHub blast radius.

### Host launcher and network proxy are trusted perimeter components

The AI harness container is treated as untrusted. Nothing inside it is assumed to be non-exploitable. The host launcher and the per-session network proxy sidecar are therefore part of the trusted computing base for network and runtime isolation. A user who deliberately bypasses the launcher or weakens the network proxy policy is outside the protection model.

### No plaintext secrets on host disk

Authentication tokens live in the host keyring. The launcher retrieves tokens on demand. There is no project `.env` containing secrets, no credentials file, and no token in shell history.

---

## Components

The ADDA Dev Runtime is composed of four distinct components. Understanding what each component is and its trust level is essential for the design principles and threat model to be meaningful.

### Host system

The machine on which the development environment runs. The only fully trusted environment. It carries the host keyring (secrets at rest) and the launcher program. The container engine runs here. The host system is never directly accessible from inside the AI harness container.

### Launcher

A host-side program that creates and tears down a single development session. The launcher retrieves credentials from the host keyring, starts the network proxy sidecar, assembles and runs the AI harness container with its required security constraints, and cleans up on exit. It is the only component that can set session parameters. The launcher is a trusted perimeter component.

### Network proxy sidecar

A per-session network perimeter proxy. It runs as a separate component managed by the launcher — outside the AI harness container trust boundary — and enforces a default-deny domain allow-list on all outbound traffic from the session. The network proxy sidecar is a trusted perimeter component. One network proxy sidecar runs per session.

### AI harness container

The isolated, ephemeral runtime in which the AI agent and all development tooling run. It is explicitly treated as untrusted — nothing running inside it is assumed to be non-exploitable. The container has no general network access; outbound traffic reaches the internet only through the network proxy sidecar. Its root filesystem is read-only; writable paths are explicit in-memory mounts. The tier stack (Tiers 1 and 2, and optionally Tier 3) runs inside this container; see *Tier architecture* below.

---

## Trust model

| Component | Trust level | Rationale |
|---|---|---|
| Host system | Fully trusted | The user's machine; outside the threat boundary |
| Launcher | Trusted | User-controlled; part of the trusted computing base |
| Network proxy sidecar | Trusted | Runs outside the container; enforces network policy |
| AI harness container | **Untrusted** | May run exploited or manipulated code |

The boundary between trusted and untrusted runs at the container wall. Network enforcement sits outside this boundary — in the network proxy — specifically because components inside the boundary cannot be trusted to enforce their own rules.

---

## Threat model

### Primary threat: host compromise from code inside the development environment

The environment must prevent any code, tool, dependency, or AI agent running inside the AI harness container from affecting the host system.

The container is constrained by a set of non-negotiable properties: no host namespace access, no container engine socket, non-root user, minimal OS-level privileges, read-only root filesystem, and no general network egress. See the technical design for the exact constraints that implement these properties.

### Limits of container isolation

Container isolation reduces likelihood and blast radius; it does not reduce risk to zero. The host kernel must be patched. Image provenance, base-image discipline, pinned digests, CI provenance, and minimal runtime privileges are part of the mitigation. A determined attacker exploiting an unpatched container escape CVE is outside of this design's guarantee.

### Prompt injection

Adversarial content may reach the AI agent's context through web pages, dependency READMEs, Issue bodies, PR comments, fetched files, or repository content.

Mitigations: ephemeral runtime limits persistence and blast radius; narrow GitHub Token scope prevents cross-repository or account-level damage; AI harness permission configuration enforces least privilege; network egress allow-list limits where compromised code can communicate; PR review remains the final human gate for code and workflow changes.

Residual risk: hostile content may influence changes on the current branch until caught at review.

### Malicious dependencies

A dependency may execute hostile code during install, test, build, or runtime. Two dependency classes are distinguished:

- **Container/toolchain dependencies** — OS packages, shell tools, language managers, the AI harness, and other infrastructure baked into the image at build time. Not installed with elevated privileges at runtime.
- **Project code dependencies** — dependencies declared by the repository after it is cloned. Installed at runtime from locked registries, under the unprivileged container user, with only the package-registry access the project requires.

Residual risk: a malicious version already present in a reviewed lockfile can still execute inside the isolated container.

### Network exfiltration

A compromised tool or manipulated AI agent may attempt to send repository contents, tokens, or other data to an attacker-controlled endpoint.

Primary mitigation: the container has no network interface beyond loopback; all proxied traffic reaches the internet only through the network proxy's default-deny domain allow-list; processes that ignore proxy configuration fail because there is no direct network path.

### Token theft

The container must hold credentials to function. Mitigations: the GitHub Token is single-repository with no administration permissions; the AI harness token is revocable; exfiltration routes are constrained by the network allow-list; tokens are never stored in plaintext on host disk.

Accepted residual risk: an attacker in a live session can use available credentials within their granted scope until the session is terminated or tokens are revoked.

### Quota and resource abuse

A runaway AI agent session or hostile instruction may consume API quota, GitHub API rate limits, or host CPU and memory. Mitigations: ephemeral container teardown stops further consumption; in-memory filesystem sizes bound writable storage growth; GitHub API rate limits apply naturally.

---

## Session model

One development session is a coordinated unit — one of each component, created together and destroyed together:

| Concept | Mapping |
|---|---|
| One GitHub Issue | One feature workflow |
| One feature workflow | One AI harness session |
| One AI harness session | One AI harness container |
| One AI harness container | One network proxy sidecar |
| One AI harness container | One host terminal session |

Subagents run inside the parent AI harness process and share its container. They do not get separate containers.

Multiple features may run concurrently. Each session is fully isolated from others, sharing no state except through GitHub.

A session is created when work begins and destroyed when the session exits. Resuming work creates a new runtime; state is reloaded from GitHub.

---

## Tier architecture

The AI harness container runs a layered stack of three tiers. Each tier has a distinct concern and a distinct form.

### Tier 1 — infrastructure

**What it is:** the hardened, isolated, ephemeral container base. Provides OS packages, core CLI tools, a shared scripting runtime, a runtime user, and the entrypoint with its hook mechanism.

**Why it exists as an image:** Tier 1 is pure infrastructure. Packaging it as a container image gives every higher tier and every project a reproducible, version-pinned base with no host-side toolchain requirements.

**What it does not include:** any AI harness, any AI harness configuration, or any project-specific tooling. Tier 1 is AI-harness-agnostic by design.

**Shared scripting runtime:** a scripting runtime is included in Tier 1 as a deliberate architectural choice: infrastructure scripts across all tiers share a consistent runtime environment without requiring additional setup at higher tiers. The choice of specific runtime is an implementation detail documented in the technical design.

### Tier 2 — ADDA SDLC implementation

**What it is:** a runnable image that packages a specific AI harness together with a complete implementation of the ADDA SDLC for that harness. Builds on Tier 1 and adds the AI harness binary, the SDLC methodology (agent config, skills, settings, agent definitions), and a bootstrap hook that initialises the agent's working environment at container start.

**Why it exists as an image:** the SDLC methodology and its AI harness must be distributed together as a versioned, reproducible unit. An image is the correct packaging for a self-contained, runnable system.

**Multiple Tier 2 implementations:** Tier 2 is a role, not a single implementation. Multiple implementations can coexist as siblings, each pairing a different AI harness or SDLC implementation with the same Tier 1 base:
- **proto-adda** — current implementation; Claude Code with a simplified SDLC. See `docs/proto-adda.md`.
- **DAWE** — planned full ADDA SDLC implementation. See [dawe-proposal.md](https://github.com/nightjarrr/molim/blob/main/docs/claude-sdlc/dawe-proposal.md).

The Tier 2 agent configuration contains the SDLC workflow, roles, working principles, and release process. It contains no project-specific content.

### Tier 3 — the project

**What it is:** the GitHub repository of the actual software being developed. Not an image and not infrastructure — the project that uses a Tier 2 runtime to develop itself.

**Form:** a GitHub repository, cloned into the workspace at container start. The project supplies the agent with project-specific orientation (architecture, conventions, toolchain). The SDLC methodology is inherited from the Tier 2 image.

**Optional infrastructure elements** — a Tier 3 project may carry infrastructure only when strictly necessary:
- **`.adda-init.sh`** — a repo-level init hook run after bootstrap, used to install project dependencies.
- **A project container image extending Tier 2** — adds OS-level tooling for language runtimes not provided by Tier 1.

### Tier summary

| | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| **Concern** | Infrastructure | ADDA SDLC implementation | The project being developed |
| **Form** | Container image | Container image (extending Tier 1) | GitHub repository |
| **Examples** | `adda-dev-runtime` | `proto-adda`, `DAWE` (planned) | any project using ADDA |
| **Agent config** | — | Bundled SDLC implementation, project-agnostic | Project-specific harness configuration and context |
| **Multiplicity** | One | One per AI harness / SDLC implementation | One per project |

---

## Explicit non-choices

### No VS Code Dev Containers extension

The workflow is terminal-first. IDE integration and host-container IPC sockets are not part of this design.

### No in-container network policy enforcement

Network isolation is not the container's responsibility. The container has no network interface beyond loopback and holds no network administration privileges. The network proxy sidecar, running outside the container trust boundary, is the sole enforcement point for outbound network policy.

### No host-wide daemon proxy

The proxy is per-session runtime infrastructure. It starts with the session and stops when the session exits.

### No network proxy inside the AI harness container

The network proxy runs as a separate component outside the container trust boundary. Running it inside the AI harness container would collapse the security boundary between trusted and untrusted components.

### No external off-host proxy requirement

The perimeter proxy runs on the same host as the AI harness container. The design does not require a corporate or remote proxy service.

### No general web-fetch egress from the AI harness container

Broad web fetch/research is deferred to a separate design. The baseline container remains narrowly networked.

### No host home directory mount

The container has no view of host configuration files, keys, browser profiles, or personal state.

### No SSH agent forwarding

GitHub access is via HTTPS using a fine-grained GitHub Token scoped to the project repository.

### No persistent AI harness config volume

AI harness state is ephemeral. Credentials are injected at startup and not preserved as a host-mounted config directory.

### No container engine socket inside the container

Mounting the container engine socket inside the AI harness container would be equivalent to host escape.

### No git worktrees on the host

Each session clones into an isolated in-container workspace.

### No save-on-exit

Containers are not preserved on exit; uncommitted work is lost. The SDLC's commit-and-push discipline bounds this risk.

### No multi-container per-subagent isolation

Subagents share one container per feature. Per-role separation is enforced by AI harness permissions, not container boundaries.

### No host-side `gh` or `git` dependency

GitHub-aware operations happen inside the container.

### No floating dependency versions

All external dependencies are pinned. Floating versions let upstream changes enter the environment without review — this policy eliminates that risk. Pinning operates at three layers:

1. **Application and tool versions** — exact versions are pinned in image definitions.
2. **Base image** — base image versions are pinned to specific releases rather than rolling tags.
3. **OS-level packages** — not pinned to specific package manager version strings; the base distribution's stability policy is the structural pin.

---

## Deferred questions and features of the design

The following are recognized but not part of the immediate baseline implementation:

1. **Broad web retrieval plane** — define how user-approved direct URL fetch and research should work without opening general egress from the container.
2. **Live allow-list management** — explore whether network proxy policy should be reloadable without sidecar restart, and whether a UI/control plane is justified.
3. **Credential hiding behind proxy/gateway** — investigate whether future API-specific gateways can inject auth headers so selected tools do not receive raw tokens.
4. **Stronger sandboxing** — evaluate alternative container isolation technologies (e.g. gVisor, VM-based runtimes) if kernel escape risk becomes a higher priority.
5. **Container resource limits** — CPU and memory quotas for the AI harness container are not currently enforced. Evaluate container runtime resource constraint features.
