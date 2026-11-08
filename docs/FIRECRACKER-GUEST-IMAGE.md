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
- `NEXARA_DISK_WRITE_OK`: marker was created and synced on the first boot; `NEXARA_DISK_PERSISTENCE_PRESENT`: the same marker was found on a subsequent boot using the same persistent disk. The guest powers off after the probes so the host can perform a clean write-back.
- `NEXARA_EGRESS_BLOCKED`: optional BusyBox `nc` probe could not connect to a public test address.
- `NEXARA_GUEST_VALIDATION_COMPLETE`: guest-side probes finished.

The egress probe is advisory; a failed TCP connection alone does not prove firewall enforcement. Correlate with host nftables counters and packet captures. Keep the test network default-deny.

## Limitations
The builder requires a static BusyBox and a compatible kernel supplied by the operator. It does not download or compile a kernel, sign images, or produce a full Linux distribution. The minimal shell is PID 1 and does not include SSH, systemd, package management, or a general-purpose service stack. CI tests mocked Firecracker API/process boundaries. Real guest boot, guest escape probes, and disk persistence after actual host power loss still require a dedicated KVM runner.

## Building NEXARA's own host binaries

NEXARA builds the **upstream Firecracker and jailer executables** from a pinned upstream release; it does not implement a new VMM or a substitute jailer. The two executables are built from the same Firecracker source tree and version. Static BusyBox is built separately with musl for the minimal guest initramfs.

On Ubuntu 24.04, run:

```sh
sudo apt-get update
sudo apt-get install -y build-essential clang cmake pkg-config libssl-dev musl-tools musl-dev cpio gzip git curl wget perl file python3
bash scripts/build-host-binaries.sh
bash scripts/build-firecracker-guest-initramfs.sh \
  "$PWD/dist/host-binaries/busybox" \
  "$PWD/dist/host-binaries/nexara-guest-initramfs.cpio.gz"
```

Or run the **Build NEXARA host binaries** GitHub Actions workflow. It uploads Firecracker, jailer, static BusyBox, the initramfs, build metadata and SHA-256 checksums as a 30-day artifact. Review the pinned source tags, build logs and hashes before promoting binaries to a production host. A successful compilation does not mean a Firecracker guest has booted.

## Alpine Linux compatibility

Firecracker is a microVM VMM, not a PC emulator: it does not boot a conventional Alpine ISO through BIOS/UEFI. It boots a Linux kernel directly. For an Alpine-based guest, use a trusted Firecracker-compatible kernel (with virtio block and serial console support) and an Alpine **minirootfs tarball** installed into an ext4 root disk, or use the minimal BusyBox initramfs built above. The current validation initramfs is intentionally a tiny test guest, not a full Alpine userspace.

Do not feed an Alpine ISO to `boot-source`. To test a full Alpine userspace, create an ext4 image from a digest-pinned Alpine minirootfs, populate it using a trusted image-building pipeline, configure a compatible init process and serial console, and attach it as the root block device. Pin and record the Alpine release, minirootfs digest and kernel digest in the trusted image manifest.
