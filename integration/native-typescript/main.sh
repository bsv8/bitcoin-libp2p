#!/usr/bin/env bash
set -Eeuo pipefail

# The native TypeScript endpoint is compiled from
# typescript/src/integration/native-node.ts. This launcher keeps the required
# integration asset at the repository-level path and never imports the SDK.
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node "$repo_dir/typescript/dist-integration/integration/native-node.js" "$@"
