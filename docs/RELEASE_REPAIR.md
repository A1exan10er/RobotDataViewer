# Rebuilding and repairing v1.5.0-rc.3

The Git tag remains unchanged. Repaired assets must identify their actual build
commit, clean source tree and viewer SHA-256 in BUILD.json. The release's automatic
tag source links still contain the original rc.3 source; distribute the matching
`RobotDataViewer-1.5.0-rc.3-repaired-source.tar.gz` with the repaired assets.

The Native portable packages workflow builds the web/source input once, then
uses it on Linux x64, Windows x64, macOS Intel and Apple Silicon. Each extracted
native archive must pass startup, real browser media API tests with synthetic
cameras, and cold/cached native force checks. The `release-set` job refuses a
missing platform, dirty build, different source/viewer, missing executable bit,
or a report belonging to another archive. Its `release-ready` artifact contains
the four native ZIPs, HTML ZIP, matching source, manifest and checksums. Optional
NVIDIA add-ons can be rebuilt through the workflow's `build_nvidia` input.

Download the `release-ready` artifact and verify it locally:

```sh
python3 tools/verify_release.py --directory artifacts/release-ready
```

Prepare release notes that name all four desktop packages, explain the HTML-only
alternative, link the repair commit, distinguish physical hardware acceptance
from synthetic tests, and identify the original tag source. Then publish to each
existing pre-release (use distinct, previously nonexistent backup directories):

```sh
python3 tools/publish_release.py --host github --directory artifacts/release-ready --backup artifacts/release-backup-github --notes artifacts/repaired-release-notes.md
python3 tools/publish_release.py --host gitea --directory artifacts/release-ready --backup artifacts/release-backup-gitea --notes artifacts/repaired-release-notes.md --gitea-token-file /path/to/private/token
```

GitHub uses the existing `gh` authentication. Gitea accepts `GITEA_TOKEN`, a token
file, or `--gitea-user` with a password prompt; credentials are never saved by the
publisher. Use `--inspect` to check release metadata without modifying anything.

The publisher verifies the complete local manifest before authentication, backs
up existing assets and release metadata, retries transfers, downloads every
published file and verifies SHA-256, then updates release notes. On failure it
attempts to restore replaced assets and retains the backup. New additive assets
may remain, but publication is not reported successful. Never update the download
instructions to claim a package is available until both hosts have passed this
verification. Keep older stable releases and optional NVIDIA assets untouched.

Linux physical-camera acceptance is a separate opt-in check. Record Chrome and
Firefox results, including Firefox's uncropped 640×480 tactile override and any
calibration failures; do not equate synthetic CI success with physical Windows or
macOS hardware acceptance.

For slow desktop uploads, the **Publish verified rc.3 repair** Actions workflow can publish the existing `release-ready` artifact from a successful build run. Supply its run ID and exact repair commit. The workflow checks both against the manifest, uses GitHub’s built-in release token, backs up existing files, uploads and re-downloads every asset, and retains a publication report. It keeps existing release notes until both hosts have been verified. No application rebuild is performed by that workflow.

The workflow is on the repair branch. GitHub shows the **Run workflow** button only when the workflow is on the default branch; after its first run, the API/CLI can target its registered branch workflow. Use the repair branch explicitly:

```sh
gh workflow run publish-repaired-release.yml --repo A1exan10er/RobotDataViewer --ref codex/live-camera-inspection -f build_run=38678088024 -f repair_commit=b7c47bb8ae06e6e76d0189d205050c7e9199c38a
```

These IDs reproduce this repair publication; use the new successful build run and matching commit for another repair. The command republishes assets, so run it only for an intended release operation. The default stable branch is not changed by this procedure. See [GitHub workflow dispatch documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
