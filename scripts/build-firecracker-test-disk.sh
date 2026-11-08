#!/usr/bin/env bash
# Create a clean ext4 root disk for the BusyBox persistence smoke test.
set -Eeuo pipefail
fail(){ echo "TEST DISK BUILD FAILED: $*" >&2; exit 1; }
[[ $# -eq 1 ]] || fail "usage: $0 OUTPUT.ext4"
for x in truncate mkfs.ext4 dumpe2fs sha256sum; do command -v "$x" >/dev/null || fail "missing tool: $x"; done
out="$1"
[[ "$out" == /* ]] || fail "output path must be absolute"
mkdir -p "$(dirname "$out")"
[[ ! -e "$out" && ! -L "$out" ]] || fail "refusing to overwrite an existing disk image"
size="${NEXARA_TEST_DISK_MIB:-64}"
[[ "$size" =~ ^[0-9]+$ ]] && (( size >= 16 && size <= 4096 )) || fail "disk size must be 16..4096 MiB"
truncate -s "${size}M" "$out"
if ! mkfs.ext4 -F -q -L NEXARA_TEST "$out"; then rm -f "$out"; fail "mkfs.ext4 failed"; fi
dumpe2fs -h "$out" 2>/dev/null | grep -q '^Filesystem volume name: *NEXARA_TEST$' || fail "ext4 filesystem label verification failed"
echo "Created ext4 test disk: $out (${size} MiB)"
sha256sum "$out"
