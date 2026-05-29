---
name: Cut releases by pushing the tag, not via `gh release create`
description: Tag push triggers the release workflow which owns release creation as draft; `gh release create` publishes immediately and traps asset upload
type: feedback
originSessionId: 3e873007-59db-4eff-946d-ad0fcfab6551
---
To cut a release in adda-dev-runtime, push the tag and let the release workflow own everything else:

```bash
git tag vX.Y.Z <commit-sha>
git push origin vX.Y.Z
```

The `release` workflow (`.github/workflows/release.yml`) creates the GitHub release as a draft via `softprops/action-gh-release@v2`, attaches the launcher tarball, and then publishes.

**Why:** Using `gh release create vX.Y.Z --target main --generate-notes` instead publishes the release *immediately* and empty. When the workflow then tries to upload the launcher tarball, GitHub's API rejects it: "Cannot upload asset to an immutable release. GitHub only allows asset uploads before a release is published, so upload assets to a draft release before you publish it."

**Recovery from this mistake is hard.** Deleting the published release does *not* free the tag — GitHub burns the tag/release pair as "immutable" once a release tied to it is deleted, and refuses to accept a new release for the same tag name. Both git push of the tag and gh release create against the same tag get rejected with "tag_name was used by an immutable release" / "creations being restricted". The only path forward is to burn the version number and cut the next one (e.g. v0.3.3 → v0.3.4). This happened during the v0.3.3 release attempt 2026-05-29.

**How to apply:** Whenever PO asks to "cut a release", reach for `git tag && git push origin <tag>`. Do not reach for `gh release create`. Verify success by checking the `release` workflow run and the resulting GitHub release has the launcher tarball attached.
