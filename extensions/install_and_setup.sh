#!/usr/bin/env bash
# =============================================================================
# install_and_setup.sh
# OpenClaw × MemPlace × GSD — Environment Bootstrap
# Target: Ubuntu 26.04 LTS (Resolute Raccoon)
# Node.js: 24.3+
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# ─── Colour helpers ──────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_section() { echo -e "\n${BOLD}${CYAN}══════════════════════════════════════════${RESET}"; \
                echo -e "${BOLD}${CYAN}  $*${RESET}"; \
                echo -e "${BOLD}${CYAN}══════════════════════════════════════════${RESET}"; }

# ─── §1 OS Version Check ─────────────────────────────────────────────────────
log_section "§1 Operating System Validation"

if [[ -f /etc/os-release ]]; then
  # shellcheck source=/dev/null
  source /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION_ID="${VERSION_ID:-0}"
  log_info "Detected OS: ${PRETTY_NAME:-${OS_ID} ${OS_VERSION_ID}}"

  if [[ "${OS_ID}" != "ubuntu" ]]; then
    log_warn "This script is designed for Ubuntu 26.04 (Resolute Raccoon)."
    log_warn "Detected: ${OS_ID} ${OS_VERSION_ID}. Proceeding with caution."
  else
    # Compare major version as integer
    OS_MAJOR=$(echo "${OS_VERSION_ID}" | cut -d'.' -f1)
    if (( OS_MAJOR < 26 )); then
      log_warn "Ubuntu ${OS_VERSION_ID} detected. Recommended: Ubuntu 26.04+. Proceeding anyway."
    else
      log_ok "Ubuntu ${OS_VERSION_ID} — fully supported."
    fi
  fi
else
  log_warn "Cannot read /etc/os-release. OS unknown. Proceeding with caution."
fi

# ─── §2 Node.js 24.3+ Installation ──────────────────────────────────────────
log_section "§2 Node.js 24.3 Installation via NodeSource"

REQUIRED_MAJOR=24
REQUIRED_MINOR=3

need_node_install=false

if command -v node &>/dev/null; then
  NODE_VERSION_RAW=$(node --version)                          # e.g. v24.1.0
  NODE_VERSION="${NODE_VERSION_RAW#v}"                        # strip leading v
  NODE_MAJOR=$(echo "${NODE_VERSION}" | cut -d'.' -f1)
  NODE_MINOR=$(echo "${NODE_VERSION}" | cut -d'.' -f2)
  log_info "Found Node.js ${NODE_VERSION_RAW}"

  if (( NODE_MAJOR < REQUIRED_MAJOR )) || \
     { (( NODE_MAJOR == REQUIRED_MAJOR )) && (( NODE_MINOR < REQUIRED_MINOR )); }; then
    log_warn "Node.js ${NODE_VERSION} < ${REQUIRED_MAJOR}.${REQUIRED_MINOR}. Will upgrade via NodeSource."
    need_node_install=true
  else
    log_ok "Node.js ${NODE_VERSION} satisfies >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR}. Skipping install."
  fi
else
  log_info "Node.js not found. Installing via NodeSource."
  need_node_install=true
fi

if [[ "${need_node_install}" == "true" ]]; then
  # Ensure curl and gnupg are available
  if ! command -v curl &>/dev/null; then
    log_info "Installing curl..."
    sudo apt-get update -qq
    sudo apt-get install -y curl
  fi

  log_info "Fetching NodeSource setup script for Node.js ${REQUIRED_MAJOR}.x..."
  curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_MAJOR}.x" | sudo -E bash -

  log_info "Installing nodejs package..."
  sudo apt-get install -y nodejs

  # Verify
  INSTALLED_VERSION=$(node --version)
  log_ok "Node.js ${INSTALLED_VERSION} installed successfully."
fi

# Verify npm is available
if ! command -v npm &>/dev/null; then
  log_error "npm not found after Node.js installation. Aborting."
  exit 1
fi
log_info "npm version: $(npm --version)"

# ─── §3 Global npm Packages ──────────────────────────────────────────────────
log_section "§3 Installing Global npm Packages"

install_global_pkg() {
  local pkg="$1"
  log_info "Installing ${pkg} globally..."
  if npm install -g "${pkg}" 2>&1 | tee /tmp/npm_install_"${pkg//\//_}".log; then
    log_ok "${pkg} installed."
  else
    log_error "Failed to install ${pkg}. Check /tmp/npm_install_${pkg//\//_}.log"
    exit 1
  fi
}

install_global_pkg "openclaw@latest"
install_global_pkg "get-shit-done-cc@latest"

# ─── §4 Directory Hierarchy ──────────────────────────────────────────────────
log_section "§4 Creating Plugin Directory Hierarchy"

OPENCLAW_DIR="${HOME}/.openclaw"
EXTENSIONS_DIR="${OPENCLAW_DIR}/extensions"

declare -a DIRS=(
  "${EXTENSIONS_DIR}/memory-memplace/src"
  "${EXTENSIONS_DIR}/gsd-bridge/src"
  "${OPENCLAW_DIR}/workspace"
  "${OPENCLAW_DIR}/workspace/memory"
  "${OPENCLAW_DIR}/workspace/.planning"
)

for dir in "${DIRS[@]}"; do
  if [[ -d "${dir}" ]]; then
    log_info "Directory already exists: ${dir}"
  else
    mkdir -p "${dir}"
    log_ok "Created: ${dir}"
  fi
done

