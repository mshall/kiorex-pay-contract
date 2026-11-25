#!/usr/bin/env bash
# Vendor the packed tarball into a consumer repo: scripts/vendor-into.sh <consumer-root> <consumer-package-json-relative> <relative-vendor-path-from-that-package>
# Example (platform): scripts/vendor-into.sh ../kiorex-platform apps/api/package.json ../../vendor
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$1"; PKG="$2"; REL="$3"
V="$(node -p "require('./package.json').version")"; T="kiorex-pay-contract-$V.tgz"
[ -f "dist-pack/$T" ] || npm run pack:local >/dev/null
mkdir -p "$ROOT/vendor"; find "$ROOT/vendor" -name 'kiorex-pay-contract-*.tgz' ! -name "$T" -delete; cp "dist-pack/$T" "$ROOT/vendor/$T"
node -e "const fs=require('fs');const p='$ROOT/$PKG';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.dependencies=j.dependencies||{};j.dependencies['@kiorex/pay-contract']='file:$REL/$T';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
echo "vendored @kiorex/pay-contract $V into $ROOT/vendor/$T (run npm install in the consumer to refresh its lockfile)"
