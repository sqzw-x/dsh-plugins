#!/usr/bin/env bash
#
# Sync the vendored agent skills from their upstream repositories.
#
# The skills are vendored (not submodules) so a checkout always has them: DSH
# reads `<repo>/.agents/skills/<name>/SKILL.md`, and an uninitialized submodule
# would make the skill disappear silently.
#
# Usage:
#   bash scripts/sync-skill.sh            # fetch the latest release tag and overwrite
#   bash scripts/sync-skill.sh --check    # report differences without writing
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_REPO="https://github.com/green-dalii/dsh-plugin-dev-skill.git"
SKILL_DIR="$ROOT/.agents/skills/dsh-plugin-dev-skill"
CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
[ -d "$SKILL_DIR" ] || die "$SKILL_DIR does not exist"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Resolving the latest upstream tag"
TAG="$(git ls-remote --tags --sort=-v:refname "$SKILL_REPO" \
  | awk -F/ '/refs\/tags\/v[0-9]/ {print $3; exit}')"
[ -n "$TAG" ] || die "could not resolve an upstream tag (offline?)"
info "upstream: $TAG"
info "local:    $(cat "$SKILL_DIR/VERSION")"

say "Fetching $TAG"
git clone --quiet --depth 1 --branch "$TAG" "$SKILL_REPO" "$TMP/skill"
rm -rf "$TMP/skill/.git"

if [ "$CHECK" -eq 1 ]; then
  say "Differences"
  if diff -ru "$SKILL_DIR" "$TMP/skill"; then
    info "already up to date"
  else
    info "run without --check to apply"
  fi
  exit 0
fi

say "Installing"
rsync -a --delete --exclude .git "$TMP/skill/" "$SKILL_DIR/"

say "Done"
info "local is now $(cat "$SKILL_DIR/VERSION")"
info "update .agents/skills/README.md if the version changed"
