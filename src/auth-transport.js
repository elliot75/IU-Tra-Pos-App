import { isIP } from 'node:net';
import { ServiceError } from './catalog-store.js';

function normalizeIP(value) {
  if (typeof value !== 'string' || value.includes('%') || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // Use the same key for IPv4 and IPv4-mapped IPv6 socket addresses.
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const bits = Number.parseInt(mapped[1], 16) * 65536 + Number.parseInt(mapped[2], 16);
  return [24, 16, 8, 0].map(shift => (bits >>> shift) & 255).join('.');
}

function singleHeader(req, name) {
  // Node can join duplicate headers; count raw occurrences before trusting one.
  if (req.rawHeaders) {
    let count = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === name) count++;
    }
    if (count !== 1) return null;
  }
  const value = req.headers[name];
  return typeof value === 'string' && !value.includes(',') ? value : null;
}

export function createAuthTransport({
  mode = process.env.AUTH_TRANSPORT_MODE ?? 'https-proxy',
  trustedProxyIps = process.env.TRUSTED_PROXY_IPS ?? ''
} = {}) {
  if (!['https-proxy', 'local-development', 'lan-development'].includes(mode)) throw new Error('AUTH_TRANSPORT_MODE must be https-proxy, local-development or lan-development');
  if (typeof trustedProxyIps !== 'string') throw new Error('TRUSTED_PROXY_IPS must be a comma-separated list of IP addresses');
  const entries = trustedProxyIps === '' ? [] : trustedProxyIps.split(',').map(ip => ip.trim());
  const trusted = new Set(entries.map(ip => {
    const normalized = normalizeIP(ip);
    if (!normalized) throw new Error('TRUSTED_PROXY_IPS contains an invalid IP address');
    return normalized;
  }));
  function peer(req) { return normalizeIP(req.socket.remoteAddress); }
  function isTrusted(req) { return trusted.has(peer(req)); }
  function allowsInsecureHttp(req) {
    const address = peer(req);
    const local = address === '::1' || Boolean(address?.startsWith('127.'));
    const privateNetwork = address && (address.startsWith('10.') || address.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^(fc|fd)[0-9a-f]{2}:/.test(address));
    return Boolean((mode === 'local-development' && local) ||
      (mode === 'lan-development' && (local || privateNetwork || address?.startsWith('100.111.'))));
  }
  return {
    allowsInsecureHttp,
    requireProtectedTransport(req) {
      if (req.socket.encrypted === true ||
          allowsInsecureHttp(req) ||
          (isTrusted(req) && singleHeader(req, 'x-forwarded-proto') === 'https')) return;
      throw new ServiceError(403, 'HTTPS_REQUIRED', '登入及管理操作須透過 HTTPS');
    },
    sourceIP(req) {
      const forwarded = isTrusted(req) ? normalizeIP(singleHeader(req, 'x-real-ip')) : null;
      return forwarded ?? peer(req) ?? 'unknown';
    }
  };
}

export function createLoginRateLimiter({ now = Date.now, maxSources = 10000 } = {}) {
  if (!Number.isSafeInteger(maxSources) || maxSources < 1) throw new Error('maxSources must be a positive integer');
  const sources = new Map();
  const windowMs = 60000;
  return {
    check(source) {
      const time = now();
      // Lazy expiry on every attempt keeps memory bounded without a timer.
      for (const [key, entry] of sources) if (entry.expiresAt <= time) sources.delete(key);
      let entry = sources.get(source);
      // Fail closed at capacity: never evict a live source and reset its budget.
      if ((!entry && sources.size >= maxSources) || entry?.attempts >= 10) {
        throw new ServiceError(429, 'LOGIN_RATE_LIMITED', '登入嘗試過於頻繁，請稍後再試');
      }
      if (!entry) {
        entry = { attempts: 0, expiresAt: time + windowMs };
        sources.set(source, entry);
      }
      entry.attempts++;
    }
  };
}
