#!/usr/bin/env bash
# Build trusted upstream Firecracker+jailer and static BusyBox for NEXARA.
set -Eeuo pipefail
fail(){ echo "BUILD FAILED: $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null || fail "missing command: $1"; }
for x in git cargo rustc make gcc g++ perl wget tar gzip sha256sum nproc; do need "$x"; done
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="${NEXARA_BINARY_OUT:-$ROOT/dist/host-binaries}"
WORK="${NEXARA_BUILD_WORK:-$ROOT/.build/host-binaries}"
FC_TAG="${FIRECRACKER_TAG:-v1.13.1}"
BB_TAG="${BUSYBOX_TAG:-1_36_1}"
mkdir -p "$OUT" "$WORK"
FC_SRC="$WORK/firecracker"
BB_SRC="$WORK/busybox"
if [[ ! -d "$FC_SRC/.git" ]]; then git clone --filter=blob:none https://github.com/firecracker-microvm/firecracker.git "$FC_SRC"; fi
git -C "$FC_SRC" fetch --tags --force
git -C "$FC_SRC" checkout --detach "$FC_TAG"
git -C "$FC_SRC" submodule update --init --recursive
# Build the upstream project binaries; do not patch or replace the jailer.
(
  cd "$FC_SRC"
  cargo build --release --locked --bin firecracker --bin jailer
)
install -m 0755 "$FC_SRC/target/release/firecracker" "$OUT/firecracker"
install -m 0755 "$FC_SRC/target/release/jailer" "$OUT/jailer"
if [[ ! -d "$BB_SRC/.git" ]]; then git clone --filter=blob:none https://github.com/mirror/busybox.git "$BB_SRC"; fi
git -C "$BB_SRC" fetch --tags --force
git -C "$BB_SRC" checkout --detach "$BB_TAG"
make -C "$BB_SRC" distclean
make -C "$BB_SRC" defconfig
"$BB_SRC/scripts/config" --file "$BB_SRC/.config" --enable STATIC
make -C "$BB_SRC" olddefconfig
make -C "$BB_SRC" -j"$(nproc)"
install -m 0755 "$BB_SRC/busybox" "$OUT/busybox"
"$OUT/busybox" --help >/dev/null 2>&1 || true
file "$OUT/firecracker" "$OUT/jailer" "$OUT/busybox" 2>/dev/null || true
(
  cd "$OUT"
  sha256sum firecracker jailer busybox > SHA256SUMS
  {
    echo "firecracker_tag=$FC_TAG"
    echo "firecracker_commit=$(git -C "$FC_SRC" rev-parse HEAD)"
    echo "busybox_tag=$BB_TAG"
    echo "busybox_commit=$(git -C "$BB_SRC" rev-parse HEAD)"
    rustc --version
    cargo --version
    gcc --version | head -n1
  } > BUILD-INFO.txt
)
echo "Built binaries and manifests in $OUT"
