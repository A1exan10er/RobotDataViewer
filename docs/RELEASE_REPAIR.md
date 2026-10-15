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
up replaced assets and release metadata, retries transfers, downloads every
published file and verifies SHA-256, then updates release notes. On failure it
attempts to restore replaced assets and retains the backup. New additive assets
may remain, but publication is not reported successful. Never update the download
instructions to claim a package is available until both hosts have passed this
verification. Keep older stable releases and optional NVIDIA assets untouched.

Linux physical-camera acceptance is a separate opt-in check. Record Chrome and
Firefox results, including Firefox's uncropped 640×480 tactile override and any
calibration failures; do not equate synthetic CI success with physical Windows or
macOS hardware acceptance.
