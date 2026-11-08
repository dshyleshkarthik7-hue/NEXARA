#!/usr/bin/env bash
set -Eeuo pipefail
fail() { echo "HOST VALIDATION FAILED: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }
[[ "$(uname -s)" == Linux ]] || fail "Linux host required"
[[ "$(id -u)" == 0 ]] || fail "run this validation as root"
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || fail "/dev/kvm unavailable"
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail "cgroup v2 is not mounted"
for controller in cpu memory pids; do grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers || fail "missing cgroup controller: $controller"; done
need ip
need nft
need python3
need timeout
: "\${FIRECRACKER_BIN:?Set FIRECRACKER_BIN to the trusted Firecracker executable}"
: "\${JAILER_BIN:?Set JAILER_BIN to the trusted jailer executable}"
for binary in "$FIRECRACKER_BIN" "$JAILER_BIN"; do
  [[ "$binary" == /* && -f "$binary" && -x "$binary" && ! -L "$binary" ]] || fail "invalid binary path: $binary"
  mode="$(stat -c '%a' "$binary")"
  (( (8#$mode & 0022) == 0 )) || fail "binary is group/other writable: $binary"
done
grep -qw seccomp /proc/sys/kernel/seccomp/actions_avail || fail "kernel seccomp unavailable"
echo "== Host prerequisites =="
uname -a
"$FIRECRACKER_BIN" --version
"$JAILER_BIN" --version
ip -Version
nft --version
echo "cgroup v2 controllers: $(cat /sys/fs/cgroup/cgroup.controllers)"
echo "seccomp actions: $(cat /proc/sys/kernel/seccomp/actions_avail)"
echo "== Namespace + nftables egress-deny probe =="
suffix="nxhv$RANDOM"
ns="$suffix"
host_if="h$suffix"
guest_if="g$suffix"
host_ip="198.18.255.1"
guest_ip="198.18.255.2"
port="$((20000 + RANDOM % 20000))"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  ip netns del "$ns" 2>/dev/null || true
  ip link del "$host_if" 2>/dev/null || true
}
trap cleanup EXIT
ip netns add "$ns"
ip link add "$host_if" type veth peer name "$guest_if"
ip link set "$guest_if" netns "$ns"
ip addr add "$host_ip/30" dev "$host_if"
ip link set "$host_if" up
ip -n "$ns" addr add "$guest_ip/30" dev "$guest_if"
ip -n "$ns" link set lo up
ip -n "$ns" link set "$guest_if" up
ip netns exec "$ns" nft -f - <<'NFT'
table inet nexara_host_validation {
  chain input { type filter hook input priority 0; policy drop; }
  chain output { type filter hook output priority 0; policy drop; }
  chain forward { type filter hook forward priority 0; policy drop; }
}
NFT
python3 -c 'import socket,sys; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind((sys.argv[1],int(sys.argv[2]))); s.listen(1); s.settimeout(8);
try: s.accept()
except TimeoutError: pass' "$host_ip" "$port" &
server_pid=$!
ip netns exec "$ns" nft add rule inet nexara_host_validation output counter drop
sleep 0.2
if ip netns exec "$ns" timeout 2 python3 -c 'import socket,sys; socket.create_connection((sys.argv[1],int(sys.argv[2])),timeout=1)' "$host_ip" "$port" 2>/dev/null; then
  fail "namespace egress reached host listener despite nftables output drop"
fi
rule_output="$(ip netns exec "$ns" nft list chain inet nexara_host_validation output)"
echo "$rule_output" | grep -Eq "counter packets [1-9][0-9]*" || fail "egress probe did not hit namespace nftables drop rule"
echo "PASS: outbound packet was counted by the namespace nftables drop rule"
echo "PASS: KVM/cgroup/seccomp prerequisites and kernel firewall probe completed"
echo "NOTE: this does not boot Firecracker or verify jailer-applied seccomp/cgroups inside a guest."
