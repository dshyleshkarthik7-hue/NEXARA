import { spawn as nodeSpawn } from "node:child_process";

/**
 * Creates one default-deny network namespace and TAP device per microVM.
 * This deliberately provides no uplink/NAT: egress remains blocked until an
 * operator adds explicit routing and firewall allow rules.
 */
export class LinuxNetworkProvider {
  #ip;
  #nft;
  #run;
  #netnsDirectory;

  constructor({ ipPath = "/usr/sbin/ip", nftPath = "/usr/sbin/nft",
    netnsDirectory = "/run/netns", run = runCommand } = {}) {
    for (const [key, value] of Object.entries({ ipPath, nftPath, netnsDirectory })) {
      if (typeof value !== "string" || !value.startsWith("/")) throw new TypeError(key + " must be an absolute path");
    }
    if (typeof run !== "function") throw new TypeError("run must be a process adapter");
    this.#ip = ipPath;
    this.#nft = nftPath;
    this.#netnsDirectory = netnsDirectory;
    this.#run = run;
  }

  async provision({ id, uid, gid } = {}) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)
      || !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) {
      throw new TypeError("Invalid VM identity for network provisioning");
    }
    const suffix = id.replaceAll("-", "").slice(0, 10);
    const name = "nx-" + suffix;
    const tapName = "tap" + suffix.slice(0, 8);
    const netnsPath = this.#netnsDirectory + "/" + name;
    let created = false;
    try {
      await this.#run(this.#ip, ["netns", "add", name]);
      created = true;
      await this.#run(this.#ip, ["-n", name, "link", "set", "lo", "up"]);
      await this.#run(this.#ip, ["-n", name, "tuntap", "add", "dev", tapName, "mode", "tap", "user", String(uid), "group", String(gid)]);
      await this.#run(this.#ip, ["-n", name, "link", "set", tapName, "up"]);
      const rules = [
        "table inet nexara {",
        " chain input { type filter hook input priority 0; policy drop;",
        "  iifname \"lo\" accept",
        "  ct state established,related accept",
        " }",
        " chain output { type filter hook output priority 0; policy drop;",
        "  oifname \"lo\" accept",
        "  ct state established,related accept",
        " }",
        " chain forward { type filter hook forward priority 0; policy drop; }",
        "}"
      ].join("\n");
      await this.#run(this.#ip, ["netns", "exec", name, this.#nft, "-f", "-"], rules);
    } catch (error) {
      if (created) await this.#run(this.#ip, ["netns", "del", name]).catch(() => {});
      throw error;
    }
    let released = false;
    return Object.freeze({
      id, name, tapName, netnsPath,
      release: async () => {
        if (released) return;
        await this.#run(this.#ip, ["netns", "del", name]);
        released = true;
      }
    });
  }

  async release(handle) {
    if (!handle || typeof handle.release !== "function") throw new TypeError("Invalid network namespace handle");
    await handle.release();
  }
}

function runCommand(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" }
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk.slice(0, 4096 - stderr.length); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error("Host network command failed (" + command + "): " + stderr.slice(0, 512)));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
