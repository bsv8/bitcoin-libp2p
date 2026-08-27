#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -x typescript/node_modules/.bin/playwright ]]; then
  echo "Playwright is not installed. Run: cd typescript && npm install" >&2
  exit 2
fi

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/bitcoin-libp2p-browser.XXXXXX")"
server_pids=()
server_fds=()

cleanup() {
  local status=$?
  set +e
  for pid in "${server_pids[@]:-}"; do kill -TERM -- "-$pid" 2>/dev/null || true; kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${server_pids[@]:-}"; do
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL -- "-$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
  for fd in "${server_fds[@]:-}"; do eval "exec ${fd}>&-"; done
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 ]]; then
    echo "browser integration failed; logs retained at $run_dir" >&2
  else
    rm -rf "$run_dir"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

SERVER_KEY=278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a
EXPECTED_SERVER_PUBLIC_KEY=02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46
EXPECTED_SERVER_PEER_ID=16Uiu2HAmB8C2R7pBJu1z2u1gno7aXcbtkoUzrknTFN2EBLjRavKP

start_go_server() {
  local transport="$1"
  local fifo="$run_dir/${transport}.fifo"
  mkfifo "$fifo"
  local control_fd
  exec {control_fd}<>"$fifo"
  server_fds+=("$control_fd")
  setsid go run -C integration/native-go . -mode server -transport "$transport" -key "$SERVER_KEY" <&"$control_fd" >"$run_dir/${transport}.log" 2>&1 &
  server_pids+=("$!")
  for _ in $(seq 1 300); do
    if rg -m1 '^READY ' "$run_dir/${transport}.log" >"$run_dir/${transport}.ready" 2>/dev/null; then
      read -r _ server_id server_addr server_public_key <"$run_dir/${transport}.ready"
      if [[ "$server_id" != "$EXPECTED_SERVER_PEER_ID" || "$server_public_key" != "$EXPECTED_SERVER_PUBLIC_KEY" ]]; then
        echo "server identity mismatch: id=$server_id public_key=$server_public_key" >&2
        return 1
      fi
      export server_addr
      return 0
    fi
    if ! kill -0 "${server_pids[-1]}" 2>/dev/null; then
      tail -n 80 "$run_dir/${transport}.log" >&2
      return 1
    fi
    sleep 0.1
  done
  tail -n 80 "$run_dir/${transport}.log" >&2
  return 1
}

start_http_server() {
  local fifo="$run_dir/http.fifo"
  mkfifo "$fifo"
  local control_fd
  exec {control_fd}<>"$fifo"
  server_fds+=("$control_fd")
  setsid node integration/browser/server.mjs typescript/dist-integration 0 <&"$control_fd" >"$run_dir/http.log" 2>&1 &
  server_pids+=("$!")
  for _ in $(seq 1 100); do
    if rg -m1 '^READY ' "$run_dir/http.log" >"$run_dir/http.ready" 2>/dev/null; then
      read -r _ http_port <"$run_dir/http.ready"
      export http_port
      return 0
    fi
    if ! kill -0 "${server_pids[-1]}" 2>/dev/null; then
      tail -n 80 "$run_dir/http.log" >&2
      return 1
    fi
    sleep 0.1
  done
  tail -n 80 "$run_dir/http.log" >&2
  return 1
}

run_browser() {
  local transport="$1"
  local scenario="${2:-}"
  local args=(--transport "$transport" --addr "$server_addr" --http-port "$http_port")
  if [[ -n "$scenario" ]]; then args+=(--scenario "$scenario"); fi
  local label="$transport-${scenario:-success}"
  node typescript/integration/browser-runner.mjs "${args[@]}" 2>&1 | tee "$run_dir/${label}.browser.log"
}

(cd typescript && npm run build:browser)
start_http_server

start_go_server websocket
run_browser websocket
run_browser websocket pending
run_browser websocket exit
run_browser websocket stop

start_go_server webrtc-direct
run_browser webrtc-direct

echo "browser WebSocket and WebRTC Direct integration passed"
