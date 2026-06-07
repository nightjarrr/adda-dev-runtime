# Self-hosting: this repo as its own Tier 3

**Audience: the agent working inside the development container.**

For the canonical tier model, see [`docs/adda-dev-runtime.md`](adda-dev-runtime.md).

---

## What self-hosting means here

`adda-dev-runtime` occupies an unusual position: it is simultaneously a **Tier 3 project** (developed using ADDA, running inside a proto-adda container) and the **source repository for the Tier 1 and Tier 2 images** that container is built from.

In plain terms:

- The container you are running in right now was built from this repo.
- Changes you make to this repo take effect only in the next built image — not in the current running container.

This duality is real and intentional. It does not change how ADDA works; it just means the deliverables of this project are the runtime environment itself.

---

## Which files belong to which tier

```
adda-dev-runtime/          Tier 1 source — generic, AI-tool-agnostic base image
proto-adda/                Tier 2 source — AI-harness image (builds FROM Tier 1)
launcher/                  Host-side infrastructure — launcher script, Envoy config
                           (not a container image tier; runs on the host)

.adda-init.sh              Tier 3 — repo-level ADDA init hook for this project
CLAUDE.md                  Tier 3 — agent instructions for developing this repo
.quality-gates.toml        Tier 3 — quality-gate configuration for this repo
package.json               Tier 3 — devDependencies used during development
bun.lock                   Tier 3 — lockfile for the above
```

The Tier 1 and Tier 2 source directories contain the repo's primary deliverables. The Tier 3 files at the root are what make this repo itself an ADDA-managed project.

---

## Practical constraints

**No Docker inside the container.** Image builds and launch tests require Docker on the host. They are a PO/host operation. The agent cannot build or test images.

**Edit repo source only — never runtime copies.** The running container's scripts and executables are baked into the image. They are read-only at paths like `/usr/local/libexec/adda-dev-runtime/`. Editing them would have no effect and would fail due to the read-only root filesystem. All edits go to the repo source files under `/workspace`. Changes reach the container only after CI builds and publishes a new image.

**Verification scope is limited.** Inside the container, verification is restricted to file/path checks and running `quality-gates`. Live image testing — launching a container from the built image, exercising entrypoint behavior, or testing host-side launcher flows — requires the host and is a PO operation.

---

## Relationship to canonical tier definitions

The tier model (what Tier 1 and Tier 2 are, how they are layered, libexec structure, artifact routing) is documented in [`docs/adda-dev-runtime.md`](adda-dev-runtime.md). This document only explains how that model applies to the self-hosting situation specific to this repo. When the two conflict, `docs/adda-dev-runtime.md` is authoritative.
