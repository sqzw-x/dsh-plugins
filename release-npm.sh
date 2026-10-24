#!/usr/bin/env bash
#
# One-shot npm release for the two DSH plugins:
#   - dsh-focus-notify   (repo: sqzw-x/dsh-focus-notify)
#   - dsh-notes-context  (repo: sqzw-x/dsh-notes-context)
#
# What it does, in order:
#   1. checks both checkouts are clean, on main, and not behind origin
#   2. npm login if needed (interactive; no long-lived token is created)
#   3. publishes the current first versions locally (0.3.0 / 0.2.0)
#   4. configures npm Trusted Publishing with `npm trust github`
#   5. bumps one patch (0.3.1 / 0.2.1), pushes main + tags
#   6. GitHub Actions publishes over OIDC; the script watches the runs
#
# Usage:
#   bash /Users/srz/projects/dsh-plugins/release-npm.sh
#   bash /Users/srz/projects/dsh-plugins/release-npm.sh --dry-run
#
set -euo pipefail

ALERTS_DIR="/Users/srz/projects/dsh-plugins/dsh-alerts"
NOTES_DIR="/Users/srz/projects/dsh-plugins/packages/dsh-notes-context"
ALERTS_PKG="dsh-focus-notify"
NOTES_PKG="dsh-notes-context"
ALERTS_REPO="sqzw-x/dsh-focus-notify"
NOTES_REPO="sqzw-x/dsh-notes-context"
ALERTS_FIRST="0.3.0"
NOTES_FIRST="0.2.0"

LAST_SHA=""
LAST_VERSION=""
DRY=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY=1
fi

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
for cmd in npm node git gh; do need "$cmd"; done

[ -f "$ALERTS_DIR/package.json" ] || die "not found: $ALERTS_DIR/package.json"
[ -f "$NOTES_DIR/package.json" ]  || die "not found: $NOTES_DIR/package.json"
[ -d "$ALERTS_DIR/.git" ]         || die "not a git checkout: $ALERTS_DIR"
[ -d "$NOTES_DIR/.git" ]          || die "not a git checkout: $NOTES_DIR"

pkg_version() { node -p "require('$1/package.json').version"; }
npm_has() {
  npm view "$1@$2" version --prefer-online >/dev/null 2>&1 && return 0
  # direct registry check bypasses npm's metadata cache
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/$1/$2?t=$(date +%s)" 2>/dev/null || echo 000)"
  [ "$code" = "200" ]
}

npm_ready() {
  npm_has "$1" "$2" || return 1
  local url
  url="$(npm view "$1@$2" dist.tarball --prefer-online 2>/dev/null)" || return 1
  [ -n "$url" ] || return 1
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$url?t=$(date +%s)" 2>/dev/null || echo 000)" = "200" ]
}

npm_is_staged() {
  npm view "$1" dist-tags.latest --prefer-online 2>/dev/null | grep -qx '0.0.0-stage'
}
npm_latest()  { npm view "$1" version 2>/dev/null || true; }

check_repo() {
  local dir="$1" name="$2"
  [ "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" = "main" ] \
    || die "$name is not on main"
  [ -z "$(git -C "$dir" status --porcelain)" ] \
    || die "$name has uncommitted changes; commit or stash them first"
  git -C "$dir" fetch origin >/dev/null 2>&1 || true
  local behind
  behind="$(git -C "$dir" rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
  [ "$behind" = "0" ] || die "$name is behind origin/main; pull first"
}

