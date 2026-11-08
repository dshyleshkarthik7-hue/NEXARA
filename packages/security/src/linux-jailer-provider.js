import { spawn as nodeSpawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";

/**
 * Linux Firecracker jailer process provider.
 *
 * Requires trusted, root-managed Firecracker+jailer binaries and a writable
 * cgroup-v2 parent. The injected network provider creates a private namespace,
 * TAP device and default-deny nftables policy for every VM.
 */
export class LinuxJailerProvider {
  #jailerPath;
  #firecrackerPath;
  #chrootBaseDir;
  #uid;
  #gid;
  #parentCgroup;
  #spawn;
  #stopTimeoutMs;
  #networkProvider;

  constructor({
    jailerPath, firecrackerPath, chrootBaseDir = "/srv/jailer",
    uid, gid, parentCgroup = "nexara",
    spawn = nodeSpawn, stopTimeoutMs = 5000, networkProvider
  } = {}) {
    for (const [name, value] of Object.entries({ jailerPath, firecrackerPath, chrootBaseDir })) {
      if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError(name + " must be an absolute path");
    }
    if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1
      || typeof spawn !== "function" || !Number.isSafeInteger(stopTimeoutMs)
      || !networkProvider || typeof networkProvider.provision !== "function" || typeof networkProvider.release !== "function"
      || stopTimeoutMs < 100 || stopTimeoutMs > 60000
      || !/^[a-zA-Z0-9_.-]{1,64}$/.test(parentCgroup)) {
      throw new TypeError("Invalid jailer identity, process adapter, timeout or cgroup");
    }
    this.#jailerPath = jailerPath;
    this.#firecrackerPath = firecrackerPath;
    this.#chrootBaseDir = chrootBaseDir;
    this.#uid = uid;
    this.#gid = gid;
    this.#parentCgroup = parentCgroup;
    this.#spawn = spawn;
    this.#stopTimeoutMs = stopTimeoutMs;
    this.#networkProvider = networkProvider;
  }

  async start(config) {
    if (!config || !/^[a-f0-9-]{36}$/i.test(config.id)
      || config.requireJailer !== true || config.requireCgroups !== true
      || config.requireNamespaces !== true || config.requireSeccomp !== true
      || config.requirePrivateApiSocket !== true || config.network?.defaultDeny !== true
      || !config.quotas || !Number.isSafeInteger(config.quotas.cpuMillis)
      || !Number.isSafeInteger(config.quotas.memoryMiB)
      || config.quotas.cpuMillis < 1 || config.quotas.memoryMiB < 16) {
      throw new TypeError("Invalid or insufficiently isolated jailer configuration");
    }
    await Promise.all([
      verifyTrustedExecutable(this.#jailerPath),
      verifyTrustedExecutable(this.#firecrackerPath)
    ]);
    const network = await this.#networkProvider.provision({ id: config.id, uid: this.#uid, gid: this.#gid });
    const jailRoot = path.join(
      this.#chrootBaseDir, path.basename(this.#firecrackerPath), config.id, "root"
    );
    const socketPath = path.join(jailRoot, "firecracker.socket");
    if (socketPath.length >= 104) {
      await this.#networkProvider.release(network).catch(() => {});
      throw new Error("Firecracker Unix socket path exceeds Linux sun_path limit");
    }

    const cpuQuota = Math.max(1000, config.quotas.cpuMillis * 100);
    const args = [
      "--id", config.id,
      "--exec-file", this.#firecrackerPath,
      "--uid", String(this.#uid),
      "--gid", String(this.#gid),
      "--chroot-base-dir", this.#chrootBaseDir,
      "--cgroup-version", "2",
      "--parent-cgroup", this.#parentCgroup,
      "--cgroup", "cpu.max=" + cpuQuota + " 100000",
      "--cgroup", "memory.max=" + String(config.quotas.memoryMiB * 1024 * 1024),
      "--cgroup", "memory.swap.max=0",
      "--cgroup", "pids.max=128",
      "--netns", network.netnsPath,
      "--new-pid-ns",
      "--",
      "--api-sock", "/firecracker.socket"
    ];
    let child;
    try {
    child = this.#spawn(this.#jailerPath, args, {
      cwd: this.#chrootBaseDir,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
      windowsHide: true
    });
    await new Promise((resolve, reject) => {
      const onError = error => { cleanup(); reject(error); };
      const onSpawn = () => { cleanup(); resolve(); };
      const cleanup = () => {
        child.off("error", onError);
        child.off("spawn", onSpawn);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    } catch (error) {
      await this.#networkProvider.release(network).catch(() => {});
      throw error;
    }
    let stopped = false;
    return Object.freeze({
      socketPath,
      jailRoot,
      uid: this.#uid,
      gid: this.#gid,
      network,
      child,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        try { await terminate(child, this.#stopTimeoutMs); }
        finally { await this.#networkProvider.release(network); }
      }
    });
  }

  async stop(host) {
    if (!host || typeof host.stop !== "function") throw new TypeError("Invalid jailer process handle");
    await host.stop();
  }
}

async function verifyTrustedExecutable(filePath) {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error("Jailer and Firecracker binaries must be regular files not writable by group or others");
  }
}

async function terminate(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("close", resolve));
  child.kill("SIGTERM");
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([exited.then(() => "exit"), timeout]);
  clearTimeout(timer);
  if (result === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
