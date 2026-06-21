# ADDA Dev Runtime — Conceptual Design

**`adda-dev-runtime`** is the container-side implementation of the **ADDA Dev Runtime** (ADDA: Agentic Development with Durable Artifacts) — the isolated, ephemeral container in which the AI agent and all development tooling run. It implements the stateless-agent and persistent-GitHub patterns, enforces the innermost defense-in-depth boundary within the container trust wall, and defines the Tier architecture that structures its own internals. [`adda-dev-launcher`](https://github.com/nightjarrr/adda-dev-launcher) is the companion repository that owns the host-side launcher and network proxy sidecar.

This document establishes the container-side conceptual design: the design principles the container implements, the components it operates alongside, its security posture from inside the trust boundary, and the Tier architecture of its internal stack. It is a design rationale document — the place to understand *why* the container is structured the way it is and what trade-offs it makes.

For the host-side design — the session lifecycle, and the isolation and defense-in-depth principles the launcher enforces — see [`docs/conceptual-design.md`](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/conceptual-design.md) in adda-dev-launcher.

For the contract between the launcher and this container — the runtime interface each side must satisfy — see [`docs/launcher-container-contract.md`](launcher-container-contract.md).

For the concrete implementation of this design — entrypoint sequence, configuration variables, network enforcement, authentication, artifact routing — see [`docs/adda-dev-runtime-technical-design.md`](adda-dev-runtime-technical-design.md).

Companion to [adda-sdlc.md](https://github.com/nightjarrr/molim/blob/main/docs/adda-sdlc.md) — the vendor-agnostic conceptual design of the ADDA SDLC that this runtime implements.

**Audience: human Project Owner only.** Read at setup time and when modifying the environment. Not part of any agent's runtime context.

Throughout, `{owner}` and `{repo}` refer to the GitHub namespace and repository name of the project.

---

## Design principles

### Stateless agent, persistent GitHub

The AI agent carries no state across container exits — it rebuilds context at session start by reading GitHub state and repository artifacts. Anything not pushed before exit is lost. This is an intentional and accepted trade-off for isolation and reproducibility.

GitHub is the persistence layer for all project work. Project state flows to GitHub through:

- commits pushed to feature branches;
- Issues — including hierarchies, cross-links, and comments — tracking requirements, design decisions, and outcomes;
- Pull Requests and their review trails;
- GitHub API state (labels, milestones, phase tracking).

Nothing outside GitHub persists: no host source bind mount, no persistent AI harness config volume, no SSH agent forwarding, and no shared host clone are used.

*Launcher counterpart:* the ephemeral runtime boundary — creating this container for one feature workflow and destroying it on exit — is enforced by the launcher. See [adda-dev-launcher conceptual design](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/conceptual-design.md).

### AI harness permission configuration

The AI harness enforces the innermost boundary in the system's defense-in-depth design: a least-privilege permission model governing what agents, skills, and tools can do inside the container.

The outer two boundaries — container isolation and the proxy-based network perimeter — are established by the launcher outside the container wall. This third boundary operates inside the container and addresses what the outer boundaries cannot: an AI actor that is legitimately inside the container but must be constrained from overreaching within it.

See [adda-dev-launcher conceptual design](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/conceptual-design.md) for the full defense-in-depth framing and the first two boundaries.

---

## Components

The ADDA Dev Runtime is composed of four distinct components. This container is one of them; understanding the others is necessary to understand the constraints this container operates under.

### Host system

The machine outside this container. The only fully trusted environment — it carries the host keyring and the launcher program, and the container engine runs here. The host system is never directly accessible from inside the AI harness container; no host filesystem, process, device, or display is reachable. No development tooling — git, the GitHub CLI, language runtimes, or project-specific tools — is required on the host; all of that runs inside containers.

### Launcher

The host-side program that created this container and set its parameters. The launcher retrieved credentials from the host keyring, started the network proxy sidecar, and assembled this container with its required security constraints. It is the only component that can set session parameters; from inside the container, those parameters are givens, not variables. The launcher is a trusted perimeter component.

### Network proxy sidecar

The per-session network proxy started by the launcher alongside this container. It enforces a default-deny domain allow-list on all outbound traffic from the session and runs outside the container trust boundary. The absence of general network access inside this container — all intended outbound traffic routes through `HTTP_PROXY`/`HTTPS_PROXY` — is a consequence of how the launcher and proxy are configured. The network proxy sidecar is a trusted perimeter component.

### AI harness container

This container. The isolated, ephemeral runtime in which the AI agent and all development tooling run. It is explicitly treated as untrusted — nothing running inside it is assumed to be non-exploitable. The tier stack (Tiers 1 and 2, and optionally Tier 3) runs inside this container; see *Tier architecture* below.

---

## Trust model

| Component | Trust level | Rationale |
|---|---|---|
| Host system | Fully trusted | The user's machine; outside the threat boundary |
| Launcher | Trusted | User-controlled; part of the trusted computing base |
| Network proxy sidecar | Trusted | Runs outside this container; enforces network policy |
| AI harness container | **Untrusted** | May run exploited or manipulated code |

This container sits on the untrusted side of the boundary. That designation carries a design consequence inside the container: the AI harness cannot assume its own internal actors are trustworthy either. The AI harness permission configuration boundary (see *Design principles*) is the container's response — it enforces least privilege on agents, skills, and tools regardless of whether the container itself has been compromised.

The boundary between trusted and untrusted runs at the container wall. The launcher establishes and enforces it from outside. See [adda-dev-launcher conceptual design](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/conceptual-design.md) for the full treatment of the trust boundary and its enforcement.

---

## Threat model

This section describes threats that materialize or are mitigated inside this container. Threats whose primary mitigations are launcher-enforced are noted here where they bear on container-side design decisions, with references to [adda-dev-launcher conceptual design](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/conceptual-design.md) for the full treatment.

### Primary threat: host compromise from code inside the development environment

The system's primary threat — code running inside this container affecting the host — is addressed principally by the launcher through container isolation and the network proxy perimeter. This container accepts those constraints as given: it operates without general network access, without host filesystem access, and under a read-only root filesystem with explicit writable mounts.

The container's own contribution to this threat's mitigation is the AI harness permission configuration boundary, which limits the blast radius of a compromised or manipulated AI actor within the container.

Container isolation reduces likelihood and blast radius; it does not reduce risk to zero. A determined attacker exploiting an unpatched container escape CVE is outside this container's own design guarantee — see the launcher conceptual design for the image provenance and kernel patching mitigations that address it.

### Prompt injection

Adversarial content may reach the AI agent's context through web pages, dependency READMEs, Issue bodies, PR comments, fetched files, or repository content. These all materialize inside the container.

Mitigations: ephemeral container limits persistence and blast radius; narrow GitHub Token scope prevents cross-repository or account-level damage; AI harness permission configuration enforces least privilege; network egress allow-list (enforced by the proxy outside this container) limits where compromised code can communicate; PR review remains the final human gate for code and workflow changes.

Residual risk: hostile content may influence changes on the current branch until caught at review.

### Malicious dependencies

A dependency may execute hostile code during install, test, build, or runtime. Two dependency classes are distinguished:

- **Container/toolchain dependencies** — OS packages, shell tools, language managers, the AI harness, and other infrastructure baked into the image at build time. Versions are pinned in image definitions; these dependencies are not installed at runtime inside this container.
- **Project code dependencies** — dependencies declared by the repository after it is cloned. Installed at runtime from locked registries, under the unprivileged container user, with only the package-registry access the project requires.

Residual risk: a malicious version already present in a reviewed lockfile can still execute inside this container.

### Network exfiltration

A compromised tool or manipulated AI agent may attempt to send repository contents, tokens, or other data to an attacker-controlled endpoint.

This container has no network interface beyond loopback; all intended outbound traffic routes through the network proxy sidecar via `HTTP_PROXY`/`HTTPS_PROXY`. Processes that use proxy-aware HTTP clients reach only allow-listed domains; processes that ignore proxy configuration have no network path to use. Enforcement runs outside this container and is not defeatable from inside it.

### Token theft

This container must hold credentials to function. Mitigations: the GitHub Token is single-repository with no administration permissions; the AI harness token is revocable; exfiltration routes are constrained by the network allow-list; tokens are never stored in plaintext on host disk — the launcher retrieves them from the host keyring at session start and injects them into this container's environment.

Accepted residual risk: an attacker in a live session can use available credentials within their granted scope until the session is terminated or tokens are revoked.

### Quota and resource abuse

A runaway AI agent session or hostile instruction may consume API quota, GitHub API rate limits, or host CPU and memory. The primary mitigation — ephemeral container teardown — is launcher-enforced; this container cannot stop itself. GitHub API rate limits apply naturally.

---

## Session model

This container is one development session — created by the launcher for one feature workflow and destroyed when the session exits.

| Concept | Mapping |
|---|---|
| One GitHub Issue | One feature workflow |
| One feature workflow | One AI harness session |
| One AI harness session | One AI harness container |
| One AI harness container | One network proxy sidecar |
| One AI harness container | One host terminal session |

Subagents run inside the parent AI harness process and share this container. They do not get separate containers.

Multiple features may run concurrently. Each session is a fully isolated container; sessions share no state except through GitHub.

Nothing persists when this container exits. Resuming work means the launcher creates a new container; the agent rebuilds context from GitHub at session start.

The session lifecycle — how the launcher creates and tears down the coordinated set of components — is described in [adda-dev-launcher conceptual design](https://github.com/nightjarrr/adda-dev-launcher/blob/main/docs/conceptual-design.md).

---

## Tier architecture

The AI harness container runs a layered stack of three tiers. Each tier has a distinct concern and a distinct form.

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