first_publish() {
  local dir="$1" pkg="$2" first="$3" why="$4"
  local cur
  cur="$(pkg_version "$dir")"

  if [ "$cur" != "$first" ]; then
    info "$pkg is at $cur (first release was $first); skipping first publish"
    return 0
  fi

  if npm_ready "$pkg" "$cur"; then
    info "$pkg@$cur already on npm; skipping first publish"
    return 0
  fi

  say "First publish: $pkg@$cur ($why)"
  if [ "$DRY" = "1" ]; then
    info "would run: (cd $dir && npm test)"
    info "would prompt for a 2FA code, then run: npm publish --access public --otp=<code>"
    return 0
  fi

  ( cd "$dir" && npm test )

  local otp=""
  if [ -t 0 ]; then
    read -r -s -p "  2FA code for $pkg@$cur (Enter = let npm stage it, slower): " otp
    echo
  fi
  local pubargs=(publish --access public)
  [ -n "$otp" ] && pubargs+=("--otp=$otp")
  ( cd "$dir" && npm "${pubargs[@]}" )

  local i
  # A first publish can sit at 0.0.0-stage for several minutes (observed: ~6 min)
  # before npm promotes the real version. Poll for up to 10 minutes.
  for i in $(seq 1 120); do
    if npm_ready "$pkg" "$cur"; then
      info "published $pkg@$cur"
      return 0
    fi
    if [ $((i % 12)) -eq 0 ]; then
      info "waiting for npm to promote the staged first release... ($((i * 5))s)"
    fi
    sleep 5
  done

  if npm_is_staged "$pkg"; then
    warn "$pkg@$cur is still in npm's staged state (0.0.0-stage placeholder)."
    warn "Do not re-publish. npm usually promotes the real version within a few minutes."
    warn "Check:  npm view $pkg@$cur version"
    warn "If it stays staged: approve it in npmjs.com -> $pkg -> Staged Packages,"
    warn "or run:  npm stage list $pkg  then  npm stage approve <stage-id> --otp=<code>"
    die "first publish of $pkg is still pending after 10 minutes; wait, then rerun this script"
  fi

  die "$pkg@$cur did not appear on npm after 10 minutes"
}

configure_trust() {
  local pkg="$1" repo="$2"

  if npm trust list "$pkg" 2>/dev/null | grep -q "$repo"; then
    info "trusted publisher already configured: $pkg -> $repo/publish.yml"
    return 0
  fi

  say "Trusted Publishing: $pkg -> $repo/publish.yml"
  if [ "$DRY" = "1" ]; then
    info "would run: npm trust github $pkg --file publish.yml --repo $repo --allow-publish --yes"
    return 0
  fi

  if npm trust github "$pkg" --file publish.yml --repo "$repo" --allow-publish --yes; then
    npm trust list "$pkg" 2>/dev/null | sed 's/^/  /' || true
    return 0
  fi

  warn "npm trust failed. Configure it on npmjs.com instead:"
  info "https://www.npmjs.com/package/$pkg"
  info "Settings -> Trusted publishing -> GitHub Actions"
  info "  owner: sqzw-x   repo: ${repo#sqzw-x/}   workflow: publish.yml   allow: npm publish"
  if [ -t 0 ]; then
    read -r -p "Press Enter after configuring $pkg (Ctrl-C to stop)... " _
  else
    die "non-interactive; configure $pkg on npmjs.com and rerun"
  fi
}

bump_and_push() {
  local dir="$1" repo="$2" first="$3"
  local cur
  cur="$(pkg_version "$dir")"

  cd "$dir"

  if [ "$cur" = "$first" ]; then
    say "Bump: $repo $cur -> next patch"
    if [ "$DRY" = "1" ]; then
      info "would run: npm version patch"
      info "would run: git push origin main v<next>"
      return 0
    fi
    npm version patch
    cur="$(pkg_version "$dir")"
  else
    info "$repo already at $cur; will ensure the tag is pushed"
  fi

  if [ "$DRY" = "1" ]; then
    info "would run: git push origin main v$cur"
    return 0
  fi

  git rev-parse "v$cur" >/dev/null 2>&1 || die "tag v$cur is missing in $repo"
  [ -z "$(git status --porcelain)" ] || die "$repo is dirty after the version bump"

  say "Push: $repo main + v$cur"
  local i
  for i in 1 2 3 4 5; do
    if git -c http.version=HTTP/1.1 push origin main "v$cur"; then
      LAST_SHA="$(git rev-parse HEAD)"
      LAST_VERSION="$cur"
      return 0
    fi
    [ "$i" = "5" ] && die "push failed for $repo"
    sleep 3
  done
}

watch_publish() {
  local repo="$1" sha="$2"
  say "Waiting for the Publish workflow: $repo"

  if [ "$DRY" = "1" ]; then
    info "would watch https://github.com/$repo/actions"
    return 0
  fi

  local id="" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    id="$(gh run list -R "$repo" --workflow publish.yml --limit 20 \
      --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId" 2>/dev/null \
      | head -1 || true)"
    [ -n "$id" ] && break
    sleep 5
  done

  if [ -z "$id" ]; then
    warn "could not find the run yet; open https://github.com/$repo/actions"
    return 0
  fi

  if gh run watch "$id" -R "$repo" --exit-status; then
    info "Publish succeeded: https://github.com/$repo/actions/runs/$id"
  else
    warn "Publish failed: https://github.com/$repo/actions/runs/$id"
    return 1
  fi
}

