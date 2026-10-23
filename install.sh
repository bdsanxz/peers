#!/bin/sh
# Installs the `peers` CLI from its GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh -s -- --version v0.0.1 --dir ~/bin
#
# It downloads the prebuilt binary for this machine, checks its SHA-256, and puts it in
# ~/.local/bin (or --dir). When no prebuilt binary matches this machine, it builds the
# release from source with cargo. Run with --help for every option.
set -eu

REPO="bdsanxz/peers"
VERSION="${PEERS_VERSION:-latest}"
DIR="${PEERS_INSTALL_DIR:-$HOME/.local/bin}"
FROM_SOURCE=0

usage() {
    cat <<EOF
Install the peers CLI from https://github.com/$REPO.

Usage: install.sh [--version vX.Y.Z] [--dir DIR] [--from-source]

  --version vX.Y.Z  Release to install (default: latest; env PEERS_VERSION).
  --dir DIR         Directory for the binary (default: ~/.local/bin; env PEERS_INSTALL_DIR).
  --from-source     Build the release with cargo instead of downloading a binary.

A private repository needs a token with read access: set GITHUB_TOKEN, or sign in
with the GitHub CLI (gh auth login), whose token is then used.
EOF
}

say() { printf 'peers-install: %s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --version) [ $# -ge 2 ] || die "--version needs a value, such as v0.0.1"; VERSION="$2"; shift 2 ;;
        --dir) [ $# -ge 2 ] || die "--dir needs a directory"; DIR="$2"; shift 2 ;;
        --from-source) FROM_SOURCE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option '$1' (see --help)" ;;
    esac
done
case "$VERSION" in
    latest|v[0-9]*) ;;
    [0-9]*) VERSION="v$VERSION" ;;
    *) die "bad version '$VERSION': use latest or a tag such as v0.0.1" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

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

target() { # The Rust target triple of this machine.
    os="$(uname -s)"; arch="$(uname -m)"
    case "$arch" in
        arm64|aarch64) arch=aarch64 ;;
        x86_64|amd64) arch=x86_64 ;;
        *) die "unsupported CPU '$arch'" ;;
    esac
    case "$os" in
        Darwin) echo "$arch-apple-darwin" ;;
        Linux) echo "$arch-unknown-linux-gnu" ;;
        *) die "unsupported OS '$os'; peers runs on macOS and Linux" ;;
    esac
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

sha256() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    else sha256sum "$1" | cut -d' ' -f1; fi
}

build_from_source() { # build_from_source <tag>
    command -v cargo >/dev/null 2>&1 || die "no prebuilt binary for $(target), and cargo is not installed to build one; install Rust from https://rustup.rs and run again"
    say "building $1 from source with cargo"
    root="$(dirname "$DIR")"
    [ "$(basename "$DIR")" = bin ] || die "--from-source installs into <prefix>/bin; pass a --dir that ends in /bin"
    # The git CLI uses your credential helper, so a private repository works when git can clone it.
    CARGO_NET_GIT_FETCH_WITH_CLI=true cargo install --locked --git "https://github.com/$REPO" --tag "$1" --root "$root" peers
}

TARGET="$(target)"
ASSET="peers-$TARGET.tar.gz"

if [ "$VERSION" = latest ]; then
    RELEASE="$(api "repos/$REPO/releases/latest")" || die "cannot read the latest release of $REPO. A private repository needs GITHUB_TOKEN or a signed-in gh (see --help)."
else
    RELEASE="$(api "repos/$REPO/releases/tags/$VERSION")" || die "cannot read release $VERSION of $REPO: it does not exist, or the repository is private and needs GITHUB_TOKEN or a signed-in gh (see --help)."
fi
TAG="$(printf '%s\n' "$RELEASE" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
[ -n "$TAG" ] || die "the release answer from GitHub has no tag_name"

mkdir -p "$DIR"
if [ "$FROM_SOURCE" = 1 ]; then
    build_from_source "$TAG"
else
    URL="$(asset_url "$RELEASE" "$ASSET")"
    SUM_URL="$(asset_url "$RELEASE" "$ASSET.sha256")"
    if [ -z "$URL" ]; then
        say "release $TAG has no prebuilt binary for $TARGET"
        build_from_source "$TAG"
    else
        TMP="$(mktemp -d)"
        trap 'rm -rf "$TMP"' EXIT
        say "downloading $ASSET from release $TAG"
        download "$URL" "$TMP/$ASSET" || die "download of $ASSET failed"
        if [ -n "$SUM_URL" ]; then
            download "$SUM_URL" "$TMP/$ASSET.sha256" || die "download of $ASSET.sha256 failed"
            want="$(cut -d' ' -f1 <"$TMP/$ASSET.sha256")"
            got="$(sha256 "$TMP/$ASSET")"
            [ "$want" = "$got" ] || die "checksum mismatch for $ASSET: expected $want, got $got"
        else
            say "warning: release $TAG has no $ASSET.sha256; the download is not verified"
        fi
        tar -xzf "$TMP/$ASSET" -C "$TMP"
        [ -f "$TMP/peers" ] || die "$ASSET does not contain a peers binary"
        chmod 755 "$TMP/peers"
        mv -f "$TMP/peers" "$DIR/peers"
    fi
fi

say "installed $("$DIR/peers" --version) at $DIR/peers"
case ":$PATH:" in
    *":$DIR:"*) ;;
    *) say "add $DIR to your PATH, for example: echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.zshrc" ;;
esac
