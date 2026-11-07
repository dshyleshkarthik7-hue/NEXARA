import test from "node:test";
import assert from "node:assert/strict";
import { buildSandboxArgs, sandboxCapabilities } from "../apps/server/src/container-policy.js";

test("sandbox policy disables host networking, mounts, privileges and writable root", () => {
  const args = buildSandboxArgs({ image: "nexara/guest:stable", runtime: "runsc" });
  for (const required of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit", "--memory", "--cpus", "--user", "65534:65534", "--tmpfs"]) {
    assert.ok(args.includes(required), `missing ${required}`);
  }
  assert.equal(args.some(value => value.startsWith("/host") || value.includes("/var/run/docker.sock")), false);
  assert.equal(sandboxCapabilities({ runtime: "runsc", imageConfigured: true }).isolated, true);
  assert.equal(sandboxCapabilities({ runtime: "runc", imageConfigured: true }).isolated, false);
});

test("sandbox policy rejects invalid images, runtimes and resource limits", () => {
  assert.throws(() => buildSandboxArgs({ image: "../host" }), /trusted/);
  assert.throws(() => buildSandboxArgs({ image: "nexara/guest", runtime: "unknown" }), /runtime/);
  assert.throws(() => buildSandboxArgs({ image: "nexara/guest", memory: "0m" }), /memory/);
  assert.throws(() => buildSandboxArgs({ image: "nexara/guest", cpus: "99" }), /CPU/);
  assert.throws(() => buildSandboxArgs({ image: "nexara/guest", pids: 9999 }), /PID/);
});
