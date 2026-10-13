import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import { digest } from './security.ts';

export function trustedProxyAddresses(addresses: string[]) {
  for (const address of addresses) {
    const [ip, prefix, extra] = address.split('/');
    const family = isIP(ip);
    if (
      !family ||
      extra !== undefined ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) ||
          Number(prefix) > (family === 4 ? 32 : 128)))
    ) {
      throw new Error(
        'TRUSTED_PROXIES must contain explicit proxy IP addresses or CIDR ranges.',
      );
    }
  }
  return addresses;
}

function canonicalAddress(address: string) {
  if (isIP(address) !== 6) return address;
  const normalized = new URL(
    `http://[${address.split('%')[0]}]/`,
  ).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1], 16),
    low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function authenticationLimiter(): RequestHandler {
  const attempts = new Map<string, { count: number; until: number }>();
  let total = { count: 0, until: 0 };
  return (req, res, next) => {
    const time = Date.now();
    if (total.until <= time) total = { count: 0, until: time + 60_000 };
    for (const [key, value] of attempts)
      if (value.until <= time) attempts.delete(key);
    // Express resolves right-to-left, stopping at the first untrusted proxy.
    // Invalid forwarded addresses fall back to the actual peer, never a free-form key.
    const ip =
      req.ip && isIP(req.ip)
        ? req.ip
        : (req.socket.remoteAddress ?? 'unknown');
    const client = canonicalAddress(ip);
    const limits: [string, number][] = [[`client:${client}`, 20]];
    if (typeof req.body?.email === 'string') {
      const account = digest(req.body.email.trim().toLowerCase());
      // Pair with the client: attackers must not lock an account for other clients.
      limits.push([`account:${client}:${account}`, 10]);
    }
    const entries = limits.map(([key, limit]) => ({
      key,
      limit,
      entry: attempts.get(key) ?? { count: 0, until: time + 60_000 },
    }));
    // Separate overload ceiling also bounds the number of live map entries.
    if (
      total.count >= 2000 ||
      entries.some(({ entry, limit }) => entry.count >= limit)
    )
      return res.status(429).set('Retry-After', '60').json({
        code: 'rate_limited',
        message: 'Too many attempts. Try again in a minute.',
      });
    total.count++;
    for (const { key, entry } of entries) {
      entry.count++;
      attempts.set(key, entry);
    }
    next();
  };
}
