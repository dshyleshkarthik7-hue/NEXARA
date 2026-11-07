import test from "node:test";
import assert from "node:assert/strict";
import { isClientMessage, encodeInput, encodeResize } from "../packages/protocol/src/index.js";

test("accepts bounded terminal input", () => {
  assert.equal(isClientMessage({ type: "input", data: "ls -la" }), true);
  assert.equal(isClientMessage({ type: "input", data: "x".repeat(16385) }), false);
});
test("validates terminal dimensions", () => {
  assert.equal(isClientMessage({ type: "resize", cols: 120, rows: 40 }), true);
  assert.equal(isClientMessage({ type: "resize", cols: 1, rows: 40 }), false);
  assert.equal(isClientMessage({ type: "resize", cols: 120.5, rows: 40 }), false);
});
test("encoders serialize validated messages", () => {
  assert.deepEqual(JSON.parse(encodeInput("pwd")), { type: "input", data: "pwd" });
  assert.deepEqual(JSON.parse(encodeResize(80, 24)), { type: "resize", cols: 80, rows: 24 });
  assert.throws(() => encodeResize(0, 24), TypeError);
});
