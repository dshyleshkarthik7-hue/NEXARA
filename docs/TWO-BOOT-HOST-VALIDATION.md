# Two-boot Firecracker validation evidence

After running the guest twice against the **same persistent VM disk**, save each guest serial console output to separate files. Capture the host nftables drop counter for the VM's egress chain immediately before and after each guest egress probe (or the aggregate probe interval).

Run:

```sh
scripts/verify-two-boot-guest-evidence.sh first-boot.serial.log second-boot.serial.log 12 15
```

The final two arguments are the observed nftables counter values, not configured expectations. The validator requires:
- First boot: Linux boot marker, first-write marker, validation-complete marker.
- Second boot: Linux boot marker, persistence-present marker, validation-complete marker.
- Both boots: guest reports egress blocked and no disk/egress failure marker.
- Host nftables drop counter increases across the probe interval.

Collect the counter from the actual per-VM nftables chain; do not substitute a global host counter that could be incremented by unrelated traffic. Keep raw logs, counter snapshots, kernel/Firecracker versions, VM image digests, and host identity with the test report.

This script validates supplied evidence; it does not launch Firecracker, capture serial output, prove the counter belongs to the guest without correct chain attribution, or replace a dedicated KVM run. A passing result is an integration signal, not proof against VM escape or power-loss corruption.
