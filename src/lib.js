export const MAX_IPS_PER_DEVICE = 8;
export const EXISTING_IP_SYNC_INTERVAL_SECONDS = 300;

export const POLICY_SYNC_LOCK_KEY = "meta:policy_sync_lock";
export const POLICY_SYNC_DIRTY_KEY = "meta:policy_sync_dirty";
export const POLICY_SYNC_LOCK_TTL_SECONDS = 15;
export const POLICY_SYNC_DEBOUNCE_MS = 2500;
export const POLICY_SYNC_MAX_FLUSH_ROUNDS = 3;
export const POLICY_SYNC_LOCK_RETRY_MS = 200;

export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** @type {{ dirty: boolean, inFlight: Promise<void> | null }} */
export const syncCoalesce = { dirty: false, inFlight: null };


/**
 * Thin structured logger (one JSON object per line).
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
export function log(level, msg, fields = {}) {
  const line = JSON.stringify({
    level,
    msg,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}


/**
 * Resolve device list from DEVICE_KEYS_JSON, e.g.
 * [{"env":"KEY_DEVICE_1","name":"device1"},{"env":"KEY_LAPTOP","name":"laptop"}]
 * Also accepts {"secret":"...","name":"..."} entries.
 * Falls back to KEY_DEVICE_1 / KEY_DEVICE_2 when JSON absent or empty.
 */
export function getDeviceEntries(env) {
  const raw = env.DEVICE_KEYS_JSON;
  if (raw && String(raw).trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const devices = [];
        for (const entry of parsed) {
          if (!entry || typeof entry !== "object") continue;
          const name = typeof entry.name === "string" ? entry.name.trim() : "";
          if (!name) continue;
          if (typeof entry.env === "string" && entry.env) {
            const secret = env[entry.env];
            if (secret) devices.push({ key: secret, name });
          } else if (typeof entry.secret === "string" && entry.secret) {
            devices.push({ key: entry.secret, name });
          }
        }
        if (devices.length > 0) return devices;
      }
    } catch (e) {
      log("error", "invalid_DEVICE_KEYS_JSON", { error: String(e && e.message ? e.message : e) });
    }
  }
  return [
    { key: env.KEY_DEVICE_1, name: "device1" },
    { key: env.KEY_DEVICE_2, name: "device2" },
  ];
}

export function validateKey(key, env) {
  const devices = getDeviceEntries(env);
  const match = devices.find((d) => d.key && d.key === key);
  return match ? match.name : null;
}

/**
 * Key resolution order:
 * 1) X-Device-Key header
 * 2) Authorization: Bearer <key>
 * 3) POST body.key
 * 4) Query ?key= only for GET bookmark actions (sync/list/preview) — never for add/remove
 */
export function extractDeviceKey(request, url, body, action) {
  const headerKey = request.headers.get("X-Device-Key");
  if (headerKey && headerKey.trim()) return headerKey.trim();

  const auth = request.headers.get("Authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }

  if (body && typeof body.key === "string" && body.key.trim()) {
    return body.key.trim();
  }

  if (action === "add" || action === "remove") {
    return null;
  }

  if (request.method === "GET") {
    const q = url.searchParams.get("key");
    if (q && q.trim()) return q.trim();
  }
  return null;
}

export async function parseRequestBody(request) {
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const data = await request.json();
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    }
    if (
      ct.includes("application/x-www-form-urlencoded") ||
      ct.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      const obj = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") obj[k] = v;
      }
      return obj;
    }
    const text = await request.text();
    if (!text.trim()) return {};
    try {
      const data = JSON.parse(text);
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  } catch (e) {
    console.error("Failed to parse body:", e);
    return {};
  }
}

export async function checkRateLimit(device, clientIp, env) {
  const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
  const ipPart = String(clientIp).replace(/[^0-9a-fA-F.:]/g, "_");
  const kvKey = `ratelimit:${device}:${ipPart}:${bucket}`;
  const raw = await env.DEVICE_IPS.get(kvKey);
  const count = raw ? parseInt(raw, 10) : 0;
  if (!Number.isFinite(count) || count < 0) {
    await env.DEVICE_IPS.put(kvKey, "1", {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS + 5,
    });
    return true;
  }
  if (count >= RATE_LIMIT_MAX) {
    return false;
  }
  await env.DEVICE_IPS.put(kvKey, String(count + 1), {
    expirationTtl: RATE_LIMIT_WINDOW_SECONDS + 5,
  });
  return true;
}


export function getFixedEntries(env) {
  const fixedIps = env.FIXED_IPS || "";
  if (!fixedIps.trim()) return [];
  return fixedIps
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean)
    .map(normalizeAccessIp)
    .filter(Boolean)
    .map((ip) => ({ ip: { ip } }));
}

