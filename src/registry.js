// The npm registry, read-only — the only thing hkb fetches that is not GitHub.
//
// One GET of the abbreviated packument (`dist-tags.latest`) over `node:https`: no dependency, no
// auth, no retry, no redirect, and a timeout so nothing ever waits on npm. Every failure is a
// rejection, and every caller swallows it — a machine that cannot reach the registry must behave
// exactly as it did before this file existed (offline is not a failure; see src/doctor.js).
//
// `setRegistryFetch(fn)` swaps the GET out the way `setTransport` does for `gh`. That is how the
// suite proves the once-a-day stamp, the offline path, and that `hkb list` never comes here.
import https from 'node:https';

export const REGISTRY = 'https://registry.npmjs.org';
export const PACKAGE = 'hkb-cli';
/** Long enough for a cold TLS handshake on a slow link, short enough that a hung registry is not felt. */
export const TIMEOUT_MS = 3000;
/** dist-tags sit at the top of the abbreviated packument; anything past this is a registry that changed shape. */
const MAX_BYTES = 2_000_000;
/** The abbreviated form: versions without their full metadata. Same `dist-tags`, a fraction of the bytes. */
const ACCEPT = 'application/vnd.npm.install-v1+json';

function httpsGetJson(url, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: ACCEPT, 'user-agent': PACKAGE }, timeout }, (res) => {
      // No redirect following on purpose: registry.npmjs.org answers 200, and a check nobody asked
      // for is not worth a hop chain. A 3xx reads as "no answer", like any other failure.
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`GET ${url} → HTTP ${res.statusCode}`)); return; }
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (c) => {
        body += c;
        if (body.length > MAX_BYTES) { req.destroy(new Error(`GET ${url} → over ${MAX_BYTES} bytes`)); }
      });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out after ${timeout}ms`)));
    req.on('error', reject);
  });
}

let fetchJson = httpsGetJson;

/** Swap the registry GET (tests). Returns the restore function, like `setTransport` in gh.js. */
export function setRegistryFetch(fn) {
  const previous = fetchJson;
  fetchJson = fn || httpsGetJson;
  return () => { fetchJson = previous; };
}

/**
 * The version npm would install as `hkb-cli@latest`.
 * @returns {Promise<string>} the dist-tag, or a rejection — which every caller treats as "no answer".
 */
export async function latestVersion({ pkg = PACKAGE, registry = REGISTRY, timeout = TIMEOUT_MS } = {}) {
  const url = `${registry}/${encodeURIComponent(pkg)}`;
  const body = await fetchJson(url, { timeout });
  const latest = body?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || !latest.trim()) throw new Error(`${url} answered without dist-tags.latest`);
  return latest.trim();
}
