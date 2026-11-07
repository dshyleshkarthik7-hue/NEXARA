export const PROTOCOL_VERSION = 1;
const MAX_INPUT_LENGTH = 16 * 1024;

export function isClientMessage(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "input") return typeof value.data === "string" && value.data.length <= MAX_INPUT_LENGTH;
  if (value.type === "resize") {
    return Number.isInteger(value.cols) && Number.isInteger(value.rows)
      && value.cols >= 2 && value.cols <= 500 && value.rows >= 2 && value.rows <= 300;
  }
  return false;
}

export function encodeInput(data) {
  const message = { type: "input", data };
  if (!isClientMessage(message)) throw new TypeError("Invalid terminal input");
  return JSON.stringify(message);
}

export function encodeResize(cols, rows) {
  const message = { type: "resize", cols, rows };
  if (!isClientMessage(message)) throw new TypeError("Invalid terminal dimensions");
  return JSON.stringify(message);
}
