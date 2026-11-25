#!/usr/bin/env bash
# Secret scan (platform plan condition 1, Hub row 212), shared by ai-platform, prj01 and prj02.
# 1. Scans every commit of the repo with gitleaks (pinned container image).
# 2. Self-test: plants a fake Anthropic key in a throwaway folder (made at run time, never committed)
#    and requires the scan to FAIL on it, so a scanner that silently finds nothing is caught.
# Plain English: a smoke alarm check. We scan the house, then hold a lit match under the alarm
# to prove it still beeps.
# Usage: scripts/ci/secret_scan.sh [repo_dir]   (needs docker; full git history checked out)
set -euo pipefail

IMAGE="ghcr.io/gitleaks/gitleaks:v8.30.1"
repo="$(cd "${1:-.}" && pwd)"
run_gitleaks() { docker run --rm --user "$(id -u):$(id -g)" -v "$1:/scan:ro" "$IMAGE" "${@:2}"; }

echo "== 1. Scan every commit of $(basename "$repo")"
run_gitleaks "$repo" git /scan --redact --no-banner --verbose
echo "  no secrets found in the history"

echo "== 2. Self-test with a planted fake key"
planted="$(mktemp -d)"
trap 'rm -rf "$planted"' EXIT
# 93 random letters and digits (finite input, so no broken pipe under pipefail)
body="$(openssl rand -base64 160 | LC_ALL=C tr -dc 'A-Za-z0-9' | cut -c1-93)"
[ "${#body}" -eq 93 ] || { echo "  could not build the fake key"; exit 1; }
printf 'ANTHROPIC_API_KEY=sk-ant-api03-%sAA\n' "$body" > "$planted/leak.env"
chmod -R a+rX "$planted"
if run_gitleaks "$planted" dir /scan --redact --no-banner >/dev/null 2>&1; then
  echo "  FAIL: the scanner did not catch the planted key, so its result above cannot be trusted"
  exit 1
fi
echo "  planted key caught, the scanner works"
