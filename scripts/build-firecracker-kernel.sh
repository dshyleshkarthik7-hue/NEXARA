#!/usr/bin/env bash
# Build a Firecracker-compatible x86_64 Linux kernel from a pinned upstream tarball.
set -Eeuo pipefail
fail(){ echo "KERNEL BUILD FAILED: $*" >&2; exit 1; }
for x in curl tar xz make gcc bc bison flex perl openssl sha256sum nproc; do command -v "$x" >/dev/null || fail "missing build tool: $x"; done
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
OUT="${NEXARA_BINARY_OUT:-$ROOT/dist/host-binaries}"
WORK="${NEXARA_BUILD_WORK:-$ROOT/.build/host-binaries}"
VERSION="${LINUX_KERNEL_VERSION:-6.12.1}"
ARCH=x86_64
mkdir -p "$OUT" "$WORK"
ARCHIVE="$WORK/linux-$VERSION.tar.xz"
SOURCE_URL="https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$VERSION.tar.xz"
if [[ ! -s "$ARCHIVE" ]]; then curl --fail --location --retry 3 "$SOURCE_URL" -o "$ARCHIVE"; fi
tar -tf "$ARCHIVE" >/dev/null || fail "invalid Linux source archive"
SRC="$WORK/linux-$VERSION"
if [[ ! -d "$SRC" ]]; then tar -xJf "$ARCHIVE" -C "$WORK"; fi
make -C "$SRC" ARCH="$ARCH" defconfig
# Firecracker boots the kernel directly; include virtio block, serial console,
# ext4, initramfs, proc/sysfs/devtmpfs and the basic networking stack built-in.
cfg="$SRC/scripts/config"
"$cfg" --file "$SRC/.config" --enable 64BIT --enable X86_64
"$cfg" --file "$SRC/.config" --enable PRINTK --enable TTY --enable SERIAL_8250 --enable SERIAL_8250_CONSOLE
"$cfg" --file "$SRC/.config" --enable BLOCK --enable VIRTIO --enable VIRTIO_PCI --enable VIRTIO_BLK
"$cfg" --file "$SRC/.config" --enable BLK_DEV_INITRD --enable DEVTMPFS --enable DEVTMPFS_MOUNT
"$cfg" --file "$SRC/.config" --enable PROC_FS --enable SYSFS --enable TMPFS
"$cfg" --file "$SRC/.config" --enable EXT4_FS --enable MSDOS_PARTITION
"$cfg" --file "$SRC/.config" --enable NET --enable INET --enable UNIX
"$cfg" --file "$SRC/.config" --disable MODULES
make -C "$SRC" ARCH="$ARCH" olddefconfig
make -C "$SRC" ARCH="$ARCH" -j"$(nproc)" bzImage
install -m 0644 "$SRC/arch/x86/boot/bzImage" "$OUT/vmlinux.bin"
install -m 0644 "$SRC/.config" "$OUT/kernel.config"
(
 cd "$OUT"
 sha256sum vmlinux.bin kernel.config > KERNEL-SHA256SUMS
 printf 'linux_kernel_version=%s\nlinux_source_url=%s\nlinux_source_sha256=%s\n' "$VERSION" "$SOURCE_URL" "$(sha256sum "$ARCHIVE" | awk '{print $1}')" > KERNEL-BUILD-INFO.txt
)
echo "Built Firecracker kernel: $OUT/vmlinux.bin"
