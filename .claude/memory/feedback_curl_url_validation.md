---
name: Validate curl URLs before committing
description: When a plan or Coder introduces a new curl-installable dependency, the download URL must be verified reachable before commit and push
type: feedback
originSessionId: e82c1b66-3c76-47ef-8b3e-0a2d209a00b6
---
When a new curl-installable dependency is introduced (binary download in a Dockerfile or script), verify the target URL is reachable and correct before committing and pushing.

**Why:** The Biome binary URL in the Dockerfile used the Biome 1.x release tag format (`cli/v{VERSION}`) but Biome 2.x changed to `@biomejs/biome@{VERSION}`. This produced a 404 during CI's Docker build — four CI iterations wasted — when a simple `curl -fsSL --head <url>` check before pushing would have caught it immediately.

**How to apply:** Whenever a plan specifies a new curl download URL (binary install, standalone tool, etc.), Coder must run `curl -fsSL --head <url>` (or equivalent) to confirm the URL returns 200 before committing. If the URL cannot be reached from the container, flag it explicitly in the structured response rather than proceeding blind.
