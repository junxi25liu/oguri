#!/bin/sh
# oguri installer.
#
# Short on purpose: anyone about to pipe this into a shell should be able to
# read it first. It does four things — work out which artifact you need, fetch
# it, VERIFY ITS CHECKSUM, and put it on your PATH.
#
#   curl -fsSL https://github.com/junxi25liu/oguri/releases/latest/download/install.sh | bash
#
# Three ways in, for a repository that may be private:
#
#   1. A release binary. Needs `gh` signed in (private) or curl (public).
#        ./install.sh
#   2. A binary you already have, for example built with `pnpm binary` and
#      copied over with scp. Needs nothing from GitHub.
#        ./install.sh --from-binary ./oguri
#   3. Source. Needs git, Node 24+ and pnpm; builds a clone, or a checkout you
#      already have with --source-dir.
#        ./install.sh --from-source
#        ./install.sh --source-dir ~/code/oguri
#
# Options (env or flag):
#   OGURI_VERSION=v1.0.0        install a specific release        (--version)
#   OGURI_INSTALL_DIR=~/bin     where to put the binary           (--install-dir)
#   OGURI_FROM_SOURCE=1         clone and build instead           (--from-source)
#   OGURI_SOURCE_DIR=~/oguri    build this checkout, no clone     (--source-dir)
#   OGURI_BINARY=./oguri        install this binary, no download  (--from-binary)
#
# It never uses sudo, never edits your shell rc files, and never asks for a
# token — while the repository is private it delegates to your existing git and
# gh credentials.

set -eu

# Never block on a credential prompt nobody can see. In a piped `curl | bash`
# there is no usable terminal, so a prompt would look like a silent hang; the
# https attempt must fail fast so the ssh fallback gets its turn.
export GIT_TERMINAL_PROMPT=0

REPO="junxi25liu/oguri"
BIN_NAME="oguri"
INSTALL_DIR="${OGURI_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${OGURI_VERSION:-latest}"
FROM_SOURCE="${OGURI_FROM_SOURCE:-0}"
SOURCE_DIR="${OGURI_SOURCE_DIR:-}"
BINARY="${OGURI_BINARY:-}"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version)      VERSION="${2:?--version needs a value}"; shift 2 ;;
    --install-dir)  INSTALL_DIR="${2:?--install-dir needs a value}"; shift 2 ;;
    --from-source)  FROM_SOURCE=1; shift ;;
    --source-dir)   SOURCE_DIR="${2:?--source-dir needs a directory}"; FROM_SOURCE=1; shift 2 ;;
    --from-binary)  BINARY="${2:?--from-binary needs a file}"; shift 2 ;;
    -h|--help)      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------- platform

detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows is not packaged yet — no win32 artifact is published.
Use WSL, or build from source:  ./install.sh --from-source" ;;
    *) die "unsupported operating system: $os" ;;
  esac
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64)  arch=x64 ;;
    *) die "unsupported architecture: $arch" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# ------------------------------------------------------------------ source

install_from_source() {
  say "Building oguri from source."
  if [ -n "$SOURCE_DIR" ]; then
    [ -f "$SOURCE_DIR/packages/cli/package.json" ] \
      || die "$SOURCE_DIR is not an oguri checkout (no packages/cli/package.json)"
  fi
  have git || die "git is required to build from source"
  have node || die "Node 24+ is required to build from source (https://nodejs.org)"

  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 24 ] || die "Node 24+ required to build from source; found $(node -v)"

  have pnpm || die "pnpm is required to build from source: npm i -g pnpm"

  if [ -n "$SOURCE_DIR" ]; then
    # A checkout you already have: no clone, no network beyond the dependency install.
    root="$(cd "$SOURCE_DIR" && pwd)"
  else
    src="$(mktemp -d)"
    trap 'rm -rf "$src"' EXIT
    # Uses your existing git credentials — works while the repo is private, and
    # means this script never handles a token.
    git clone --quiet --depth 1 "https://github.com/$REPO.git" "$src/oguri" \
      || git clone --quiet --depth 1 "git@github.com:$REPO.git" "$src/oguri" \
      || die "could not clone $REPO — check your GitHub access"
    root="$src/oguri"
  fi

  ( cd "$root" && pnpm install --frozen-lockfile --silent && pnpm build ) \
    || die "build failed"

  [ -f "$root/packages/cli/dist/bin.js" ] || die "build produced no CLI entry point"

  # The CLI is not bundled, so it needs its package tree and node_modules beside
  # it. Install the built workspace into a versioned library directory and put a
  # tiny launcher on PATH — copying bin.js alone would leave its relative
  # imports and workspace deps unresolvable.
  libdir="${OGURI_LIB_DIR:-$HOME/.oguri/lib}"
  rm -rf "$libdir"
  mkdir -p "$libdir"
  ( cd "$root" && tar cf - packages node_modules package.json ) | ( cd "$libdir" && tar xf - ) \
    || die "could not stage the build into $libdir"

  mkdir -p "$INSTALL_DIR"
  cat > "$INSTALL_DIR/$BIN_NAME" <<LAUNCHER
