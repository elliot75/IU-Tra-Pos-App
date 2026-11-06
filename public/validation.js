// Shared by the HTTP server and browser; keep validation independent of Node APIs.
export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

export const MAX_REQUEST_BYTES = 65536;

export function normalizeNote(value = '') {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError('備註須為 200 字以內的單行文字');
  }
  return value.trim();
}

export function quoteBody(menuRelease, items) {
  const body = JSON.stringify({ menuRelease, items });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new ValidationError('訂單內容已達大小上限，請減少明細或備註後再加入');
  }
  return body;
}
