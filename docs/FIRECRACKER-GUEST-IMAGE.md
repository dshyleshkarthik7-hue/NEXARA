# Building a Firecracker test guest

NEXARA supports an optional digest-pinned initramfs in the Firecracker boot-source API. This is a minimal Linux guest harness, not a complete distro image or a security certification.

## Inputs
- A trusted compatible Linux kernel with virtio block and serial console support.
- A static BusyBox executable built for the guest architecture.
- `cpio`, `gzip`, and `sha256sum` on the image-building host.
- A Firecracker-compatible ext4 root disk image within the signed VM disk quota.

Build the initramfs:
```sh
scripts/build-firecracker-guest-initramfs.sh /absolute/path/to/busybox-static dist/guest-initramfs.cpio.gz
sha256sum dist/guest-initramfs.cpio.gz
```

The trusted image resolver should return a manifest containing `kernelPath`, `kernelDigest`, `rootfsPath`, `rootfsDigest`, `initrdPath`, and `initrdDigest`, in addition to its signed manifest digest. Never accept artifact paths or hashes directly from an API client. The Firecracker driver verifies all three artifact digests, stages the initramfs read-only inside the jail, and sets `initrd_path` on the boot-source API.

## Guest probes
- `NEXARA_GUEST_BOOT_OK`: Linux reached init.
- `NEXARA_DISK_WRITE_OK`: marker was written and synced to `/dev/vda` mounted as ext4.
- `NEXARA_EGRESS_BLOCKED`: optional BusyBox `nc` probe could not connect to a public test address.
- `NEXARA_GUEST_VALIDATION_COMPLETE`: guest-side probes finished.

The egress probe is advisory; a failed TCP connection alone does not prove firewall enforcement. Correlate with host nftables counters and packet captures. Keep the test network default-deny.

## Limitations
The builder requires a static BusyBox and a compatible kernel supplied by the operator. It does not download or compile a kernel, sign images, or produce a full Linux distribution. The minimal shell is PID 1 and does not include SSH, systemd, package management, or a general-purpose service stack. CI tests mocked Firecracker API/process boundaries. Real guest boot, guest escape probes, and disk persistence after actual host power loss still require a dedicated KVM runner.