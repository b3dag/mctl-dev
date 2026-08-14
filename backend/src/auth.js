import { config } from './config.js';

/**
 * There is no login here on purpose. Cloudflare Access authenticates upstream
 * and injects the caller's identity as request headers; we trust those.
 *
 * That trust only holds if nothing can reach this port except the tunnel, which
 * is why compose never publishes 8080 to the host.
 */
export function identityOf(req) {
  const email =
    req.headers['cf-access-authenticated-user-email'] ||
    req.headers['x-forwarded-email'] ||
    '';
  if (email) return String(email).toLowerCase();
  if (!config.requireCfAccess && config.devUser) return config.devUser.toLowerCase();
  return null;
}

export function requireAuth(req, res, next) {
  const user = identityOf(req);
  if (!user) {
    return res.status(401).json({
      error: 'unauthenticated',
      detail: 'No Cloudflare Access identity header on this request.',
    });
  }
  if (config.allowedEmails.length && !config.allowedEmails.includes(user)) {
    return res.status(403).json({ error: 'forbidden', detail: `${user} is not on the allowlist` });
  }
  req.user = user;
  next();
}

export function authorizeUpgrade(req) {
  const user = identityOf(req);
  if (!user) return null;
  if (config.allowedEmails.length && !config.allowedEmails.includes(user)) return null;
  return user;
}
