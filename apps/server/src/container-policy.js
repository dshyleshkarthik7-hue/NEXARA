/**
 * Strict Docker sandbox policy for untrusted interactive guest workloads.
 * No host paths, devices, capabilities, or network are passed into the guest.
 * Use a sandboxed runtime such as runsc; plain runc shares the host kernel.
 */
export function buildSandboxArgs({ image, runtime = "runsc", memory = "512m", cpus = "1", pids = 64 } = {}) {
  if (typeof image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(image)) {
    throw new TypeError("NEXARA_SANDBOX_IMAGE must be a trusted, pre-pulled image reference");
  }
  if (typeof runtime !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(runtime)) throw new TypeError("Invalid sandbox runtime");
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
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=128m",
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
    isolated: runtime !== "runc",
    isolationRuntime: runtime,
    sharedHostKernel: true,
    networkAccess: false,
    hostFilesystemMounts: false,
    readOnlyRootFilesystem: true,
    droppedCapabilities: true,
    resourceLimits: true,
    warning: runtime === "runc"
      ? "runc shares the host kernel; not suitable as the sole boundary for hostile guests"
      : "Container isolation still shares the host kernel; use a dedicated microVM for high-risk workloads"
  });
}
