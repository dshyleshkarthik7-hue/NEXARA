import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../apps/server/src/session-registry.js";

function fakeSession() {
  return { killed: 0, kill() { this.killed++; } };
}

test("session registry enforces global and per-owner capacity", () => {
  const registry = new SessionRegistry({ maxSessions: 2, maxSessionsPerOwner: 1 });
  assert.equal(registry.canCreate("client-a"), true);
  const a = fakeSession();
  registry.add("a", { session: a, token: "secret-a", owner: "client-a" });
  assert.equal(registry.canCreate("client-a"), false);
  assert.equal(registry.canCreate("client-b"), true);
  registry.add("b", { session: fakeSession(), token: "secret-b", owner: "client-b" });
  assert.equal(registry.canCreate("client-c"), false);
});

test("session credentials are compared and authorization is scoped by id", () => {
  const registry = new SessionRegistry();
  registry.add("one", { session: fakeSession(), token: "random-secret", owner: "client" });
  assert.equal(registry.authorize("one", "random-secret").id, "one");
  assert.equal(registry.authorize("one", "wrong"), null);
  assert.equal(registry.authorize("missing", "random-secret"), null);
});

test("creation rate limit expires entries after its time window", () => {
  let now = 1000;
  const registry = new SessionRegistry({ createLimit: 2, createWindowMs: 1000, now: () => now });
  assert.equal(registry.canCreate("client"), true);
  assert.equal(registry.canCreate("client"), true);
  assert.equal(registry.canCreate("client"), false);
  now += 1001;
  assert.equal(registry.canCreate("client"), true);
});

test("idle sessions are killed and removed, active sessions survive", () => {
  let now = 0;
  const registry = new SessionRegistry({ idleTimeoutMs: 500, now: () => now });
  const idle = fakeSession();
  const active = fakeSession();
  registry.add("idle", { session: idle, token: "a", owner: "a" });
  registry.add("active", { session: active, token: "b", owner: "b" });
  now = 400;
  registry.touch("active");
  now = 500;
  assert.deepEqual(registry.sweepIdle(), ["idle"]);
  assert.equal(idle.killed, 1);
  assert.equal(active.killed, 0);
  assert.equal(registry.authorize("idle", "a"), null);
  assert.equal(registry.size, 1);
});

test("closeAll terminates every remaining process exactly once", () => {
  const registry = new SessionRegistry();
  const a = fakeSession();
  const b = fakeSession();
  registry.add("a", { session: a, token: "a", owner: "a" });
  registry.add("b", { session: b, token: "b", owner: "b" });
  assert.equal(registry.closeAll(), 2);
  assert.equal(registry.size, 0);
  assert.equal(a.killed, 1);
  assert.equal(b.killed, 1);
});
