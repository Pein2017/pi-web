#!/usr/bin/env bash
set -euo pipefail

pi_web_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$pi_web_root"
export PI_CODING_AGENT_DIR=/data/CoordExp/.pi
export PI_MANAGED_INSTALL_ROOT=/data/CoordExp/codex-tools/pi-core/.local/install
export PI_WEB_FOLLOW_MANAGED_PI=1
unset PI_CODING_AGENT_SESSION_DIR
export PI_WEB_ALLOWED_HOSTS="agegr.pein17.com"
export HTTP_PROXY="http://127.0.0.1:9090"
export HTTPS_PROXY="$HTTP_PROXY" ALL_PROXY="$HTTP_PROXY"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTP_PROXY" all_proxy="$HTTP_PROXY"
export NO_PROXY="localhost,127.0.0.1" no_proxy="localhost,127.0.0.1"
export NODE_USE_ENV_PROXY=1
export TMPDIR="$pi_web_root/.local/tmp"
export XDG_CACHE_HOME="$pi_web_root/.local/cache"
export XDG_STATE_HOME="$pi_web_root/.local/state"
export npm_config_cache="$pi_web_root/.local/npm-cache"
export PATH="/data/CoordExp/bin:/data/CoordExp/codex-tools/pi-core/.local/bin:$PI_CODING_AGENT_DIR/bin:$pi_web_root/node_modules/.bin:$PATH"

test -f "$PI_CODING_AGENT_DIR/settings.json"
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$pi_web_root/.local/logs"
exec >> "$pi_web_root/.local/logs/dev.log" 2>&1
printf '\n[%s] Starting Pi Web from %s; proxy=%s\n' "$(date -u +%FT%TZ)" "$pi_web_root" "$HTTP_PROXY"
node "$pi_web_root/bin/use-shared-pi.cjs" --activate
exec node --require "$pi_web_root/bin/proxy-observation.cjs" \
  "$pi_web_root/node_modules/next/dist/bin/next" dev -H 127.0.0.1 -p 12345
