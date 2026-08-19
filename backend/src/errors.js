/** Shared primitives, so a module needing an error does not import a lifecycle. */

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