/** Mark that an Access Policy PUT is needed (in-memory coalesce per isolate). */
export function scheduleSync() {
  syncCoalesce.dirty = true;
}

export function enqueueFlush(ctx, env) {
  if (!syncCoalesce.dirty && !syncCoalesce.inFlight) return;
  const p = flushSync(env, null);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(p);
  }
  return p;
}

/**
 * Flush coalesced sync work once. Prefer awaiting from mutate handlers;
 * sync page uses waitUntil so HTML returns while debounce absorbs client adds.
 */
export async function flushSync(env, ctx) {
  if (syncCoalesce.inFlight) {
    syncCoalesce.dirty = true;
    await syncCoalesce.inFlight;
    if (syncCoalesce.dirty) return flushSync(env, ctx);
    return;
  }
  if (!syncCoalesce.dirty) return;

  syncCoalesce.dirty = false;
  const p = runSyncWithLock(env);
  syncCoalesce.inFlight = p;
  try {
    await p;
  } finally {
    if (syncCoalesce.inFlight === p) syncCoalesce.inFlight = null;
  }
  if (syncCoalesce.dirty) {
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(flushSync(env, null));
      return;
    }
    return flushSync(env, null);
  }
}

export async function runSyncWithLock(env) {
  await markPolicySyncDirty(env);

  const owner = await acquirePolicySyncLock(env);
  if (!owner) {
    log("warn", "policy_sync_lock_busy", {});
    return;
  }

  try {
    await sleep(POLICY_SYNC_DEBOUNCE_MS);

    for (let round = 0; round < POLICY_SYNC_MAX_FLUSH_ROUNDS; round++) {
      await clearPolicySyncDirty(env);
      await syncPolicyOnce(env);
      if (!(await isPolicySyncDirty(env))) break;
      await sleep(150);
    }
  } finally {
    await releasePolicySyncLock(env, owner);
  }

  if (await isPolicySyncDirty(env)) {
    await runSyncWithLock(env);
  }
}

export async function syncPolicyOnce(env) {
  const include = await buildPolicyInclude(env);
  const policy = await cfFetch(env, "GET", `/access/policies/${env.POLICY_ID}`);
  const result = policy.result;

  const nextPolicy = { ...result, include };
  delete nextPolicy.id;
  delete nextPolicy.created_at;
  delete nextPolicy.updated_at;

  await cfFetch(env, "PUT", `/access/policies/${env.POLICY_ID}`, nextPolicy);
}

export async function markPolicySyncDirty(env) {
  await env.DEVICE_IPS.put(POLICY_SYNC_DIRTY_KEY, String(Date.now()), {
    expirationTtl: 60,
  });
}

export async function clearPolicySyncDirty(env) {
  await env.DEVICE_IPS.delete(POLICY_SYNC_DIRTY_KEY);
}

export async function isPolicySyncDirty(env) {
  const v = await env.DEVICE_IPS.get(POLICY_SYNC_DIRTY_KEY);
  return v != null;
}

export async function acquirePolicySyncLock(env) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const owner = await tryAcquirePolicySyncLock(env);
    if (owner) return owner;
    await sleep(POLICY_SYNC_LOCK_RETRY_MS);
  }
  return null;
}

export async function tryAcquirePolicySyncLock(env) {
  const now = Date.now();
  const current = await env.DEVICE_IPS.get(POLICY_SYNC_LOCK_KEY, "json");
  if (current && typeof current.expiresAt === "number" && current.expiresAt > now) {
    return null;
  }

  const owner = crypto.randomUUID();
  const expiresAt = now + POLICY_SYNC_LOCK_TTL_SECONDS * 1000;
  await env.DEVICE_IPS.put(
    POLICY_SYNC_LOCK_KEY,
    JSON.stringify({ owner, expiresAt }),
    { expirationTtl: POLICY_SYNC_LOCK_TTL_SECONDS + 5 }
  );

  const verify = await env.DEVICE_IPS.get(POLICY_SYNC_LOCK_KEY, "json");
  if (verify && verify.owner === owner) return owner;
  return null;
}

