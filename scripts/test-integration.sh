#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/bitcoin-libp2p-integration.XXXXXX")"
server_pids=()
server_fds=()

cleanup() {
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
  rm -rf "$run_dir"
}
trap cleanup EXIT INT TERM

SERVER_KEY=278d5bed18a82b66619e026c2efb2a907e35310829d9658fb967180636afaa6a
CLIENT_KEY=0000000000000000000000000000000000000000000000000000000000000001
EXPECTED_SERVER_PUBLIC_KEY=02e940822d4e7a09ce013bed4fa812e92f22b0ed1fa2d1ad06ae0406680da1cc46
EXPECTED_SERVER_PEER_ID=16Uiu2HAmB8C2R7pBJu1z2u1gno7aXcbtkoUzrknTFN2EBLjRavKP

start_lane() {
  local name="$1"
  local key="$2"
  shift 2
  local fifo="$run_dir/${name}.fifo"
  mkfifo "$fifo"
  local control_fd
  exec {control_fd}<>"$fifo"
  server_fds+=("$control_fd")
  setsid "$@" -key "$key" <&"$control_fd" >"$run_dir/${name}.log" 2>&1 &
  server_pids+=("$!")
  for _ in $(seq 1 200); do
    if rg -m1 '^READY ' "$run_dir/${name}.log" >"$run_dir/${name}.ready" 2>/dev/null; then
      read -r _ lane_public_key lane_addr <"$run_dir/${name}.ready"
      export lane_public_key lane_addr
      return 0
    fi
    if ! kill -0 "${server_pids[-1]}" 2>/dev/null; then
      tail -n 80 "$run_dir/${name}.log" >&2
      return 1
    fi
    sleep 0.1
  done
  tail -n 80 "$run_dir/${name}.log" >&2
  return 1
}

start_server() {
  local name="$1"
  shift
  local fifo="$run_dir/${name}.fifo"
  mkfifo "$fifo"
  local control_fd
  exec {control_fd}<>"$fifo"
  server_fds+=("$control_fd")
  setsid "$@" <&"$control_fd" >"$run_dir/${name}.log" 2>&1 &
  server_pids+=("$!")
  for _ in $(seq 1 200); do
    if rg -m1 '^READY ' "$run_dir/${name}.log" >"$run_dir/${name}.ready" 2>/dev/null; then
      read -r _ server_id server_addr server_public_key <"$run_dir/${name}.ready"
      export server_id server_addr
      if [[ "$server_id" != "$EXPECTED_SERVER_PEER_ID" || "$server_public_key" != "$EXPECTED_SERVER_PUBLIC_KEY" ]]; then
        echo "server identity mismatch: id=$server_id public_key=$server_public_key" >&2
        return 1
      fi
      return 0
    fi
    if ! kill -0 "${server_pids[-1]}" 2>/dev/null; then
      tail -n 80 "$run_dir/${name}.log" >&2
      return 1
    fi
    sleep 0.1
  done
  tail -n 80 "$run_dir/${name}.log" >&2
  return 1
}

run_client() {
  local name="$1"
  shift
  if ! timeout 30s "$@" >"$run_dir/${name}.client.log" 2>&1; then
    tail -n 80 "$run_dir/${name}.client.log" >&2
    return 1
  fi
  local result marker remote_id remote_public_key address_peer_id extra
  result="$(rg '^OK ' "$run_dir/${name}.client.log" | tail -n 1 || true)"
  read -r marker remote_id remote_public_key address_peer_id extra <<<"$result" || true
  if [[ "$marker" != "OK" || "$remote_id" != "$server_id" || "$remote_id" != "$EXPECTED_SERVER_PEER_ID" || "$remote_public_key" != "$server_public_key" || "$remote_public_key" != "$EXPECTED_SERVER_PUBLIC_KEY" || "$address_peer_id" != "$server_id" || -n "$extra" ]]; then
    echo "client identity assertion failed: $result" >&2
    tail -n 80 "$run_dir/${name}.client.log" >&2
    return 1
  fi
}

