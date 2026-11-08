#!/usr/bin/env bash
# Run two real Firecracker boots through the upstream jailer, reusing one ext4 disk.
set -Eeuo pipefail
fail(){ echo "TWO-BOOT KVM RUN FAILED: $*" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] || fail "run as root on Linux"
[[ $# -eq 1 ]] || fail "usage: $0 /absolute/path/to/host-bundle"
BUNDLE="$1"
[[ "$BUNDLE" == /* && -d "$BUNDLE" ]] || fail "bundle path must be absolute"
FC="$BUNDLE/firecracker"; JAILER="$BUNDLE/jailer"
KERNEL="$BUNDLE/vmlinux.bin"; INITRD="$BUNDLE/nexara-guest-initramfs.cpio.gz"
DISK="$BUNDLE/nexara-test-rootfs.ext4"
for f in "$FC" "$JAILER" "$KERNEL" "$INITRD" "$DISK"; do [[ -f "$f" && ! -L "$f" && -s "$f" ]] || fail "missing/unsafe artifact $f"; done
for x in ip nft curl pgrep sha256sum; do command -v "$x" >/dev/null || fail "missing host command $x"; done
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || fail "/dev/kvm is unavailable"
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail "cgroup v2 required"
: "${NEXARA_JAILER_PARENT_CGROUP:?Set NEXARA_JAILER_PARENT_CGROUP to a pre-created delegated cgroup-v2 parent containing 'nexara' in its path}"
parent="/sys/fs/cgroup/$NEXARA_JAILER_PARENT_CGROUP"
[[ -d "$parent" ]] || fail "delegated cgroup parent does not exist: $parent"
for c in cpu memory pids; do grep -qw "$c" "$parent/cgroup.controllers" || fail "parent cgroup lacks $c controller"; done
uid="${NEXARA_JAILER_UID:-12345}"; gid="${NEXARA_JAILER_GID:-12345}"
[[ "$uid" =~ ^[1-9][0-9]+$ && "$gid" =~ ^[1-9][0-9]+$ ]] || fail "jailer UID/GID must be non-root numeric IDs"
base="${NEXARA_JAILER_BASE:-/srv/jailer}"
work="${NEXARA_KVM_WORKDIR:-/var/tmp/nexara-two-boot}"
ns="nexara-$RANDOM-$$"
mkdir -m 0700 -p "$work" "$base"
chmod 0755 "$base"
ip netns add "$ns"
cleanup(){
  for p in $(pgrep -x firecracker 2>/dev/null || true); do kill "$p" 2>/dev/null || true; done
  ip netns del "$ns" 2>/dev/null || true
}
trap cleanup EXIT
cp "$DISK" "$work/persistent.ext4"
chmod 0600 "$work/persistent.ext4"
run_boot(){
  local number="$1"
  local id="nexara-$RANDOM-$number"
  local jailroot="$base/firecracker/$id/root"
  mkdir -p "$jailroot/run"
  install -m 0444 "$KERNEL" "$jailroot/vmlinux.bin"
  install -m 0444 "$INITRD" "$jailroot/initramfs.cpio.gz"
  install -m 0600 "$work/persistent.ext4" "$jailroot/rootfs.ext4"
  chown -R "$uid:$gid" "$jailroot"
  chmod 0755 "$jailroot" "$jailroot/run"
  local sock="$jailroot/run/firecracker.socket"
  local log="$work/boot-$number.serial.log"
  "$JAILER" --id "$id" --exec-file "$FC" --uid "$uid" --gid "$gid" \
    --chroot-base-dir "$base" --netns "/var/run/netns/$ns" --new-pid-ns \
    --cgroup-version 2 --parent-cgroup "$NEXARA_JAILER_PARENT_CGROUP" \
    --cgroup memory.max=268435456 --cgroup pids.max=64 --cgroup "cpu.max=100000 100000" \
    -- --api-sock /run/firecracker.socket >"$log" 2>&1 &
  local jailer_pid=$!
  local fc_pid=""
  for _ in $(seq 1 100); do
    [[ -S "$sock" ]] && break
    kill -0 "$jailer_pid" 2>/dev/null || { cat "$log" >&2; fail "jailer exited before API socket creation"; }
    sleep 0.1
  done
  [[ -S "$sock" ]] || { cat "$log" >&2; fail "Firecracker API socket did not appear"; }
  for _ in $(seq 1 50); do
    fc_pid="$(pgrep -x firecracker | head -n1 || true)"
    [[ -n "$fc_pid" ]] && break
    sleep 0.1
  done
  [[ -n "$fc_pid" ]] || fail "cannot identify live Firecracker PID"
  api(){ curl --fail --silent --show-error --unix-socket "$sock" -X PUT "http://localhost$1" -H 'Content-Type: application/json' -d "$2" >/dev/null; }
  api /boot-source '{"kernel_image_path":"/vmlinux.bin","initrd_path":"/initramfs.cpio.gz","boot_args":"console=ttyS0 reboot=k panic=1 pci=off"}'
  api /drives/rootfs '{"drive_id":"rootfs","path_on_host":"/rootfs.ext4","is_root_device":true,"is_read_only":false}'
  api /machine-config '{"vcpu_count":1,"mem_size_mib":256,"smt":false}'
  curl --fail --silent --show-error --unix-socket "$sock" -X PUT http://localhost/actions \
    -H 'Content-Type: application/json' -d '{"action_type":"InstanceStart"}' >/dev/null
  local complete=0
  for _ in $(seq 1 300); do
    if grep -Fq NEXARA_GUEST_VALIDATION_COMPLETE "$log"; then complete=1; break; fi
    kill -0 "$jailer_pid" 2>/dev/null || break
    sleep 0.1
  done
  (( complete == 1 )) || { cat "$log" >&2; fail "guest boot $number did not complete"; }
  fc_pid="$(pgrep -x firecracker | head -n1 || true)"
  [[ -n "$fc_pid" ]] || fail "Firecracker exited before live jail verification"
  NEXARA_CGROUP_PREFIX=nexara bash "$(dirname "$0")/verify-jailed-process.sh" "$fc_pid"
  cp "$log" "$work/boot-$number.serial.log.saved"
  kill -TERM "$fc_pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    pgrep -x firecracker >/dev/null || break
    sleep 0.1
  done
  pgrep -x firecracker >/dev/null && { pkill -KILL -x firecracker || true; fail "Firecracker did not exit"; }
  wait "$jailer_pid" 2>/dev/null || true
  cp "$jailroot/rootfs.ext4" "$work/persistent.ext4"
  rm -rf -- "$base/firecracker/$id"
  echo "PASS: boot $number completed under jailer; persistent disk captured"
}
run_boot 1
run_boot 2
bash "$(dirname "$0")/verify-two-boot-guest-evidence.sh" \
  "$work/boot-1.serial.log" "$work/boot-2.serial.log"
mkdir -m 0700 -p "$work/evidence"
cp "$work/boot-1.serial.log" "$work/boot-2.serial.log" "$work/evidence/"
sha256sum "$work/evidence/"*.serial.log "$work/persistent.ext4" > "$work/evidence/SHA256SUMS"
printf 'kernel=%s\nfirecracker=%s\njailer=%s\n' \
  "$(sha256sum "$KERNEL" | awk '{print $1}')" \
  "$(sha256sum "$FC" | awk '{print $1}')" \
  "$(sha256sum "$JAILER" | awk '{print $1}')" > "$work/evidence/build-digests.txt"
echo "PASS: two real Firecracker boots found the same persisted ext4 marker"
echo "Evidence: $work/evidence"