export async function releasePolicySyncLock(env, owner) {
  const current = await env.DEVICE_IPS.get(POLICY_SYNC_LOCK_KEY, "json");
  if (current && current.owner === owner) {
    await env.DEVICE_IPS.delete(POLICY_SYNC_LOCK_KEY);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function buildPolicyInclude(env) {
  const include = [];
  const seen = new Set();

  for (const entry of getFixedEntries(env)) {
    addIncludeEntry(include, seen, entry.ip.ip);
  }

  const list = await env.DEVICE_IPS.list({ prefix: "device:" });
  for (const kvKey of list.keys) {
    const raw = await env.DEVICE_IPS.get(kvKey.name, "json");
    if (!Array.isArray(raw)) continue;

    for (const entry of raw) {
      const normalized = normalizeAccessIp(entry.ip);
      if (normalized) addIncludeEntry(include, seen, normalized);
    }
  }

  return include;
}

export function addIncludeEntry(include, seen, ip) {
  if (seen.has(ip)) return;
  seen.add(ip);
  include.push({ ip: { ip } });
}


/**
 * Keep at most `max` device IP entries, preferring newest by `ts`.
 * Does not mutate the input array.
 * @param {Array<{ip?: string, ts?: number}>} entries
 * @param {number} [max]
 */
export function trimDeviceEntries(entries, max = MAX_IPS_PER_DEVICE) {
  if (!Array.isArray(entries)) return [];
  if (entries.length <= max) return entries.slice();
  return entries
    .slice()
    .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
    .slice(0, max);
}

export function normalizeAccessIp(value) {
  if (typeof value !== "string") return null;
  const ip = value.trim();
  if (!ip) return null;

  if (ip.includes("/")) {
    const [addr, prefix, extra] = ip.split("/");
    if (extra || !prefix) return null;
    if (isIPv4(addr)) {
      const n = Number(prefix);
      return Number.isInteger(n) && n >= 0 && n <= 32 ? `${addr}/${n}` : null;
    }
    if (isIPv6(addr)) {
      const n = Number(prefix);
      return Number.isInteger(n) && n >= 0 && n <= 128 ? `${addr}/${n}` : null;
    }
    return null;
  }

  if (isIPv4(ip)) return ip + "/32";
  if (isIPv6(ip)) return ip + "/128";
  return null;
}

export function isIPv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function isHexGroup(group) {
  return /^[0-9a-fA-F]{1,4}$/.test(group);
}

export function isIPv6(value) {
  if (typeof value !== "string") return false;
  if (!value.includes(":")) return false;
  if (/[^0-9a-fA-F:.]/.test(value)) return false;
  if (value.includes(":::")) return false;

  const doubleColons = value.match(/::/g);
  if (doubleColons && doubleColons.length > 1) return false;

  let head = value;
  let v4Hextets = 0;

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon < 0) return false;
    const candidate = value.slice(lastColon + 1);
    if (!candidate.includes(".")) return false;
    if (!isIPv4(candidate)) return false;
    v4Hextets = 2;
    if (lastColon > 0 && value[lastColon - 1] === ":") {
      head = value.slice(0, lastColon + 1);
    } else {
      head = value.slice(0, lastColon);
    }
  }

  if (value.includes("::")) {
    const parts = head.split("::");
    if (parts.length !== 2) return false;
    const left = parts[0] === "" ? [] : parts[0].split(":");
    const right = parts[1] === "" ? [] : parts[1].split(":");
    if (left.some((g) => g === "") || right.some((g) => g === "")) return false;
    if (![...left, ...right].every(isHexGroup)) return false;
    const present = left.length + right.length + v4Hextets;
    return present < 8;
  }

  const groups = head === "" ? [] : head.split(":");
  if (groups.some((g) => g === "")) return false;
  if (!groups.every(isHexGroup)) return false;
  return groups.length + v4Hextets === 8;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeJsString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

export async function cfFetch(env, method, path, body) {
  const opts = {
    method,
    headers: {
      Authorization: "Bearer " + env.CF_API_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}${path}`,
    opts
  );
  const data = await resp.json();
  if (!data.success) {
    log("error", "cf_api_error", { errors: data.errors });
    throw new Error("Cloudflare API request failed");
  }
  return data;
}

export function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

export function jsonResponse(data, status = 200, request = null) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json; charset=utf-8" },
  });
}

export function htmlPage(title, body, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui;background:#1a1a2e;color:#eee;padding:20px}h2{color:#0ff}.item{display:flex;gap:8px;padding:10px;margin:6px 0;background:#16213e;border-radius:8px}.badge{padding:2px 8px;border-radius:4px;font-size:12px}.badge.added{background:#0a3;color:#fff}.badge.ok{background:#555}.badge.err{background:#a00;color:#fff}.done{margin-top:16px;padding:12px;background:#0a3;border-radius:8px;text-align:center;font-weight:bold}ul{list-style:none;padding:0}li{padding:8px;margin:4px 0;background:#16213e;border-radius:6px;font-family:monospace}li small{color:#888}</style>
</head>
<body>
${body}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Reflect request Origin only when it matches this Worker URL origin.
 * Omit Access-Control-Allow-Origin for same-origin / non-browser (no Origin).
 * Never use *.
 */
export function corsHeaders(request) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Device-Key, Authorization",
  };
  if (!request) return headers;
  const origin = request.headers.get("Origin");
  if (!origin) return headers;
  try {
    const workerOrigin = new URL(request.url).origin;
    if (origin === workerOrigin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
    }
  } catch (_) {
  }
  return headers;
}