verify_npm_release() {
  local pkg="$1" ver="$2" i
  say "Verify npm: $pkg@$ver"
  for i in $(seq 1 120); do
    if npm_ready "$pkg" "$ver"; then
      info "$pkg@$ver is live (version + tarball)"
      return 0
    fi
    if [ $((i % 12)) -eq 0 ]; then
      info "waiting for npm to finish processing... ($((i * 5))s)"
    fi
    sleep 5
  done
  warn "$pkg@$ver is still not installable after 10 minutes; check https://www.npmjs.com/package/$pkg"
  return 1
}

main() {
  local alerts_version notes_version
  alerts_version="$(pkg_version "$ALERTS_DIR")"
  notes_version="$(pkg_version "$NOTES_DIR")"

  say "Release plan"
  info "dsh-focus-notify  $alerts_version (first: $ALERTS_FIRST)  -> $ALERTS_REPO"
  info "dsh-notes-context $notes_version (first: $NOTES_FIRST)  -> $NOTES_REPO"
  info "first publish: local (no long-lived token), then Trusted Publishing, then one patch via OIDC"
  [ "$DRY" = "1" ] && warn "DRY RUN: nothing will be published, configured, bumped or pushed"

  check_repo "$ALERTS_DIR" "$ALERTS_PKG"
  check_repo "$NOTES_DIR" "$NOTES_PKG"

  if ! npm whoami >/dev/null 2>&1; then
    say "npm login required"
    if [ "$DRY" = "1" ]; then
      info "would run: npm login"
    else
      npm login
    fi
  fi

  if [ "$DRY" = "0" ]; then
    info "npm user: $(npm whoami)"
    info "npm trust: $(npm trust --help >/dev/null 2>&1 && echo available || echo unavailable)"
    read -r -p "Press Enter to publish the first versions (Ctrl-C to stop)... " _
  fi

  first_publish "$ALERTS_DIR" "$ALERTS_PKG" "$ALERTS_FIRST" "initial release"
  first_publish "$NOTES_DIR" "$NOTES_PKG" "$NOTES_FIRST" "initial release"

  if npm trust --help >/dev/null 2>&1; then
    configure_trust "$ALERTS_PKG" "$ALERTS_REPO"
    configure_trust "$NOTES_PKG" "$NOTES_REPO"
  else
    warn "npm trust is not available (needs a recent npm). Configure on npmjs.com:"
    info "https://www.npmjs.com/package/$ALERTS_PKG"
    info "https://www.npmjs.com/package/$NOTES_PKG"
    if [ "$DRY" = "0" ] && [ -t 0 ]; then
      read -r -p "Press Enter after configuring both packages (Ctrl-C to stop)... " _
    fi
  fi

  if [ "$DRY" = "0" ]; then
    read -r -p "Press Enter to bump one patch and push tags... " _
  fi

  bump_and_push "$ALERTS_DIR" "$ALERTS_REPO" "$ALERTS_FIRST"
  local alerts_sha="${LAST_SHA:-}" alerts_next="${LAST_VERSION:-}"
  bump_and_push "$NOTES_DIR" "$NOTES_REPO" "$NOTES_FIRST"
  local notes_sha="${LAST_SHA:-}" notes_next="${LAST_VERSION:-}"

  watch_publish "$ALERTS_REPO" "$alerts_sha" || true
  watch_publish "$NOTES_REPO" "$notes_sha" || true
  if [ "$DRY" = "0" ]; then
    verify_npm_release "$ALERTS_PKG" "$alerts_next" || true
    verify_npm_release "$NOTES_PKG" "$notes_next" || true
  fi

  say "Done"
  if [ "$DRY" = "0" ]; then
    info "npm versions:"
    info "  $ALERTS_PKG@$(npm_latest "$ALERTS_PKG")"
    info "  $NOTES_PKG@$(npm_latest "$NOTES_PKG")"
    info "expected OIDC releases: $ALERTS_PKG@$alerts_next, $NOTES_PKG@$notes_next"
    say "Optional hardening (web, not required for OIDC)"
    info "Open package Settings -> Publishing access and choose"
    info "  Require two-factor authentication and disallow tokens"
    info "  https://www.npmjs.com/package/$ALERTS_PKG/access"
    info "  https://www.npmjs.com/package/$NOTES_PKG/access"
  fi
}

main "$@"
