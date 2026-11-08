#!/usr/bin/env bash
# Fail-closed structural verification of the complete NEXARA runtime bundle.
set -Eeuo pipefail
fail(){ echo "BUNDLE VERIFICATION FAILED: $*" >&2; exit 1; }
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
DIR="${NEXARA_BINARY_OUT:-$ROOT/dist/host-binaries}"
for f in firecracker jailer busybox vmlinux.bin kernel.config nexara-guest-initramfs.cpio.gz nexara-test-rootfs.ext4 BUILD-INFO.txt; do
  [[ -f "$DIR/$f" && ! -L "$DIR/$f" && -s "$DIR/$f" ]] || fail "missing/unsafe bundle file: $f"
done
for x in file readelf sha256sum gzip cpio od grep dumpe2fs; do command -v "$x" >/dev/null || fail "missing verifier tool: $x"; done
for x in firecracker jailer busybox; do
  [[ -x "$DIR/$x" ]] || fail "$x is not executable"
  file "$DIR/$x" | grep -q 'ELF 64-bit' || fail "$x is not an x86_64 ELF binary"
done
"$DIR/firecracker" --version
"$DIR/jailer" --version
"$DIR/busybox" --list | grep -qx nc || fail "BusyBox lacks nc applet"
if readelf -l "$DIR/busybox" | grep -q INTERP; then fail "BusyBox is dynamically linked"; fi
for option in CONFIG_64BIT=y CONFIG_VIRTIO_MMIO=y CONFIG_VIRTIO_BLK=y CONFIG_EXT4_FS=y CONFIG_DEVTMPFS=y CONFIG_BLK_DEV_INITRD=y; do
  grep -qx "$option" "$DIR/kernel.config" || fail "kernel config missing $option"
done
[[ "$(od -An -tc -j 514 -N 4 "$DIR/vmlinux.bin" | tr -d ' \n')" == "HdrS" ]] || fail "kernel image lacks bzImage boot signature"
gzip -t "$DIR/nexara-guest-initramfs.cpio.gz" || fail "initramfs gzip stream is corrupt"
dumpe2fs -h "$DIR/nexara-test-rootfs.ext4" 2>/dev/null | grep -Eq '^Filesystem volume name:[[:space:]]+NEXARA_TEST$' || fail "test root disk is not the expected ext4 filesystem"
listing="$(gzip -dc "$DIR/nexara-guest-initramfs.cpio.gz" | cpio -it 2>/dev/null)"
grep -qx './init' <<<"$listing" || fail "initramfs lacks /init"
grep -qx './bin/busybox' <<<"$listing" || fail "initramfs lacks static BusyBox"
(cd "$DIR" && sha256sum -c SHA256SUMS)
echo "PASS: Firecracker, jailer, static BusyBox, bzImage kernel, initramfs and ext4 disk are structurally valid."
echo "NOTE: this verifies bundle integrity and format, not a real KVM guest boot."
