/**
 * Strict Docker sandbox policy for untrusted interactive guest workloads.
 * No host paths, devices, capabilities, or network are passed into the guest.
 * Use a sandboxed runtime such as runsc; plain runc shares the host kernel.
 */
export function buildSandboxArgs({ image, runtime = "runsc", memory = "512m", cpus = "1", pids = 64 } = {}) {
  if (typeof image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image)) {
    throw new TypeError("NEXARA_SANDBOX_IMAGE must be a trusted, pre-pulled image reference");
  }
  if (!["runsc", "kata", "io.containerd.kata.v2"].includes(runtime)) throw new TypeError("Sandbox runtime must be runsc or Kata; runc is not supported for guest sessions");
  if (typeof memory !== "string" || !/^(?:[1-9]\d{0,3})(?:m|g)$/.test(memory)) throw new TypeError("Invalid sandbox memory limit");
  if (typeof cpus !== "string" || !/^(?:[1-9]\d*(?:\.\d{1,2})?|0\.\d{1,2})$/.test(cpus) || Number(cpus) <= 0 || Number(cpus) > 4) throw new TypeError("Invalid sandbox CPU limit");
  if (!Number.isSafeInteger(pids) || pids < 8 || pids > 512) throw new TypeError("Invalid sandbox PID limit");
  return [
    "run", "--rm", "--interactive", "--tty",
    "--runtime", runtime,
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit", String(pids),
    "--memory", memory,
    "--cpus", cpus,
    "--user", "65534:65534",
    "--env", "HOME=/tmp",
    "--env", "TERM=xterm-256color",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=65534,gid=65534",
    "--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=128m,uid=65534,gid=65534",
    "--workdir", "/workspace",
    "--entrypoint", "/bin/sh",
    image,
    "-l"
  ];
}

export function sandboxCapabilities({ runtime = "runsc", imageConfigured = false } = {}) {
  return Object.freeze({
    id: "docker-sandbox",
    available: Boolean(imageConfigured),
    // Only Kata provides a guest-kernel boundary; runsc is a syscall sandbox
    // and runc is ordinary container isolation. All still rely on host kernel.
    isolated: runtime === "kata" || runtime === "io.containerd.kata.v2",
    sandboxed: runtime !== "runc",
    isolationRuntime: runtime,
    sharedHostKernel: runtime !== "kata" && runtime !== "io.containerd.kata.v2",
    networkAccess: false,
    hostFilesystemMounts: false,
    readOnlyRootFilesystem: true,
    droppedCapabilities: true,
    resourceLimits: true,
    warning: runtime === "runc"
      ? "runc is ordinary container isolation and shares the host kernel; not suitable for hostile guests"
      : runtime === "runsc"
        ? "gVisor adds a syscall isolation layer but still relies on the host kernel; use Kata or a dedicated microVM for hostile guest kernels"
        : "Kata uses a lightweight VM boundary; still requires host hardening, policy enforcement and escape testing"
  });
}
