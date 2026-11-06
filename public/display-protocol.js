// Same-origin routing only: pair/session IDs and nonces are not secrets or authentication.
export const DISPLAY_CHANNEL = 'iutra-display-v1';
export const DISPLAY_TIMEOUT = 4000;
export const DISPLAY_HEARTBEAT = 1000;

export function displayId() {
  const h = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isDisplayId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function displayPairFromHash(hash) {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const pairs = params.getAll('pair');
  return pairs.length === 1 && isDisplayId(pairs[0]) ? pairs[0] : null;
}
