#!/bin/sh
# Installs the `peers` CLI from its GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh -s -- --version v0.1.0 --dir ~/bin
#
# It downloads the release's peers.js (one bundled file that runs with Bun, no
# compile step), checks its SHA-256, and puts it in ~/.local/bin/peers (or --dir).
# --from-source bundles it from its source with Bun instead. Run with --help for every option.
set -eu

REPO="bdsanxz/peers"
VERSION="${PEERS_VERSION:-latest}"
DIR="${PEERS_INSTALL_DIR:-$HOME/.local/bin}"
FROM_SOURCE=0
ASSET="peers.js"

usage() {
    cat <<EOF
Install the peers CLI from https://github.com/$REPO.

Usage: install.sh [--version vX.Y.Z] [--dir DIR] [--from-source]

  --version vX.Y.Z  Release to install (default: latest; env PEERS_VERSION).
  --dir DIR         Directory for the command (default: ~/.local/bin; env PEERS_INSTALL_DIR).
  --from-source     Bundle the release from its source with Bun instead of downloading it.

peers runs with Bun (https://bun.sh), which must be on PATH.
A private repository needs a token with read access: set GITHUB_TOKEN, or sign in
with the GitHub CLI (gh auth login), whose token is then used.
EOF
}

say() { printf 'peers-install: %s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --version) [ $# -ge 2 ] || die "--version needs a value, such as v0.1.0"; VERSION="$2"; shift 2 ;;
        --dir) [ $# -ge 2 ] || die "--dir needs a directory"; DIR="$2"; shift 2 ;;
        --from-source) FROM_SOURCE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option '$1' (see --help)" ;;
    esac
done
case "$VERSION" in
    latest|v[0-9]*) ;;
    [0-9]*) VERSION="v$VERSION" ;;
    *) die "bad version '$VERSION': use latest or a tag such as v0.1.0" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v bun >/dev/null 2>&1 || die "bun is required to run peers; install it from https://bun.sh and run again"

# The token for a private repository: GITHUB_TOKEN, else the GitHub CLI's.
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
    TOKEN="$(gh auth token 2>/dev/null || true)"
fi

api() { # api <path> : GET a GitHub API path, printing the JSON.
    if [ -n "$TOKEN" ]; then
        curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/$1"
    else
        curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/$1"
    fi
}

asset_url() { # asset_url <release json> <asset name> : the asset's API URL, or nothing.
    # Each asset object lists its "url" before its "name".
    printf '%s\n' "$1" | awk -v want="\"name\": \"$2\"," '
        /"url": "https:\/\/api.github.com\/repos\/.*\/releases\/assets\/[0-9]+"/ { url = $0 }
        index($0, want) { sub(/.*"url": "/, "", url); sub(/".*/, "", url); print url; exit }'
}

download() { # download <asset API URL> <file>
    if [ -n "$TOKEN" ]; then
        curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" -o "$2" "$1"
    else
        curl -fsSL -H "Accept: application/octet-stream" -o "$2" "$1"
    fi
}

mkdir -p "$DIR"
OUT="$DIR/peers"

if [ "$FROM_SOURCE" = 1 ]; then
    die "--from-source needs the repository checkout; run \`bun run build\` there and copy dist/peers.js to $DIR/peers"
fi

if [ "$VERSION" = "latest" ]; then
    REL="$(api "repos/$REPO/releases/latest")"
else
    REL="$(api "repos/$REPO/releases/tags/$VERSION")"
fi
URL="$(asset_url "$REL" "$ASSET")"
SUM_URL="$(asset_url "$REL" "$ASSET.sha256")"
[ -n "$URL" ] || die "no $ASSET asset in release $VERSION"
[ -n "$SUM_URL" ] || die "no $ASSET.sha256 asset in release $VERSION"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
download "$URL" "$TMP/$ASSET"
download "$SUM_URL" "$TMP/$ASSET.sha256"
(cd "$TMP" && sha256sum -c "$ASSET.sha256" >/dev/null) || die "checksum mismatch"
chmod +x "$TMP/$ASSET"
# Point the script at the absolute bun path so it also runs in non-login shells whose PATH lacks bun.
BUN_BIN="$(command -v bun || true)"
if [ -n "$BUN_BIN" ]; then
  sed -i.bak "1s|.*|#!$BUN_BIN|" "$TMP/$ASSET" && rm -f "$TMP/$ASSET.bak"
else
  say "warning: bun is not on PATH; install it (https://bun.sh) for peers to run"
fi
mv "$TMP/$ASSET" "$OUT"
say "installed $OUT"
"$OUT" --version