# ─── §5 openclaw.json Configuration ─────────────────────────────────────────
log_section "§5 Generating ~/.openclaw/openclaw.json"

OPENCLAW_CONFIG="${OPENCLAW_DIR}/openclaw.json"

if [[ -f "${OPENCLAW_CONFIG}" ]]; then
  BACKUP_PATH="${OPENCLAW_CONFIG}.bak.$(date +%Y%m%dT%H%M%S)"
  log_warn "Existing openclaw.json found. Backing up to ${BACKUP_PATH}"
  cp "${OPENCLAW_CONFIG}" "${BACKUP_PATH}"
fi

# NOTE: We merge plugin entries into existing config if it exists, or create
# a minimal extension-focused config. jq is used for safe JSON manipulation.
if ! command -v jq &>/dev/null; then
  log_info "Installing jq for JSON manipulation..."
  sudo apt-get install -y jq
fi

# Build the plugin extension block as a temp file
PLUGIN_FRAGMENT=$(mktemp /tmp/oc_plugin_frag.XXXXXX.json)
cat > "${PLUGIN_FRAGMENT}" << 'PLUGIN_JSON'
{
  "memory-memplace": {
    "enabled": true,
    "type": "native",
    "entryPoint": "extensions/memory-memplace/dist/index.js",
    "memorySlot": "memory-memplace",
    "config": {
      "mcpPath": "/usr/local/bin/mempalace",
      "autoRecall": true,
      "autoCapture": true
    }
  },
  "gsd-bridge": {
    "enabled": true,
    "type": "native",
    "entryPoint": "extensions/gsd-bridge/dist/index.js",
    "config": {
      "projectRoot": "",
      "syncIntervalMs": 600000
    }
  }
}
PLUGIN_JSON

if [[ -f "${OPENCLAW_CONFIG}" ]]; then
  # Merge plugin entries into existing plugins.entries object
  log_info "Merging plugin config into existing openclaw.json..."
  MERGED=$(jq --argjson plugins "$(cat "${PLUGIN_FRAGMENT}")" \
    '.plugins.entries = (.plugins.entries // {}) * $plugins' \
    "${OPENCLAW_CONFIG}")
  echo "${MERGED}" > "${OPENCLAW_CONFIG}"
  log_ok "Merged plugin entries into existing openclaw.json."
else
  # Create a fresh minimal config
  cat > "${OPENCLAW_CONFIG}" << 'EOF_CONFIG'
{
  "gateway": {
    "auth": { "mode": "token" },
    "mode": "local",
    "port": 18789,
    "bind": "loopback"
  },
  "agents": {
    "defaults": {
      "workspace": ""
    }
  },
  "tools": { "profile": "coding" },
  "plugins": {
    "entries": {}
  },
  "skills": { "entries": {} }
}
EOF_CONFIG

  # Patch workspace path and merge plugins
  AGENT_WS="${OPENCLAW_DIR}/workspace"
  MERGED=$(jq \
    --arg ws "${AGENT_WS}" \
    --argjson plugins "$(cat "${PLUGIN_FRAGMENT}")" \
    '.agents.defaults.workspace = $ws | .plugins.entries = $plugins' \
    "${OPENCLAW_CONFIG}")
  echo "${MERGED}" > "${OPENCLAW_CONFIG}"
  log_ok "Created fresh openclaw.json at ${OPENCLAW_CONFIG}."
fi

rm -f "${PLUGIN_FRAGMENT}"

# ─── §6 LOOP-QUEUE / LOOP-INBOX seed files ───────────────────────────────────
log_section "§6 Seeding GSD Queue Files"

WORKSPACE_DIR="${OPENCLAW_DIR}/workspace"
QUEUE_FILE="${WORKSPACE_DIR}/LOOP-QUEUE.md"
INBOX_FILE="${WORKSPACE_DIR}/LOOP-INBOX.md"

if [[ ! -f "${QUEUE_FILE}" ]]; then
  cat > "${QUEUE_FILE}" << 'EOF_QUEUE'
# LOOP-QUEUE.md — RalphClaw Execution Queue

> Auto-managed by gsd-bridge plugin. Do not edit manually during active sessions.

<!-- QUEUE_START -->
<!-- QUEUE_END -->
EOF_QUEUE
  log_ok "Created ${QUEUE_FILE}"
else
  log_info "LOOP-QUEUE.md already exists — skipping."
fi

if [[ ! -f "${INBOX_FILE}" ]]; then
  cat > "${INBOX_FILE}" << 'EOF_INBOX'
# LOOP-INBOX.md — Incoming Task Inbox

> Tasks captured here are awaiting triage into LOOP-QUEUE.md.

<!-- INBOX_START -->
<!-- INBOX_END -->
EOF_INBOX
  log_ok "Created ${INBOX_FILE}"
else
  log_info "LOOP-INBOX.md already exists — skipping."
fi

# ─── §7 Summary ──────────────────────────────────────────────────────────────
log_section "✅ Setup Complete"
log_ok "Node.js:            $(node --version)"
log_ok "npm:                $(npm --version)"
log_ok "Extensions dir:     ${EXTENSIONS_DIR}"
log_ok "Config:             ${OPENCLAW_CONFIG}"
log_ok "Queue file:         ${QUEUE_FILE}"
echo ""
log_info "Next steps:"
echo "  1. cd ${EXTENSIONS_DIR}/memory-memplace && npm install && npm run build"
echo "  2. cd ${EXTENSIONS_DIR}/gsd-bridge      && npm install && npm run build"
echo "  3. openclaw reload-plugins"
