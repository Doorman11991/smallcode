#!/usr/bin/env bash
# smallcode — one-line installer for Linux & macOS
#
# Downloads the platform-specific portable tarball from GitHub Releases
# and installs it locally. No npm / node-gyp build tools needed.
#
# Usage:  bash <(curl -fsSL https://raw.githubusercontent.com/Zireael/smallcode/main/install.sh)
#
# Environment variables (all optional):
#   SMALLCODE_HOME   Install directory  (default: ~/.smallcode)
#   SMALLCODE_REPO   GitHub repo        (default: Zireael/smallcode)
#   SMALLCODE_VER    Release version    (default: latest)
set -euo pipefail

# ---- config ---------------------------------------------------------------
REPO="${SMALLCODE_REPO:-Doorman11991/smallcode}"
VERSION="${SMALLCODE_VER:-latest}"
INSTALL_DIR="${SMALLCODE_HOME:-${HOME}/.smallcode}"

# ---- detect platform ------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}" in
  Linux)  PLATFORM="Linux"  ;;
  Darwin) PLATFORM="macOS"  ;;
  *)      echo "Unsupported OS: ${OS}"; exit 1 ;;
esac

case "${ARCH}" in
  x86_64|amd64)  ARCH_TAG="X64"   ;;
  aarch64|arm64) ARCH_TAG="Arm64" ;;
  *)             echo "Unsupported architecture: ${ARCH}"; exit 1 ;;
esac

PLATFORM_TAG="${PLATFORM}-${ARCH_TAG}"
BUNDLE="smallcode-${PLATFORM_TAG}.tar.gz"

if [ "${VERSION}" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${BUNDLE}"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${BUNDLE}"
fi

# ---- intro ----------------------------------------------------------------
cat <<INFO
==> smallcode installer
    Platform    ${PLATFORM_TAG}
    Install to  ${INSTALL_DIR}
    Version     ${VERSION}
INFO

# ---- download -------------------------------------------------------------
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

echo "==> Downloading ${DOWNLOAD_URL} …"
curl -fsSL "${DOWNLOAD_URL}" -o "${TMPDIR}/${BUNDLE}"

# ---- extract --------------------------------------------------------------
echo "==> Extracting …"
mkdir -p "${INSTALL_DIR}"
tar xzf "${TMPDIR}/${BUNDLE}" -C "${INSTALL_DIR}" --strip-components=1

# ---- launcher wrapper -----------------------------------------------------
LAUNCHER="${INSTALL_DIR}/smallcode"
cat > "${LAUNCHER}" << 'LAUNCHER_EOF'
#!/bin/sh
# smallcode wrapper — resolves bundled node_modules automatically
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
NODE_PATH="${SCRIPT_DIR}/node_modules" exec node "${SCRIPT_DIR}/bin/smallcode.js" "$@"
LAUNCHER_EOF
chmod +x "${LAUNCHER}"

# ---- symlink into PATH ----------------------------------------------------
BIN_DIR="${HOME}/.local/bin"
mkdir -p "${BIN_DIR}"
ln -sf "${LAUNCHER}" "${BIN_DIR}/smallcode"

# If ~/.local/bin isn't on PATH yet, add it to shell rc
if ! echo "${PATH}" | tr ':' '\n' | grep -qFx "${BIN_DIR}"; then
  SHELL_CONFIG=""
  case "${SHELL}" in
    */zsh)  SHELL_CONFIG="${HOME}/.zshrc"  ;;
    */bash) SHELL_CONFIG="${HOME}/.bashrc" ;;
  esac
  if [ -n "${SHELL_CONFIG}" ]; then
    echo "export PATH=\"\${PATH}:${BIN_DIR}\"" >> "${SHELL_CONFIG}"
    echo "==> Added ${BIN_DIR} to PATH in ${SHELL_CONFIG}"
    echo "    Restart your shell or run: export PATH=\"\$PATH:${BIN_DIR}\""
  else
    echo "==> Add ${BIN_DIR} to your PATH manually"
  fi
fi

cat <<DONE

==> Done!  Run 'smallcode --help' to verify.
DONE
