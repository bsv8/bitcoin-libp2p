#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/bitcoin-libp2p-interconnect.XXXXXX")"
server_pid=""
server_fd=""

cleanup() {
  local status=$?
  set +e
  if [[ -n "$server_pid" ]]; then
    kill -TERM -- "-$server_pid" 2>/dev/null || true
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ -n "$server_fd" ]]; then
    eval "exec ${server_fd}>&-"
  fi
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 ]]; then
    printf 'browser interconnect failed; logs retained at %s\n' "$run_dir" >&2
  else
    rm -rf "$run_dir"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

payload_bytes="${BROWSER_INTERCONNECT_PAYLOAD_BYTES:-16777216}"
repeats="${BROWSER_INTERCONNECT_REPEATS:-1}"
token="${BROWSER_INTERCONNECT_TOKEN:-interconnect-$$-$(date +%s%N)}"
if ! [[ "$payload_bytes" =~ ^[1-9][0-9]*$ || ! "$repeats" =~ ^[1-9][0-9]*$ ]]; then
  printf 'BROWSER_INTERCONNECT_PAYLOAD_BYTES and BROWSER_INTERCONNECT_REPEATS must be positive integers\n' >&2
  exit 2
fi
if [[ ! -x "$repo_dir/typescript/node_modules/.bin/playwright" ]]; then
  printf 'Playwright is not installed. Run: cd typescript && npm ci\n' >&2
  exit 2
fi

npm --prefix "$repo_dir/typescript" run build:browser
fifo="$run_dir/server.fifo"
mkfifo "$fifo"
exec {server_fd}<>"$fifo"
setsid env BROWSER_INTERCONNECT_TOKEN="$token" node "$repo_dir/integration/browser-interconnect-server.mjs" "$repo_dir/typescript/dist-integration" 0 <&"$server_fd" >"$run_dir/server.log" 2>&1 &
server_pid="$!"
for _ in $(seq 1 300); do
  if [[ -s "$run_dir/server.log" ]]; then
    IFS= read -r ready_line <"$run_dir/server.log" || true
    if [[ "$ready_line" == READY\ * ]]; then
      http_port="${ready_line#READY }"
      break
    fi
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf 'external signaling server exited before READY\n' >&2
    exit 1
  fi
  sleep 0.1
done
if [[ -z "${http_port:-}" ]]; then
  printf 'external signaling server did not become ready\n' >&2
  exit 1
fi

for attempt in $(seq 1 "$repeats"); do
  printf 'external WebRTC browser repetition %s/%s payload=%s\n' "$attempt" "$repeats" "$payload_bytes"
  node "$repo_dir/typescript/integration/browser-interconnect-runner.mjs" --http-port "$http_port" --token "$token" --payload-bytes "$payload_bytes" | tee "$run_dir/run-${attempt}.log"
done

printf 'external WebRTC browser integration passed: repetitions=%s payload=%s\n' "$repeats" "$payload_bytes"
