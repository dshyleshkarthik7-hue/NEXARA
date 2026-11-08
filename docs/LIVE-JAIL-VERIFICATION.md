# Live Firecracker jail verification

This check inspects a **running Firecracker process**. It complements, but does not replace, `scripts/host-validation.sh`, which checks host prerequisites and a namespace firewall probe.

## Run it

1. Start a disposable VM through the configured production jailer/provider on a dedicated Linux/KVM host.
2. Find the Firecracker PID inside the host PID namespace (for example, with `pgrep -x firecracker`; verify the selected PID belongs to the test VM).
3. Run:

```sh
sudo NEXARA_CGROUP_PREFIX=nexara scripts/verify-jailed-process.sh FIRECRACKER_PID
```

The script fails closed unless the selected process:
- is the Firecracker executable and has a non-root effective UID;
- has `NoNewPrivs: 1` and `Seccomp: 2` in `/proc/PID/status`;
- is in a distinct PID namespace and network namespace from PID 1;
- is in the configured NEXARA cgroup-v2 subtree with finite `cpu.max`, `memory.max`, and `pids.max` values.

Set `NEXARA_CGROUP_PREFIX` to the operator-configured cgroup subtree name if it is not `nexara`.

## Interpretation and limits

A passing result is evidence about the **observed process at inspection time**, not proof that the seccomp filter is the intended allowlist, that every device path is safe, or that a guest cannot exploit KVM/Firecracker/kernel vulnerabilities. It does not boot a guest, test guest-to-host escape resistance, validate TAP firewall policy, or test disk durability across power loss.

The repository currently does not provide a bootable, supported Linux guest image pipeline. Do not report a guest boot/attack test as complete until that pipeline exists and the test has run on a dedicated KVM host. Preserve the output and host/kernel/Firecracker versions as validation evidence.
