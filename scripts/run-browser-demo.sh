#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
transport="${1:-websocket}"
http_port="${2:-8080}"

case "$transport" in
  websocket|webrtc-direct) ;;
  *) echo "usage: $0 websocket|webrtc-direct [http-port]" >&2; exit 2 ;;
esac
if [[ ! "$http_port" =~ ^[1-9][0-9]*$ ]]; then
  echo "http-port must be a positive integer" >&2
  exit 2
fi
for command in go python3 setsid; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command not found: $command" >&2
    exit 2
  fi
done

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/bitcoin-libp2p-browser-demo.XXXXXX")"
control_fifo="$run_dir/control"
mkfifo "$control_fifo"
go_pid=""
http_pid=""

cleanup() {
  local status=$?
  set +e
  trap - EXIT
  exec 3>&-
  if [[ -n "$http_pid" ]] && kill -0 "$http_pid" 2>/dev/null; then
    kill -TERM -- "-$http_pid" 2>/dev/null || kill -TERM "$http_pid" 2>/dev/null
    wait "$http_pid" 2>/dev/null
  fi
  if [[ -n "$go_pid" ]] && kill -0 "$go_pid" 2>/dev/null; then
    kill -TERM -- "-$go_pid" 2>/dev/null || kill -TERM "$go_pid" 2>/dev/null
    wait "$go_pid" 2>/dev/null
  fi
  rm -rf "$run_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

setsid go run -C "$repo_dir/examples/05-browser-worker-hello/server" . \
  --mode server --transport "$transport" \
  <"$control_fifo" >"$run_dir/go.stdout" 2>"$run_dir/go.stderr" &
go_pid=$!
# Keep stdin open so the native server remains available until Ctrl-C.
exec 3>"$control_fifo"

address=""
for _ in $(seq 1 300); do
  if [[ -s "$run_dir/go.stdout" ]]; then
    address="$(python3 -c 'import json,sys; print(json.loads(open(sys.argv[1], encoding="utf-8").readline())["address"])' "$run_dir/go.stdout" 2>/dev/null || true)"
    if [[ -n "$address" ]]; then break; fi
  fi
  if ! kill -0 "$go_pid" 2>/dev/null; then
    echo "native Go server exited before ready" >&2
    sed -n '1,120p' "$run_dir/go.stderr" >&2 || true
    exit 1
  fi
  sleep 0.1
done
if [[ -z "$address" ]]; then
  echo "native Go server did not emit ready within 30s" >&2
  sed -n '1,120p' "$run_dir/go.stderr" >&2 || true
  exit 1
fi

python3 -m http.server "$http_port" --bind 127.0.0.1 \
  --directory "$repo_dir/examples/05-browser-worker-hello" \
  >"$run_dir/http.stdout" 2>"$run_dir/http.stderr" &
http_pid=$!
sleep 0.2
if ! kill -0 "$http_pid" 2>/dev/null; then
  echo "static HTTP server failed to start" >&2
  sed -n '1,120p' "$run_dir/http.stderr" >&2 || true
  exit 1
fi

encoded_address="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$address")"
echo "native Go ready address: $address"
echo "Open: http://127.0.0.1:$http_port/?addr=$encoded_address&transport=$transport"
echo "Press Ctrl-C to stop both servers."

while kill -0 "$go_pid" 2>/dev/null && kill -0 "$http_pid" 2>/dev/null; do
  sleep 1
done
exit 1
