#!/usr/bin/env bash
# Validate two real Firecracker guest boots and optionally a separately measured host firewall probe.
set -Eeuo pipefail
fail(){ echo "GUEST EVIDENCE FAILED: $*" >&2; exit 1; }
[[ $# -eq 2 || $# -eq 4 ]] || fail "usage: $0 first-boot.serial.log second-boot.serial.log [nft-drop-counter-before nft-drop-counter-after]"
first="$1"; second="$2"
[[ -f "$first" && ! -L "$first" && -s "$first" ]] || fail "first boot serial log missing/empty"
[[ -f "$second" && ! -L "$second" && -s "$second" ]] || fail "second boot serial log missing/empty"
if [[ $# -eq 4 ]]; then
  before="$3"; after="$4"
  [[ "$before" =~ ^[0-9]+$ && "$after" =~ ^[0-9]+$ ]] || fail "nftables counters must be decimal integers"
fi
for marker in NEXARA_GUEST_BOOT_OK NEXARA_DISK_WRITE_OK NEXARA_GUEST_VALIDATION_COMPLETE; do
  grep -Fq "$marker" "$first" || fail "first boot missing marker: $marker"
done
for marker in NEXARA_GUEST_BOOT_OK NEXARA_DISK_PERSISTENCE_PRESENT NEXARA_GUEST_VALIDATION_COMPLETE; do
  grep -Fq "$marker" "$second" || fail "second boot missing marker: $marker"
done
for log in "$first" "$second"; do
  grep -Eq 'NEXARA_(DISK_MOUNT_FAILED|DISK_WRITE_FAILED)' "$log" && fail "guest reported a disk failure in $log" || true
done
if [[ $# -eq 4 ]]; then
  (( after > before )) || fail "host nftables drop counter did not increase ($before -> $after)"
fi
echo "PASS: first boot wrote and synced the persistence marker"
echo "PASS: second boot found the same marker on the persistent disk"
if [[ $# -eq 4 ]]; then echo "PASS: separately measured host nftables drop counter increased from $before to $after"; fi
