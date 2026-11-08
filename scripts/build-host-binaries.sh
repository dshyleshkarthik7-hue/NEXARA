#!/usr/bin/env bash
set -Eeuo pipefail
fail(){ echo "BUILD FAILED: $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null || fail "missing command: $1"; }
for x in git cargo rustc make gcc g++ perl wget tar gzip sha256sum nproc readelf; do need "$x"; done
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
(
  cd "$FC_SRC"
  cargo build --release --locked --bin firecracker
  cargo build --release --locked -p jailer --bin jailer
)
FC_TARGET="$FC_SRC/build/cargo_target/release"
[[ -x "$FC_TARGET/firecracker" ]] || fail "Firecracker binary missing from expected Cargo target directory: $FC_TARGET"
[[ -x "$FC_TARGET/jailer" ]] || fail "jailer binary missing from expected Cargo target directory: $FC_TARGET"
install -m 0755 "$FC_TARGET/firecracker" "$OUT/firecracker"
install -m 0755 "$FC_TARGET/jailer" "$OUT/jailer"
if [[ ! -d "$BB_SRC/.git" ]]; then git clone --filter=blob:none https://github.com/mirror/busybox.git "$BB_SRC"; fi
git -C "$BB_SRC" fetch --tags --force
git -C "$BB_SRC" checkout --detach "$BB_TAG"
make -C "$BB_SRC" distclean
make -C "$BB_SRC" defconfig
# BusyBox does not ship Linux-kernel's scripts/config helper.
if grep -q '^# CONFIG_STATIC is not set$' "$BB_SRC/.config"; then
  sed -i 's/^# CONFIG_STATIC is not set$/CONFIG_STATIC=y/' "$BB_SRC/.config"
elif grep -q '^CONFIG_STATIC=' "$BB_SRC/.config"; then
  sed -i 's/^CONFIG_STATIC=.*/CONFIG_STATIC=y/' "$BB_SRC/.config"
else
  printf '\nCONFIG_STATIC=y\n' >> "$BB_SRC/.config"
fi
set +o pipefail
yes '' | make -C "$BB_SRC" oldconfig
set -o pipefail
make -C "$BB_SRC" CC=musl-gcc -j"$(nproc)"
install -m 0755 "$BB_SRC/busybox" "$OUT/busybox"
if readelf -l "$OUT/busybox" | grep -q INTERP; then fail "BusyBox unexpectedly has a dynamic interpreter"; fi
"$OUT/firecracker" --version
"$OUT/jailer" --version
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
