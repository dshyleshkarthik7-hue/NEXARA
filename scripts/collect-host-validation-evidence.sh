#!/usr/bin/env bash
# Collect a fail-closed evidence bundle after a real two-boot Firecracker run.
set -Eeuo pipefail
fail(){ echo "EVIDENCE COLLECTION FAILED: $*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || fail "Linux host required"
[[ "$(id -u)" == 0 ]] || fail "run as root"
[[ $# -eq 5 ]] || fail "usage: $0 FIRECRACKER_PID FIRST_SERIAL SECOND_SERIAL NFT_BEFORE NFT_AFTER"
pid="$1"; first="$2"; second="$3"; before="$4"; after="$5"
for f in "$first" "$second"; do [[ -f "$f" && ! -L "$f" && -s "$f" ]] || fail "missing or unsafe serial log: $f"; done
command -v sha256sum >/dev/null || fail "sha256sum required"
command -v python3 >/dev/null || fail "python3 required"
script_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
"$script_dir/verify-jailed-process.sh" "$pid"
"$script_dir/verify-two-boot-guest-evidence.sh" "$first" "$second" "$before" "$after"
out="${NEXARA_EVIDENCE_DIR:-nexara-host-evidence-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -m 0700 -p "$out"
cp -- "$first" "$out/first-boot.serial.log"
cp -- "$second" "$out/second-boot.serial.log"
chmod 0600 "$out"/*.serial.log
sha256sum "$out"/*.serial.log > "$out/SHA256SUMS"
status="/proc/$pid/status"
cgroup="$(awk -F: '$1 == "0" {print $3}' "/proc/$pid/cgroup")"
exe="$(readlink "/proc/$pid/exe")"
python3 - "$out/host-evidence.json" "$pid" "$exe" "$cgroup" "$before" "$after" <<'PY'
import json, os, platform, sys, time
target,pid,exe,cgroup,before,after=sys.argv[1:]
data={"schema":1,"collectedAtUtc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"kernel":platform.release(),"machine":platform.machine(),"firecrackerPid":int(pid),"firecrackerExecutable":exe,"cgroup":cgroup,"nftDropCounterBefore":int(before),"nftDropCounterAfter":int(after),"counterIncreased":int(after)>int(before),"seccompMode":None,"noNewPrivileges":None}
with open('/proc/'+pid+'/status') as f:
 for line in f:
  if line.startswith('Seccomp:'): data['seccompMode']=int(line.split()[1])
  if line.startswith('NoNewPrivs:'): data['noNewPrivileges']=int(line.split()[1])
if data['seccompMode'] != 2 or data['noNewPrivileges'] != 1 or not data['counterIncreased']: raise SystemExit('kernel evidence did not satisfy required isolation checks')
with open(target,'x') as f: json.dump(data,f,indent=2); f.write('\n')
PY
chmod 0600 "$out/host-evidence.json" "$out/SHA256SUMS"
echo "PASS: evidence bundle written to $out"
echo "NOTE: bundle proves only the inspected process and supplied guest logs/counters; retain runner identity and Firecracker image provenance separately."
