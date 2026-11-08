const HEX_256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}
function assertDigest(value, name) {
  if (typeof value !== "string" || !HEX_256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}
function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Manifest numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  assertObject(value, "Manifest value");
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`Undefined manifest field: ${key}`);
    output[key] = normalize(value[key]);
  }
  return output;
}

/** Canonical JSON: recursively sorted object keys and no non-JSON values. */
export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function validateMachineManifest(input) {
  assertObject(input, "Machine manifest");
  if (input.schemaVersion !== 1) throw new TypeError("Unsupported NMF schemaVersion; expected 1");
  assertObject(input.cpu, "cpu");
  if (input.cpu.architecture !== "x86") throw new TypeError("cpu.architecture must be x86");
  if (![32, 64].includes(input.cpu.mode)) throw new TypeError("cpu.mode must be 32 or 64");
  if (typeof input.cpu.model !== "string" || !input.cpu.model.trim()) throw new TypeError("cpu.model is required");
  if (!Number.isSafeInteger(input.memoryMiB) || input.memoryMiB < 1) throw new TypeError("memoryMiB must be a positive integer");
  if (!Array.isArray(input.devices) || !Array.isArray(input.diskLayers)) throw new TypeError("devices and diskLayers must be arrays");
  for (const [index, layer] of input.diskLayers.entries()) {
    assertObject(layer, `diskLayers[${index}]`);
    assertDigest(layer.digest, `diskLayers[${index}].digest`);
    if (!Number.isSafeInteger(layer.sizeBytes) || layer.sizeBytes < 0) throw new TypeError("disk layer sizeBytes must be a non-negative integer");
    if (typeof layer.format !== "string" || !layer.format.trim()) throw new TypeError("disk layer format is required");
  }
  if (input.kernel !== null) {
    assertObject(input.kernel, "kernel");
    assertDigest(input.kernel.digest, "kernel.digest");
    if (!Number.isSafeInteger(input.kernel.sizeBytes) || input.kernel.sizeBytes < 0) throw new TypeError("kernel.sizeBytes must be a non-negative integer");
  }
  assertObject(input.policy, "policy");
  return normalize(input);
}

export async function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : encoder.encode(String(bytes));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  const digest = await subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function identifyMachine(input) {
  const manifest = validateMachineManifest(input);
  const canonical = canonicalJson(manifest);
  return Object.freeze({ manifest, canonical, digest: await sha256Hex(encoder.encode(canonical)), uri: `nmf:sha256:${await sha256Hex(encoder.encode(canonical))}` });
}

export function parseMachineManifest(source) {
  if (typeof source !== "string") throw new TypeError("Manifest source must be JSON text");
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw new TypeError("Machine manifest is not valid JSON"); }
  return validateMachineManifest(parsed);
}