#!/bin/sh
exec node "$libdir/packages/cli/dist/bin.js" "\$@"
LAUNCHER
  chmod 0755 "$INSTALL_DIR/$BIN_NAME"
}

# ----------------------------------------------------------------- release

resolve_version() {
  [ "$VERSION" != "latest" ] && { printf '%s' "$VERSION"; return; }
  if have gh; then
    gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null && return
  fi
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1
}

# `gh` reaches a private repository's release assets with your own sign-in;
# plain curl cannot, and answers 404.
gh_ready() { have gh && gh auth status >/dev/null 2>&1; }

install_from_release() {
  gh_ready || have curl || die "need gh (signed in) or curl to download a release"
  target="$(detect_target)"

  resolved="$(resolve_version || true)"
  [ -n "$resolved" ] || die "no published release found.
oguri has not cut its first release yet, or this repository is private and gh is not signed in.
Either run 'gh auth login', or use one of:
  ./install.sh --from-source               clone and build (needs git, Node 24+, pnpm)
  ./install.sh --source-dir <checkout>     build a checkout you already have
  ./install.sh --from-binary <file>        install a binary built with 'pnpm binary'"

  # Must match the naming in .github/workflows/release.yml, which asserts this
  # agreement at publish time so a drift here cannot reach users as a 404.
  archive="$BIN_NAME-$resolved-$target.tar.gz"
  base="https://github.com/$REPO/releases/download/$resolved"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  fetch() {
    if gh_ready && gh release download "$resolved" --repo "$REPO" --pattern "$1" --dir "$tmp" --clobber >/dev/null 2>&1; then
      return 0
    fi
    have curl && curl -fsSL "$base/$1" -o "$tmp/$1"
  }

  say "Downloading $archive"
  fetch "$archive" || die "download failed: $archive (a private repository needs 'gh auth login')"
  fetch SHA256SUMS || die "could not fetch SHA256SUMS"

  # Mandatory, never opt-in: this script installs software that then runs
  # continuously, so an unverified download is not acceptable.
  say "Verifying checksum"
  expected="$(grep " $archive\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
  [ -n "$expected" ] || die "$archive is not listed in SHA256SUMS"

  if have sha256sum; then actual="$(sha256sum "$tmp/$archive" | awk '{print $1}')"
  elif have shasum;  then actual="$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')"
  else die "need sha256sum or shasum to verify the download"
  fi

  [ "$expected" = "$actual" ] || die "CHECKSUM MISMATCH for $archive
  expected $expected
  actual   $actual
Refusing to install. This may indicate a corrupted download or tampering."

  tar -xzf "$tmp/$archive" -C "$tmp"
  [ -f "$tmp/$BIN_NAME" ] || die "archive did not contain $BIN_NAME"
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$tmp/$BIN_NAME" "$INSTALL_DIR/$BIN_NAME"
}

# ------------------------------------------------------------------ binary

# A binary you built or were handed. Nothing is downloaded, so there is no
# checksum to check; it is exactly the file you named. It must run here, which
# the check after install proves: a binary is built per platform and cannot be
# copied between macOS and Linux, or between arm64 and x64.
install_from_binary() {
  [ -f "$BINARY" ] || die "no such file: $BINARY"
  mkdir -p "$INSTALL_DIR"
  install -m 0755 "$BINARY" "$INSTALL_DIR/$BIN_NAME"
}

# -------------------------------------------------------------------- main

if [ -n "$BINARY" ]; then install_from_binary
elif [ "$FROM_SOURCE" = "1" ]; then install_from_source
else install_from_release; fi

"$INSTALL_DIR/$BIN_NAME" --version >/dev/null 2>&1 \
  || die "installed binary did not run: $INSTALL_DIR/$BIN_NAME
A binary is built per platform ($(detect_target 2>/dev/null || uname -sm) here). Build one on this kind of machine with 'pnpm binary', or use --from-source."

say ""
say "oguri installed to $INSTALL_DIR/$BIN_NAME"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  # Print the line rather than editing rc files: silently rewriting someone's
  # shell config is not a thing an installer should do.
  *) say ""
     say "$INSTALL_DIR is not on your PATH. Add it:"
     say "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

say ""
say "Next:  oguri init --repo <your-transport-repo-url>"
