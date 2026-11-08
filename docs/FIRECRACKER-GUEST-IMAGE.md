# NEXARA self-built Firecracker guest bundle

NEXARA's build pipeline compiles the upstream Firecracker VMM and jailer, a static BusyBox userspace, and a Linux kernel suitable for direct Firecracker boot. The runtime bundle is intended to contain the executables and guest images needed by the host; the host still requires a Linux kernel with KVM support and access to /dev/kvm.

## Build the complete bundle

On Ubuntu 24.04, install the compiler toolchain and kernel build utilities:

```sh
sudo apt-get update
sudo apt-get install -y build-essential clang cmake pkg-config libssl-dev \
  musl-tools musl-dev cpio gzip git curl wget perl file python3 \
  bc bison flex xz-utils libelf-dev libncurses-dev
```

Then run:

```sh
bash scripts/build-host-binaries.sh
bash scripts/build-firecracker-kernel.sh
bash scripts/build-firecracker-guest-initramfs.sh \
  "$PWD/dist/host-binaries/busybox" \
  "$PWD/dist/host-binaries/nexara-guest-initramfs.cpio.gz"
(cd dist/host-binaries && sha256sum -c SHA256SUMS)
```

The GitHub Actions workflow builds the same bundle and uploads it as `nexara-microvm-bundle-linux-x86_64`. Source versions are pinned in the workflow:
- Firecracker and jailer: upstream Firecracker v1.13.1, built together from one source checkout.
- BusyBox: upstream BusyBox 1.36.1, statically linked with musl.
- Linux kernel: upstream Linux 6.12.1, configured with virtio block, serial console, ext4, initramfs and built-in basic networking.

The scripts record exact source commit IDs (Firecracker/BusyBox), source archive SHA-256 (kernel), binary checksums and build metadata. The Linux source URL is kernel.org. Review the source pins and build logs before production use.

## Guest image format

Firecracker does not boot a conventional ISO through BIOS/UEFI. It boots a kernel directly. NEXARA therefore builds a kernel image (`vmlinux.bin`) and a BusyBox initramfs (`nexara-guest-initramfs.cpio.gz`) rather than an ISO. This produces a tiny, self-contained guest userspace without needing an Alpine installation or package manager.

The initramfs validates boot, writable ext4 root-disk access, persistence markers and a best-effort egress probe. It is a test guest, not a full Alpine distribution. A fuller Alpine userspace can later be installed into an ext4 root disk, but that would introduce an Alpine rootfs artifact and its package provenance; it is not required for the minimal NEXARA boot test.

## Dependency boundary

The *built runtime bundle* contains Firecracker, jailer, BusyBox, the guest kernel and initramfs. It does not require Alpine, Docker, a preinstalled Firecracker binary or a prebuilt BusyBox binary. The host still needs a Linux/KVM-capable kernel, /dev/kvm, cgroup v2, seccomp, and networking/firewall support. The build itself necessarily downloads pinned upstream source and uses a compiler/toolchain; a literal zero-dependency source build is not technically possible.

## Validation boundary

A successful build proves compilation and artifact creation only. It does not prove that a guest booted. Actual boot, jailer cgroup/seccomp behavior, two-boot disk persistence and network isolation require running the bundle on a dedicated Linux KVM host. The existing privileged host-validation workflow must be run on the configured self-hosted KVM runner to produce hardware evidence.