run_expected_failure() {
  local name="$1"
  shift
  local status=0
  timeout 12s "$@" >"$run_dir/${name}.failure.log" 2>&1 || status=$?
  if [[ "$status" -eq 0 ]]; then
    echo "$name unexpectedly succeeded" >&2
    cat "$run_dir/${name}.failure.log" >&2
    return 1
  fi
  if [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
    echo "$name timed out instead of failing promptly" >&2
    cat "$run_dir/${name}.failure.log" >&2
    return 1
  fi
  if rg -q '^OK ' "$run_dir/${name}.failure.log"; then
    echo "$name emitted a successful result" >&2
    cat "$run_dir/${name}.failure.log" >&2
    return 1
  fi
}

check_native_isolation() {
  local native_go_sdk_dependency
  native_go_sdk_dependency="$(go -C integration/native-go list -deps . | awk '$0 != "github.com/bsv8/bitcoin-libp2p/integration/native-go" && $0 ~ /^github.com\/bsv8\/bitcoin-libp2p($|\/)/ { print; exit }')"
  if [[ -n "$native_go_sdk_dependency" ]]; then
    echo "native Go dependency graph imports the SDK" >&2
    return 1
  fi
  local native_v045_sdk_dependency
  native_v045_sdk_dependency="$(go -C integration/native-go-v045 list -deps . | awk '$0 != "github.com/bsv8/bitcoin-libp2p/integration/native-go-v045" && $0 ~ /^github.com\/bsv8\/bitcoin-libp2p($|\/)/ { print; exit }')"
  if [[ -n "$native_v045_sdk_dependency" ]]; then
    echo "native Go v0.45 dependency graph imports the SDK" >&2
    return 1
  fi
  if rg -n "from ['\"](bitcoin-libp2p|\.\./(identity|signer|libp2p))" typescript/src/integration/native-node.ts; then
    echo "native TypeScript endpoint imports the SDK" >&2
    return 1
  fi
}

go test ./...
go -C integration/native-go test ./...
go -C integration/native-go-v045 test ./...
check_native_isolation
(cd typescript && npm test && npm run build:integration)
node scripts/test-framing-integration.mjs

start_go_sdk_server() {
  local name="$1"
  start_lane "${name}_lane" "$SERVER_KEY" go run ./integration/remote-signer-go
  start_server "$name" go run ./integration/sdk-go -mode server -signer-addr "$lane_addr" -public-key "$lane_public_key"
}

start_ts_sdk_server() {
  local name="$1"
  start_lane "${name}_lane" "$SERVER_KEY" node typescript/dist-integration/integration/remote-signer.js
  start_server "$name" node typescript/dist-integration/integration/node.js --mode server --signer-addr "$lane_addr" --public-key "$lane_public_key"
}

start_go_sdk_client() {
  local name="$1"
  start_lane "${name}_client_lane" "$CLIENT_KEY" go run ./integration/remote-signer-go
  run_client "$name" go run ./integration/sdk-go -mode client -addr "$server_addr" -signer-addr "$lane_addr" -public-key "$lane_public_key"
}

start_ts_sdk_client() {
  local name="$1"
  start_lane "${name}_client_lane" "$CLIENT_KEY" node typescript/dist-integration/integration/remote-signer.js
  run_client "$name" node typescript/dist-integration/integration/node.js --mode client --addr "$server_addr" --signer-addr "$lane_addr" --public-key "$lane_public_key"
}

start_native_ts_server() {
  local name="$1"
  start_server "$name" ./integration/native-typescript/main.sh --mode server
}

start_native_go_server() {
  local name="$1"
  start_server "$name" go -C integration/native-go run . -mode server -key "$SERVER_KEY"
}

start_native_go045_server() {
  local name="$1"
  start_server "$name" go -C integration/native-go-v045 run . -mode server -key "$SERVER_KEY"
}

# The scenario name is the active dialer followed by the receiver.
start_ts_sdk_server sdk_go_to_sdk_ts
start_go_sdk_client sdk_go_to_sdk_ts

start_go_sdk_server sdk_ts_to_sdk_go
start_ts_sdk_client sdk_ts_to_sdk_go

start_native_ts_server sdk_go_to_native_ts
start_go_sdk_client sdk_go_to_native_ts

start_native_go_server sdk_ts_to_native_go
start_ts_sdk_client sdk_ts_to_native_go

start_native_go045_server sdk_go_to_go045
start_go_sdk_client sdk_go_to_go045

# Keep the opposite SDK/native directions as regression coverage as well.
start_go_sdk_server native_ts_to_sdk_go
run_client native_ts_to_sdk_go ./integration/native-typescript/main.sh --mode client --addr "$server_addr"

start_ts_sdk_server native_go_to_sdk_ts
run_client native_go_to_sdk_ts go -C integration/native-go run . -mode client -addr "$server_addr" -key "$CLIENT_KEY"

start_go_sdk_server sdk_go_to_native_go045_extra
run_client sdk_go_to_native_go045_extra go -C integration/native-go-v045 run . -mode client -addr "$server_addr"

# V1.2 framing keeps several payloads on one Stream. The client closes its
# write side only after the final frame; EOF is not used as a message boundary.
start_go_sdk_server framing_go_to_ts
start_ts_sdk_framing_client() {
  local name="$1"
  start_lane "${name}_client_lane" "$CLIENT_KEY" node typescript/dist-integration/integration/remote-signer.js
  run_client "$name" node typescript/dist-integration/integration/node.js --mode client --addr "$server_addr" --signer-addr "$lane_addr" --public-key "$lane_public_key" --framing
}
start_ts_sdk_framing_client framing_go_to_ts

start_ts_sdk_server framing_ts_to_go
start_go_sdk_framing_client() {
  local name="$1"
  start_lane "${name}_client_lane" "$CLIENT_KEY" go run ./integration/remote-signer-go
  run_client "$name" go run ./integration/sdk-go -mode client -addr "$server_addr" -signer-addr "$lane_addr" -public-key "$lane_public_key" -framing
}
start_go_sdk_framing_client framing_ts_to_go

# Exercise the actual SDK host against independent signer processes. Each
# failure mode must make the client return and must not emit an OK result.
start_native_go_server signer_failure_target

start_lane go_signer_timeout "$CLIENT_KEY" go run ./integration/remote-signer-go --mode pending
run_expected_failure go_signer_timeout go run ./integration/sdk-go -mode client -addr "$server_addr" -signer-addr "$lane_addr" -public-key "$lane_public_key" -sign-timeout-ms 100

start_lane go_signer_stop "$CLIENT_KEY" go run ./integration/remote-signer-go --mode pending
run_expected_failure go_signer_stop go run ./integration/sdk-go -mode client -addr "$server_addr" -signer-addr "$lane_addr" -public-key "$lane_public_key" -host-stop-after-ms 300

start_lane go_signer_exit "$CLIENT_KEY" go run ./integration/remote-signer-go --mode exit
run_expected_failure go_signer_exit go run ./integration/sdk-go -mode client -addr "$server_addr" -signer-addr "$lane_addr" -public-key "$lane_public_key" -sign-timeout-ms 1_000

start_lane go_signer_reject "$CLIENT_KEY" go run ./integration/remote-signer-go --mode reject
run_expected_failure go_signer_reject go run ./integration/sdk-go -mode client -addr "$server_addr" -signer-addr "$lane_addr" -public-key "$lane_public_key" -sign-timeout-ms 1_000

start_lane go_signer_wrong_key "$CLIENT_KEY" go run ./integration/remote-signer-go --mode wrong-key
run_expected_failure go_signer_wrong_key go run ./integration/sdk-go -mode client -addr "$server_addr" -signer-addr "$lane_addr" -public-key "$lane_public_key" -sign-timeout-ms 1_000

start_lane ts_signer_timeout "$CLIENT_KEY" node typescript/dist-integration/integration/remote-signer.js --mode pending
run_expected_failure ts_signer_timeout node typescript/dist-integration/integration/node.js --mode client --addr "$server_addr" --signer-addr "$lane_addr" --public-key "$lane_public_key" --sign-timeout-ms 100

start_lane ts_signer_stop "$CLIENT_KEY" node typescript/dist-integration/integration/remote-signer.js --mode pending
run_expected_failure ts_signer_stop node typescript/dist-integration/integration/node.js --mode client --addr "$server_addr" --signer-addr "$lane_addr" --public-key "$lane_public_key" --host-stop-after-ms 300

start_lane ts_signer_exit "$CLIENT_KEY" node typescript/dist-integration/integration/remote-signer.js --mode exit
run_expected_failure ts_signer_exit node typescript/dist-integration/integration/node.js --mode client --addr "$server_addr" --signer-addr "$lane_addr" --public-key "$lane_public_key" --sign-timeout-ms 1_000

start_lane ts_signer_reject "$CLIENT_KEY" node typescript/dist-integration/integration/remote-signer.js --mode reject
run_expected_failure ts_signer_reject node typescript/dist-integration/integration/node.js --mode client --addr "$server_addr" --signer-addr "$lane_addr" --public-key "$lane_public_key" --sign-timeout-ms 1_000

start_lane ts_signer_wrong_key "$CLIENT_KEY" node typescript/dist-integration/integration/remote-signer.js --mode wrong-key
run_expected_failure ts_signer_wrong_key node typescript/dist-integration/integration/node.js --mode client --addr "$server_addr" --signer-addr "$lane_addr" --public-key "$lane_public_key" --sign-timeout-ms 1_000

echo "integration matrix passed"
