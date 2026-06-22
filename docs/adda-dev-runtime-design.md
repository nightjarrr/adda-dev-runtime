# ADDA Dev Runtime — Conceptual Design

**`adda-dev-runtime`** is the container-side implementation of the **ADDA Dev Runtime** (ADDA: Agentic Development with Durable Artifacts) — the isolated, ephemeral container in which the AI harness and all development tooling run. It implements the stateless-agent and persistent-GitHub patterns, enforces the innermost defense-in-depth boundary within the container trust wall, and defines the Tier architecture that structures its own internals. [`adda-dev-launcher`](https://github.com/nightjarrr/adda-dev-launcher) is the companion repository that owns the host-side launcher and network proxy sidecar.

This document establishes the container-side conceptual design: the design principles the container implements, the components it operates alongside, its security posture from inside the trust boundary, and the Tier architecture of its internal stack. It is a design rationale document — the place to understand *why* the container is structured the way it is and what trade-offs it makes.

**Audience: human Project Owner only.** Read at setup time and when modifying the environment. Not part of any agent's runtime context.

For the host-side design — the session lifecycle, and the isolation and defense-in-depth principles the launcher enforces — see [`docs/conceptual-design.md`](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/conceptual-design.md) in adda-dev-launcher.

For the contract between the launcher and the container — the runtime interface each side must satisfy — see [`docs/launcher-container-contract.md`](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/launcher-container-contract.md) in `adda-dev-launcher`.

For the container-internal implementation — container contract validation, entrypoint sequence, bootstrap extension points, artifact routing, and image build pipeline — see [`docs/adda-dev-runtime-technical-design.md`](adda-dev-runtime-technical-design.md).

Companion to [adda-sdlc.md](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) — the vendor-agnostic conceptual design of the ADDA SDLC that this runtime implements.

Throughout, `{owner}` and `{repo}` refer to the GitHub namespace and repository name of the project.

---

## Design principles

### Ephemeral runtime, stateless agent, persistent GitHub

A dev runtime exists for one feature workflow and is destroyed on exit. The ephemeral runtime boundary is enforced by the launcher; the stateless-agent and persistent-GitHub patterns are the container's side of the same design intent.

The AI agent carries no state across container exits — it rebuilds context at session start by reading GitHub state and repository artifacts. Anything not pushed before exit is lost. This is an intentional and accepted trade-off for isolation and reproducibility.

GitHub is the persistence layer for all project work. Project state flows to GitHub through:

- commits pushed to feature branches;
- Issues — including hierarchies, cross-links, and comments — tracking requirements, design decisions, and outcomes;
- Pull Requests and their review trails;
- GitHub API state (labels, milestones, phase tracking).

Nothing outside GitHub persists: no host source bind mount, no persistent AI harness config volume, no SSH agent forwarding, and no shared host clone are used.

### Defense in depth

Three concentric boundaries protect the host and project from code running inside the development environment. The first two — container isolation and the proxy-based network perimeter — are established by the launcher outside the container wall; see the launcher conceptual design. The third operates inside the container: the AI harness enforces a least-privilege permission model governing what agents, skills, and tools can do, constraining AI actors that are legitimately inside the container from overreaching within it.

---

## Components

The ADDA Dev Runtime is composed of four components. The three external components are described in full in the launcher conceptual design; what follows is the context needed to understand the constraints the container operates under.

- **Host system** — the machine outside the container; the only fully trusted environment. Carries the host keyring and the launcher program; the container engine runs here. No development tooling is required on the host.
- **Launcher** — the host-side program that creates and tears down development sessions. Retrieves credentials from the host keyring, starts the network proxy sidecar, and assembles the AI harness container with its required security constraints. A trusted perimeter component.
- **Network proxy sidecar** — a per-session proxy started by the launcher outside the container trust boundary. Enforces a default-deny domain allow-list on all outbound traffic; the container has no general network access as a consequence. A trusted perimeter component.

### AI harness container

The isolated, ephemeral runtime in which the AI agent and all development tooling run. Explicitly treated as untrusted — nothing running inside it is assumed to be non-exploitable. The launcher runs it with a read-only root filesystem and explicit writable mounts — a hardening constraint imposed from outside, not something the container configures itself. The tier stack runs inside the container; see *Tier architecture* below.

---

## Trust model

| Component | Trust level | Rationale |
|---|---|---|
| Host system | Fully trusted | The user's machine; outside the threat boundary |
| Launcher | Trusted | User-controlled; part of the trusted computing base |
| Network proxy sidecar | Trusted | Runs outside the container; enforces network policy |
| AI harness container | **Untrusted** | May run exploited or manipulated code |

The boundary between trusted and untrusted runs at the container wall. The AI harness container's untrusted designation carries a design consequence inward: the AI harness cannot assume its own internal actors are trustworthy either. The defense-in-depth principle (see *Design principles*) is the container's response — its AI harness enforces least privilege on agents, skills, and tools regardless of whether the container itself has been compromised.

---

## Threat model

The full threat model — including host compromise, network exfiltration, token theft, and quota abuse — is described in the launcher conceptual design. Two threats are elaborated here because they materialize specifically inside the container and bear on container-side design decisions.

### Prompt injection

Adversarial content may reach the AI agent's context through web pages, dependency READMEs, Issue bodies, PR comments, fetched files, or repository content.

Container-enforced mitigations: AI harness permission configuration limits what compromised actors can do within the session; PR review is the final human gate for code and workflow changes. The launcher contributes complementary mitigations — ephemeral runtime boundary, narrow GitHub Token scope, network egress allow-list — described in the launcher conceptual design.

Residual risk: hostile content may influence changes on the current branch until caught at review.

### Malicious dependencies

A dependency may execute hostile code during install, test, build, or runtime. Two dependency classes are distinguished:

- **Container/toolchain dependencies** — OS packages, shell tools, language managers, the AI harness, and other infrastructure baked into the image at build time. Versions are pinned in image definitions; these dependencies are not installed at runtime.
- **Project code dependencies** — dependencies declared by the repository after it is cloned. Installed at runtime from locked registries, under the unprivileged container user, with only the package-registry access the project requires.

Residual risk: a malicious version already present in a reviewed lockfile can still execute inside the container.

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

The AI harness container runs a layered stack of three tiers. Each tier has a distinct concern and a distinct form. Tier 1 and Tier 2 are always present as container images. Tier 3 — the project repository — is always cloned into the workspace; it may also contribute a container image extending Tier 2 when the project requires OS-level tooling not available in Tier 1.

### Tier 1 — infrastructure

**What it is:** the hardened, isolated, ephemeral container base. Provides OS packages, core CLI tools, a runtime user, and the entrypoint with its hook mechanism.

**Why it exists as an image:** Tier 1 is pure infrastructure. Packaging it as a container image gives every higher tier and every project a reproducible, version-pinned base with no host-side toolchain requirements.

**What it does not include:** any AI harness, any AI harness configuration, or any project-specific tooling. Tier 1 is AI-harness-agnostic by design.

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
