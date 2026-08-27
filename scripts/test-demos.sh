#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

case "${1:-}" in
  --quick|--all) ;;
  *)
    echo "usage: ./scripts/test-demos.sh --quick|--all" >&2
    exit 2
    ;;
esac

for command in go node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "required command not found: $command" >&2
    exit 2
  fi
done

if [[ ! -f typescript/dist/index.js ]]; then
  echo "The built TypeScript SDK is missing. Run: npm ci --prefix typescript && npm run build --prefix typescript" >&2
  exit 2
fi

require_demo_dependency() {
  local directory="$1"
  local label="$2"
  if [[ ! -x "$directory/node_modules/.bin/tsc" ]]; then
    echo "$label dependencies are not installed. Run: npm ci --prefix $directory" >&2
    exit 2
  fi
}

ts_hello_dir="$repo_dir/examples/02-typescript-hello"
remote_ts_dir="$repo_dir/examples/04-remote-signer/typescript"
browser_dir="$repo_dir/examples/05-browser-worker-hello"
native_ts_dir="$repo_dir/examples/06-native-interop/native-typescript"

require_demo_dependency "$ts_hello_dir" "TypeScript Hello"
if [[ ! -d "$ts_hello_dir/node_modules/bitcoin-libp2p/dist" ]]; then
  echo "TypeScript Hello does not have the built SDK dependency. Run: npm ci --prefix $ts_hello_dir" >&2
  exit 2
fi

if [[ "$1" == "--all" ]]; then
  require_demo_dependency "$remote_ts_dir" "Remote Signer TypeScript"
  require_demo_dependency "$browser_dir" "Browser Worker"
  require_demo_dependency "$native_ts_dir" "Native TypeScript"
  if [[ ! -x "$browser_dir/node_modules/.bin/esbuild" ]]; then
    echo "Browser Worker dependencies are incomplete. Run: npm ci --prefix $browser_dir" >&2
    exit 2
  fi
  if [[ ! -d "typescript/node_modules/@playwright/test" ]]; then
    echo "Playwright is not installed. Run: npm ci --prefix typescript" >&2
    exit 2
  fi
fi

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/bitcoin-libp2p-demos.XXXXXX")"
build_dir="$run_dir/build"
mkdir -p "$build_dir" "$run_dir/sdk"
cleanup() {
  local status=$?
  set +e
  trap - EXIT INT TERM
  rm -rf -- "$run_dir"
  if [[ -e "$run_dir" ]]; then
    echo "demo temporary directory was not removed: $run_dir" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

go build -o "$build_dir/go-hello" ./examples/01-go-hello
npm run build --prefix "$ts_hello_dir"

if [[ "$1" == "--quick" ]]; then
  runner_status=0
  node examples/e2e/runner.mjs --quick --build-dir "$build_dir" || runner_status=$?
  exit "$runner_status"
fi

go build -o "$build_dir/go-remote-host" ./examples/04-remote-signer/go/host
go build -o "$build_dir/go-remote-signer" ./examples/04-remote-signer/go/signer
go -C examples/05-browser-worker-hello/server build -o "$build_dir/native-go-server" .

npm run build --prefix "$remote_ts_dir"
npm run build --prefix "$browser_dir"
npm run build:browser --prefix "$browser_dir"
npm run build --prefix "$native_ts_dir"

sdk_tarball_name="$(cd typescript && npm pack --silent --pack-destination "$run_dir/sdk")"
sdk_tarball="$run_dir/sdk/$sdk_tarball_name"
if [[ ! -f "$sdk_tarball" ]]; then
  echo "npm pack did not produce the SDK tarball: $sdk_tarball" >&2
  exit 1
fi

# Consume the formal package only in a disposable directory. --offline makes
# an accidental registry access a hard failure; dependencies are an explicit
# developer preparation step, not part of this test entry point.
sdk_consumer_dir="$run_dir/sdk-consumer"
mkdir -p "$sdk_consumer_dir"
(cd "$sdk_consumer_dir" && npm init --yes >/dev/null)
if ! npm install --offline --prefix "$sdk_consumer_dir" --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "$sdk_tarball"; then
  echo "offline SDK tarball consumption failed; run the README dependency preparation first" >&2
  exit 1
fi
(cd "$sdk_consumer_dir" && node --input-type=module --eval "const sdk = await import('bitcoin-libp2p'); if (typeof sdk.createHost !== 'function') throw new Error('formal SDK tarball has no createHost export')")

runner_status=0
node examples/e2e/runner.mjs --all --build-dir "$build_dir" --sdk-tarball "$sdk_tarball" || runner_status=$?
exit "$runner_status"
