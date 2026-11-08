#!/usr/bin/env bash
# Validate evidence collected from two real Firecracker guest boots.
set -Eeuo pipefail
fail(){ echo "GUEST EVIDENCE FAILED: $*" >&2; exit 1; }
[[ $# -eq 4 ]] || fail "usage: $0 first-boot.serial.log second-boot.serial.log nft-drop-counter-before nft-drop-counter-after"
first="$1"; second="$2"; before="$3"; after="$4"
[[ -f "$first" && ! -L "$first" && -s "$first" ]] || fail "first boot serial log missing/empty"
[[ -f "$second" && ! -L "$second" && -s "$second" ]] || fail "second boot serial log missing/empty"
[[ "$before" =~ ^[0-9]+$ && "$after" =~ ^[0-9]+$ ]] || fail "nftables counters must be decimal integers"
for marker in NEXARA_GUEST_BOOT_OK NEXARA_DISK_WRITE_OK NEXARA_GUEST_VALIDATION_COMPLETE; do
  grep -Fq "$marker" "$first" || fail "first boot missing marker: $marker"
done
for marker in NEXARA_GUEST_BOOT_OK NEXARA_DISK_PERSISTENCE_PRESENT NEXARA_GUEST_VALIDATION_COMPLETE; do
  grep -Fq "$marker" "$second" || fail "second boot missing marker: $marker"
done
for log in "$first" "$second"; do
  if grep -Eq 'NEXARA_(DISK_MOUNT_FAILED|DISK_WRITE_FAILED|EGRESS_UNEXPECTEDLY_ALLOWED)' "$log"; then
    fail "guest reported a disk or egress failure in $log"
  fi
  grep -Fq NEXARA_EGRESS_BLOCKED "$log" || fail "guest egress probe did not report blocked in $log"
done
(( after > before )) || fail "host nftables drop counter did not increase ($before -> $after)"
echo "PASS: first boot wrote and synced the persistence marker"
echo "PASS: second boot found the same marker on the persistent disk"
echo "PASS: guest egress probes were blocked on both boots"
echo "PASS: host nftables drop counter increased from $before to $after"
