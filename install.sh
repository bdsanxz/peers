#!/bin/sh
# Installs the `peers` CLI from its GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh -s -- --version v0.1.0 --dir ~/bin
#
# It downloads the release's peers.js (one bundled file that runs with Bun, no
# compile step), checks its SHA-256, and puts it in ~/.local/bin/peers (or --dir).
# Run with --help for every option.
set -eu

REPO="bdsanxz/peers"
VERSION="${PEERS_VERSION:-latest}"
DIR="${PEERS_INSTALL_DIR:-$HOME/.local/bin}"
FORCE="${PEERS_FORCE:-0}"
# Test hooks (not options): PEERS_BASE_URL fetches the assets from a directory
# or URL instead of the GitHub release (for example file://$TMP/fake-release);
# PEERS_ASSET installs one asset name instead of peers.js.
BASE_URL="${PEERS_BASE_URL:-}"
ASSET_OVERRIDE="${PEERS_ASSET:-}"
ASSET="peers.js"

usage() {
    cat <<EOF
Install the peers CLI from https://github.com/$REPO.

Usage: install.sh [--version vX.Y.Z] [--dir DIR] [--force]

  --version vX.Y.Z  Release to install (default: latest; env PEERS_VERSION).
  --dir DIR         Directory for the command (default: ~/.local/bin; env PEERS_INSTALL_DIR).
  --force           Replace the target even when it is a symlink (see below).

peers.js runs with Bun (https://bun.sh), which must be on PATH.
Notifications over herdr-core need hcx 0.3.0, which must be on PATH:
curl -fsSL https://raw.githubusercontent.com/bdsanxz/hcx/main/install.sh | sh
The release's peers.js.sha256 is always verified before anything is installed.

When the target is a symlink (for example ~/.local/bin/peers linked to a repo
build by hand), it is left alone unless --force is given.
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
        --force) FORCE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option '$1' (see --help)" ;;
    esac
done
case "$VERSION" in
    latest|v[0-9]*) ;;
    [0-9]*) VERSION="v$VERSION" ;;
    *) die "bad version '$VERSION': use latest or a tag such as v0.1.0" ;;
esac
case "$DIR" in
    /) ;;
    */) DIR="${DIR%/}" ;;
esac
case "$BASE_URL" in
    */) BASE_URL="${BASE_URL%/}" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"

# Tokens for a private repository. The token is only looked up after an
# unauthenticated request fails with a 404, and it never appears on a command
# line: curl reads it from its stdin config (`-K -`).
token() { # token : GITHUB_TOKEN, else the GitHub CLI's, else nothing.
    if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN"; return 0; fi
    if command -v gh >/dev/null 2>&1; then gh auth token 2>/dev/null || true; fi
}

auth_config() { # auth_config : a curl stdin config carrying the token header, or fail.
    TOKEN="$(token)"
    [ -n "$TOKEN" ] || return 1
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
}

get() { # get <out> <url> [accept] : download url to out, retrying with a token after a 404.
    if curl -fsSL -H "Accept: ${3:-application/octet-stream}" -o "$1" "$2" 2>/dev/null; then return 0; fi
    # Only a 404 justifies the token; anything else is a real failure.
    code="$(curl -sSL -o /dev/null -w "%{http_code}" -H "Accept: ${3:-application/octet-stream}" "$2" 2>/dev/null || true)"
    [ "$code" = "404" ] || return 1
    auth_config | curl -fsSL -K - -H "Accept: ${3:-application/octet-stream}" -o "$1" "$2"
}

api() { # api <path> : GET a GitHub API path, printing the JSON.
    get "$TMP/api.json" "https://api.github.com/$1" "application/vnd.github+json" || return 1
    cat "$TMP/api.json"
}

asset_url() { # asset_url <release json> <asset name> : the asset's API URL, or nothing.
    # Each asset object lists its "url" before its "name".
    printf '%s\n' "$1" | awk -v want="\"name\": \"$2\"," '
        /"url": "https:\/\/api.github.com\/repos\/.*\/releases\/assets\/[0-9]+"/ { url = $0 }
        index($0, want) { sub(/.*"url": "/, "", url); sub(/".*/, "", url); print url; exit }'
}

download() { # download <asset API URL> <file> : GET an asset's bytes.
    get "$2" "$1" "application/octet-stream"
}

need_bun() { # need_bun : die unless Bun can run the asset.
    command -v bun >/dev/null 2>&1 && return 0
    die "bun is required to run peers.js; install it from https://bun.sh and run again"
}

sha256_of() { # sha256_of <file> : print the file's SHA-256 hex digest.
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{ print $1 }'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{ print $1 }'
    else
        die "sha256sum or shasum is required to verify the download"
    fi
}

mkdir -p "$DIR"
OUT="$DIR/peers"

if [ -L "$OUT" ] && [ "$FORCE" != 1 ]; then
    die "$OUT is a symlink to '$(readlink "$OUT")' (for example from a local build); pass --force to replace it"
fi
case ":$PATH:" in
    *":$DIR:"*) ;;
    *) say "warning: $DIR is not on PATH; add it or pass --dir DIR on your PATH" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$OUT.tmp.$$"' EXIT

install_file() { # install_file <file> : move it to $OUT atomically.
    chmod +x "$1"
    cp "$1" "$OUT.tmp.$$"
    chmod +x "$OUT.tmp.$$"
    mv -f "$OUT.tmp.$$" "$OUT"
}

finish() { # finish : report the installed command and its version.
    say "installed $OUT ($VERSION)"
    "$OUT" --version 2>/dev/null | head -2 || "$OUT" --help | head -1
}

if [ -n "$ASSET_OVERRIDE" ]; then
    ASSET="$ASSET_OVERRIDE"
fi
need_bun

if [ -n "$BASE_URL" ]; then
    curl -fsSL -o "$TMP/$ASSET" "$BASE_URL/$ASSET" || die "could not download $ASSET from $BASE_URL"
    curl -fsSL -o "$TMP/$ASSET.sha256" "$BASE_URL/$ASSET.sha256" || die "could not download $ASSET.sha256 from $BASE_URL"
else
    if [ "$VERSION" = "latest" ]; then
        REL="$(api "repos/$REPO/releases/latest")"
    else
        REL="$(api "repos/$REPO/releases/tags/$VERSION")"
    fi
    URL="$(asset_url "$REL" "$ASSET")"
    SUM_URL="$(asset_url "$REL" "$ASSET.sha256")"
    [ -n "$URL" ] || die "no $ASSET asset in release $VERSION"
    [ -n "$SUM_URL" ] || die "no $ASSET.sha256 asset in release $VERSION"
    download "$URL" "$TMP/$ASSET" || die "could not download $ASSET from release $VERSION"
    download "$SUM_URL" "$TMP/$ASSET.sha256" || die "could not download $ASSET.sha256 from release $VERSION"
fi

WANT="$(awk -v want="$ASSET" '$2 == want { print $1 }' "$TMP/$ASSET.sha256")"
[ -n "$WANT" ] || die "no checksum for $ASSET in $ASSET.sha256; leaving any existing $OUT untouched"
GOT="$(sha256_of "$TMP/$ASSET")"
[ "$GOT" = "$WANT" ] || die "checksum mismatch for $ASSET (expected $WANT, got $GOT); leaving any existing $OUT untouched"
install_file "$TMP/$ASSET"
finish
