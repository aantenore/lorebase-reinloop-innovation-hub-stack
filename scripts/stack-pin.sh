#!/usr/bin/env bash
# Refresh the vendored agent-layers and agent-plexus packages: build them from their repositories, pack the tarballs
# into vendor/agent-layers and vendor/agent-plexus, point package.json at them and reinstall.
# Temporary: once the packages are on npm, replace the file: dependencies with ranges (^0.4.0 and ^0.2.0) and drop
# vendor/agent-layers, vendor/agent-plexus and this script.
#
# Usage: npm run stack:pin -- [--no-install] [agent-layers|agent-plexus ...]   (default: both)
# Environment (all optional):
#   AGENT_LAYERS_DIR       agent-layers checkout   (default $HOME/Documents/Projects/agent-layers)
#   AGENT_PLEXUS_DIR       agent-plexus checkout   (default $HOME/Documents/Projects/agent-plexus)
#   AGENT_LAYERS_PACKAGES  workspace folders to pack, space separated (default "core adapters")
#   AGENT_PLEXUS_PACKAGES  same for agent-plexus     (default "core adapters")
#   STACK_PIN_REF          git ref to build from a clean export of the checkout; empty (default): its working tree
#   STACK_PIN_VENDOR       output folder           (default <repo>/vendor)
# Same-version repacks: npm keeps the old integrity of a file: dependency, so `npm ci` would install stale cached code.
# Hence the lock entries of the repacked packages are dropped (with their installed folders) before `npm install`
# re-resolves them; with --no-install only their integrity in package-lock.json is rewritten from the new tarballs.
# --no-install otherwise leaves package.json and node_modules as they are.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="${STACK_PIN_VENDOR:-$ROOT/vendor}"
REF="${STACK_PIN_REF:-}"
INSTALL=1
REPOS=()
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    agent-layers|agent-plexus) REPOS+=("$arg") ;;
    *) echo "[pin] unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ ${#REPOS[@]} -gt 0 ] || REPOS=(agent-layers agent-plexus)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pin() {
  local repo="$1" scope="@$1" src packages
  case "$repo" in
    agent-layers) src="${AGENT_LAYERS_DIR:-$HOME/Documents/Projects/agent-layers}"; packages="${AGENT_LAYERS_PACKAGES:-core adapters}" ;;
    agent-plexus) src="${AGENT_PLEXUS_DIR:-$HOME/Documents/Projects/agent-plexus}"; packages="${AGENT_PLEXUS_PACKAGES:-core adapters}" ;;
  esac
  [ -d "$src" ] || { echo "[pin] $repo checkout not found: $src (set the *_DIR variable)" >&2; exit 1; }
  src="$(cd "$src" && pwd)"
  local build="$src"
  if [ -n "$REF" ]; then
    build="$WORK/$repo-src"
    mkdir -p "$build"
    git -C "$src" archive "$REF" | tar -x -C "$build"
    (cd "$build" && npm install --no-audit --no-fund --silent)
  elif [ -n "$(git -C "$src" status --porcelain 2>/dev/null)" ]; then
    echo "[pin] $repo working tree has uncommitted changes: they go into the tarballs (use STACK_PIN_REF=HEAD for the committed state)" >&2
  fi
  (cd "$build" && node scripts/build-packages.mjs >/dev/null)
  local out="$WORK/$repo-out"
  mkdir -p "$out" "$VENDOR/$repo"
  for p in $packages; do
    (cd "$build" && npm pack --workspace "packages/$p" --pack-destination "$out" --silent >/dev/null)
  done
  # Older tarballs of the same packages go away; the new ones take their place.
  for p in $packages; do
    rm -f "$VENDOR/$repo/$repo-$p-"*.tgz
  done
  cp "$out"/*.tgz "$VENDOR/$repo/"
  if [ "$INSTALL" = 1 ]; then
    node -e '
      const fs = require("fs"); const path = require("path");
      const [pkgFile, vendor, repo, scope, packages] = process.argv.slice(1);
      const j = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      for (const p of packages.split(" ").filter(Boolean)) {
        const file = fs.readdirSync(path.join(vendor, repo)).find((f) => f.startsWith(`${repo}-${p}-`) && f.endsWith(".tgz"));
        if (!file) throw new Error(`no tarball for ${scope}/${p}`);
        j.dependencies[`${scope}/${p}`] = "file:" + path.relative(path.dirname(pkgFile), path.join(vendor, repo, file));
      }
      j.dependencies = Object.fromEntries(Object.entries(j.dependencies).sort(([a], [b]) => a.localeCompare(b)));
      fs.writeFileSync(pkgFile, JSON.stringify(j, null, 2) + "\n");
    ' "$ROOT/package.json" "$VENDOR" "$repo" "$scope" "$packages"
  fi
  node -e '
    const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
    const [root, vendor, repo, scope, packages, install] = process.argv.slice(1);
    const lockFile = path.join(root, "package-lock.json");
    if (!fs.existsSync(lockFile)) process.exit(0);
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    for (const p of packages.split(" ").filter(Boolean)) {
      const key = `node_modules/${scope}/${p}`;
      const entry = lock.packages && lock.packages[key];
      if (!entry) continue;
      if (install === "1") {
        delete lock.packages[key];
        fs.rmSync(path.join(root, key), { recursive: true, force: true });
      } else if (typeof entry.resolved === "string" && entry.resolved.startsWith("file:")) {
        const tgz = path.join(root, entry.resolved.slice(5));
        if (fs.existsSync(tgz)) entry.integrity = "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(tgz)).digest("base64");
      }
    }
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
  ' "$ROOT" "$VENDOR" "$repo" "$scope" "$packages" "$INSTALL"
  echo "[pin] $repo ($(git -C "$src" rev-parse --short "${REF:-HEAD}")${REF:+, clean export}): $(cd "$VENDOR/$repo" && ls *.tgz | tr '\n' ' ')"
}

for repo in "${REPOS[@]}"; do pin "$repo"; done
if [ "$INSTALL" = 1 ]; then (cd "$ROOT" && npm install --no-audit --no-fund --silent); fi
