#!/usr/bin/env bash
# Lint (AIP-W1 US-7 criterion "green CI (lint, ...)", decision 25/11/2026, Hub row 226),
# shared by ai-platform, prj01 and prj02.
# 1. ESLint (pinned in package.json) over the repo, with the repo's eslint.config.js.
# 2. Self-test: a throwaway file with two planted mistakes must make ESLint FAIL, so a linter
#    that silently checks nothing is caught (the same idea as the secret scan's planted key).
# Usage: scripts/ci/lint.sh   (after npm ci)
set -euo pipefail

echo "== 1. Lint the repo"
npx eslint .
echo "  no lint errors"

echo "== 2. Self-test with planted mistakes"
sample=".lint-selftest-$$.js"
trap 'rm -f "$sample"' EXIT
printf 'const unused = 1;\nundefinedName();\n' > "$sample"
if npx eslint "$sample" >/dev/null 2>&1; then
  echo "  FAIL: the linter did not catch the planted mistakes, so its result above cannot be trusted"
  exit 1
fi
echo "  planted mistakes caught, the linter works"
