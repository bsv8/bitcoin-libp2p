#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -x typescript/node_modules/.bin/playwright ]]; then
  echo "Playwright is not installed. Run: cd typescript && npm ci" >&2
  exit 2
fi

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/bitcoin-libp2p-browser.XXXXXX")"
server_pids=()
server_fds=()

cleanup() {
  local status=$?
  set +e
  for pid in "${server_pids[@]:-}"; do
    [[ -n "$pid" ]] || continue
    kill -TERM -- "-$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${server_pids[@]:-}"; do
    [[ -n "$pid" ]] || continue
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
  for fd in "${server_fds[@]:-}"; do
    [[ -n "$fd" ]] || continue
    eval "exec ${fd}>&-"
  done
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
BROWSER_WEBSOCKET_REPEATS="${BROWSER_WEBSOCKET_REPEATS:-20}"
BROWSER_DIRECT_REPEATS="${BROWSER_DIRECT_REPEATS:-20}"
BROWSER_TEST_MODE="${BROWSER_TEST_MODE:-acceptance}"
if [[ ! "$BROWSER_WEBSOCKET_REPEATS" =~ ^[1-9][0-9]*$ || ! "$BROWSER_DIRECT_REPEATS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BROWSER_WEBSOCKET_REPEATS and BROWSER_DIRECT_REPEATS must be positive integers" >&2
  exit 2
fi
if [[ "$BROWSER_TEST_MODE" != "acceptance" && "$BROWSER_TEST_MODE" != "smoke" ]]; then
  echo "BROWSER_TEST_MODE must be acceptance or smoke" >&2
  exit 2
fi
if [[ "$BROWSER_TEST_MODE" == "acceptance" && ( "$BROWSER_WEBSOCKET_REPEATS" -lt 20 || "$BROWSER_DIRECT_REPEATS" -lt 20 ) ]]; then
  echo "acceptance mode requires at least 20 WebSocket and 20 WebRTC Direct repetitions; use BROWSER_TEST_MODE=smoke for a shorter diagnostic run" >&2
  exit 2
fi

start_go_server() {
  local transport="$1"
  local label="${2:-$transport}"
  local cert_args=()
  if [[ "${3:-}" == "rotate" ]]; then cert_args=(-rotate-cert); fi
  local fifo="$run_dir/${label}.fifo"
  mkfifo "$fifo"
  local control_fd
  exec {control_fd}<>"$fifo"
  server_fds+=("$control_fd")
  setsid go run -C integration/native-go . -mode server -transport "$transport" -key "$SERVER_KEY" "${cert_args[@]}" <&"$control_fd" >"$run_dir/${label}.log" 2>&1 &
  server_pids+=("$!")
  for _ in $(seq 1 300); do
    if rg -m1 '^READY ' "$run_dir/${label}.log" >"$run_dir/${label}.ready" 2>/dev/null; then
      read -r _ server_id server_addr server_public_key <"$run_dir/${label}.ready"
      if [[ "$server_id" != "$EXPECTED_SERVER_PEER_ID" || "$server_public_key" != "$EXPECTED_SERVER_PUBLIC_KEY" ]]; then
        echo "server identity mismatch: id=$server_id public_key=$server_public_key" >&2
        return 1
      fi
      export server_addr
      return 0
    fi
    if ! kill -0 "${server_pids[-1]}" 2>/dev/null; then
      tail -n 80 "$run_dir/${label}.log" >&2
      return 1
    fi
    sleep 0.1
  done
  tail -n 80 "$run_dir/${label}.log" >&2
  return 1
}

stop_last_go_server() {
  local index=$((${#server_pids[@]} - 1))
  local pid="${server_pids[$index]}"
  local fd="${server_fds[$index]}"
  kill -TERM -- "-$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  eval "exec ${fd}>&-"
  server_pids[$index]=""
  server_fds[$index]=""
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
  local address="${3:-$server_addr}"
  local args=(--transport "$transport" --addr "$address" --http-port "$http_port")
  if [[ -n "$scenario" ]]; then args+=(--scenario "$scenario"); fi
  local label="$transport-${scenario:-success}"
  node typescript/integration/browser-runner.mjs "${args[@]}" 2>&1 | tee "$run_dir/${label}.browser.log"
}

(cd typescript && npm run build:browser)
start_http_server

start_go_server websocket
for attempt in $(seq 1 "$BROWSER_WEBSOCKET_REPEATS"); do
  echo "WebSocket browser repetition $attempt/$BROWSER_WEBSOCKET_REPEATS"
  run_browser websocket
done
run_browser websocket pending
run_browser websocket exit
run_browser websocket stop

start_go_server webrtc-direct
# Each invocation is an independent browser scenario. With set -e, the first
# failure stops the suite; this is repetition evidence, not retry-on-failure.
for attempt in $(seq 1 "$BROWSER_DIRECT_REPEATS"); do
  echo "WebRTC Direct browser repetition $attempt/$BROWSER_DIRECT_REPEATS"
  run_browser webrtc-direct
done
for scenario in wrong-port wrong-certhash wrong-address-peer-id wrong-public-key abort; do
  run_browser webrtc-direct "$scenario"
done
run_browser webrtc-direct dns-localhost
run_browser webrtc-direct dns-unavailable
run_browser webrtc-direct stream-reset

old_server_addr="$server_addr"
# The rotated test server changes only the WebRTC certificate derivation while
# retaining the same host key/PeerId and Noise identity.
stop_last_go_server
start_go_server webrtc-direct rotated rotate
new_server_addr="$server_addr"
old_certhash="$(sed -n 's#.*\/certhash/\([^/]*\)/p2p/.*#\1#p' <<<"$old_server_addr")"
new_certhash="$(sed -n 's#.*\/certhash/\([^/]*\)/p2p/.*#\1#p' <<<"$new_server_addr")"
if [[ -z "$old_certhash" || -z "$new_certhash" || "$old_certhash" == "$new_certhash" ]]; then
  echo "certificate rotation did not produce distinct old/new certhashes" >&2
  exit 1
fi
old_hash_on_new_addr="${new_server_addr/\/certhash\/${new_certhash}\//\/certhash\/${old_certhash}\/}"
new_addr_prefix="${new_server_addr%%/certhash/*}"
new_addr_suffix="${new_server_addr#*/certhash/${new_certhash}}"
expected_old_hash_on_new_addr="${new_addr_prefix}/certhash/${old_certhash}${new_addr_suffix}"
if [[ "$old_hash_on_new_addr" != "$expected_old_hash_on_new_addr" || "$old_hash_on_new_addr" == "$new_server_addr" ]]; then
  echo "old certhash test address was not derived from the new server address" >&2
  exit 1
fi
mixed_addr_prefix="${old_hash_on_new_addr%%/certhash/*}"
mixed_addr_suffix="${old_hash_on_new_addr#*/certhash/${old_certhash}}"
if [[ "$mixed_addr_prefix" != "$new_addr_prefix" || "$mixed_addr_suffix" != "$new_addr_suffix" ]]; then
  echo "old certhash test changed host, UDP port, or PeerId" >&2
  exit 1
fi
echo "certificate rotation assertion: old certhash on new address $old_hash_on_new_addr" \
  | tee "$run_dir/certificate-rotation.log"
run_browser webrtc-direct old-certhash "$old_hash_on_new_addr"
run_browser webrtc-direct dns-localhost
run_browser webrtc-direct

echo "browser integration passed: mode=$BROWSER_TEST_MODE, WebSocket=${BROWSER_WEBSOCKET_REPEATS}x, WebRTC Direct=${BROWSER_DIRECT_REPEATS}x, DNS, certificate rotation, and stream reset"
