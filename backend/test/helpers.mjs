/**
 * These tests run against a real stack: real containers, a real Minecraft
 * server, a real restic repository. Nothing here is mocked, because almost
 * every bug this project has had lived in the space between mctl and Docker or
 * the itzg image, which a mock would have reproduced incorrectly.
 *
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
 *   node backend/test/run.mjs
 */

const BASE = process.env.MCTL_API || 'http://127.0.0.1:8080';
const IDENTITY = process.env.MCTL_TEST_USER || 'test@example.com';

export const results = { passed: 0, failed: [] };

export function ok(condition, label, extra = '') {
  if (condition) results.passed++;
  else results.failed.push(label);
  const mark = condition ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${label}${extra ? `  ${extra}` : ''}`);
}

export function section(title) {
  console.log(`\n  ${title}`);
}

export function heading(title) {
  console.log(`\n=== ${title} ===`);
}

export async function api(method, path, body, { timeoutMs = 180000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'cf-access-authenticated-user-email': IDENTITY,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until the predicate holds, or give up after `seconds`. */
export async function waitFor(predicate, seconds = 120, intervalMs = 2000) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

export async function phaseOf(id) {
  const { body } = await api('GET', `/api/servers/${id}`);
  return body?.server?.state?.phase;
}

export async function waitReady(id, seconds = 300) {
  return waitFor(async () => (await phaseOf(id)) === 'ready', seconds, 3000);
}

/** The server a test operates on, by slug. Fails loudly rather than silently. */
export async function server(slug) {
  const { body } = await api('GET', '/api/servers');
  const found = (body?.servers || []).find((s) => s.slug === slug);
  if (!found) {
    throw new Error(`these tests expect a server with slug "${slug}"; create one first`);
  }
  return found;
}
