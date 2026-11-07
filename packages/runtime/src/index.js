/**
 * Stable integration boundary for execution engines.
 * Implementations must report capabilities honestly and isolate guest state.
 * The host-PTY backend is not an emulator and must never advertise x86 support.
 */
export class ExecutionBackend {
  constructor(id) {
    if (!id || typeof id !== "string") throw new TypeError("Backend id is required");
    this.id = id;
  }
  getCapabilities() {
    throw new Error("getCapabilities() must be implemented");
  }
  async createMachine(_configuration) {
    throw new Error("createMachine() must be implemented");
  }
}

export const MACHINE_ARCHITECTURES = Object.freeze(["x86", "x86_64"]);
