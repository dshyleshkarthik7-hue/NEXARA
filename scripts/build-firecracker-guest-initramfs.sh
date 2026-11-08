#!/usr/bin/env bash
# Build a small serial-console initramfs for Firecracker integration testing.
set -Eeuo pipefail
fail(){ echo "GUEST IMAGE BUILD FAILED: $*" >&2; exit 1; }
[[ $# -eq 2 ]] || fail "usage: $0 /absolute/path/to/static-busybox output.cpio.gz"
busybox="$1"; output="$2"
[[ "$busybox" == /* && -f "$busybox" && -x "$busybox" && ! -L "$busybox" ]] || fail "BusyBox must be an absolute regular executable"
command -v cpio >/dev/null || fail "cpio is required"
command -v gzip >/dev/null || fail "gzip is required"
command -v sha256sum >/dev/null || fail "sha256sum is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
root="$tmp/root"
mkdir -p "$root/bin" "$root/dev" "$root/proc" "$root/sys" "$root/mnt/root"
install -m 0755 "$busybox" "$root/bin/busybox"
for app in sh mount mkdir sleep sync poweroff cat; do
  "$busybox" --list | grep -qx "$app" || fail "BusyBox is missing required applet: $app"
  ln -s busybox "$root/bin/$app"
done
"$busybox" --list | grep -qx nc || fail "BusyBox is missing required applet: nc (egress probe is mandatory)"
ln -s busybox "$root/bin/nc"
cat > "$root/init" <<'INIT'
#!/bin/sh
export PATH=/bin
/bin/mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
/bin/mount -t proc proc /proc
/bin/mount -t sysfs sysfs /sys
echo "NEXARA_GUEST_BOOT_OK"
mkdir -p /mnt/root
if ! mount -t ext4 -o rw /dev/vda /mnt/root; then
  echo "NEXARA_DISK_MOUNT_FAILED"
  /bin/poweroff -f
fi
if [ "$(cat /mnt/root/nexara-persistence-probe 2>/dev/null)" = "nexara-persistence-probe-v1" ]; then
  echo "NEXARA_DISK_PERSISTENCE_PRESENT"
else
  printf '%s\n' "nexara-persistence-probe-v1" > /mnt/root/nexara-persistence-probe
  sync
  if [ "$(cat /mnt/root/nexara-persistence-probe 2>/dev/null)" = "nexara-persistence-probe-v1" ]; then
    echo "NEXARA_DISK_WRITE_OK"
  else
    echo "NEXARA_DISK_WRITE_FAILED"
  fi
fi
if nc -z -w 3 1.1.1.1 443 >/dev/null 2>&1; then
  echo "NEXARA_EGRESS_UNEXPECTEDLY_ALLOWED"
else
  echo "NEXARA_EGRESS_BLOCKED"
fi
sync
echo "NEXARA_GUEST_VALIDATION_COMPLETE"
sync
/bin/poweroff -f
sleep 1
INIT
chmod 0755 "$root/init"
mkdir -p "$(dirname "$output")"
(
  cd "$root"
  find . -print0 | sort -z | cpio --null -o --format=newc 2>/dev/null | gzip -n -9
) > "$output"
[[ -s "$output" ]] || fail "initramfs output is empty"
echo "Built initramfs: $output"
echo "SHA-256: $(sha256sum "$output" | awk '{print $1}')"
