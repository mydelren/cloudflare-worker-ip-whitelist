// Cloudflare Worker: Access Policy IP Whitelist Auto-Updater
// https://github.com/mydelren/cloudflare-worker-ip-whitelist

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const key = url.searchParams.get("key");
    const action = url.searchParams.get("action") || "sync";

    if (!key) {
      return htmlPage("Error", "<p>Missing key parameter</p>", 403);
    }

    const device = validateKey(key, env);
    if (!device) {
      return htmlPage("Error", "<p>Invalid key</p>", 403);
    }

    try {
      if (action === "sync") {
        return await handleSync(request, device, key, env);
      } else if (action === "add") {
        const ip = url.searchParams.get("ip");
        if (!ip) return jsonResponse({ success: false, error: "Missing ip parameter" }, 400);
        return await handleAdd(device, ip, env);
      } else if (action === "list") {
        return await handleList(device, env);
      } else if (action === "remove") {
        const ip = url.searchParams.get("ip");
        if (!ip) return jsonResponse({ success: false, error: "Missing ip parameter" }, 400);
        return await handleRemove(device, ip, env);
      } else if (action === "preview") {
        return await handlePreview(device, env);
      } else {
        return htmlPage("Error", "<p>Unknown action</p>", 400);
      }
    } catch (e) {
      console.error("Worker error:", e);
      return htmlPage("Error", "<p>An unexpected error occurred</p>", 500);
    }
  },
};

const MAX_IPS_PER_DEVICE = 8;
const DEVICE_KEYS_MAP_KEY = "meta:device_keys";
const EXISTING_IP_SYNC_INTERVAL_SECONDS = 300;

// ==================== Device Key Validation ====================

// Configure your devices here. Each entry maps a secret env var to a device name.
// Set secrets with: wrangler secret put KEY_<NAME>
function validateKey(key, env) {
  const devices = [
    { key: env.KEY_DEVICE_1, name: "device1" },
    { key: env.KEY_DEVICE_2, name: "device2" },
    // Add more devices as needed:
    // { key: env.KEY_LAPTOP, name: "laptop" },
  ];
  const match = devices.find((d) => d.key && d.key === key);
  return match ? match.name : null;
}

// ==================== Sync (HTML page) ====================

async function handleSync(request, device, key, env) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  let cfResult = null;

  if (cfIp) {
    const normalizedCfIp = normalizeAccessIp(cfIp);
    if (normalizedCfIp) {
      cfResult = await addIpToDevice(device, normalizedCfIp, env);
    } else {
      console.error("Skipping invalid CF-Connecting-IP:", cfIp);
    }
  }

  const baseUrl = new URL(request.url).origin;
  const safeCfIpDisplay = escapeHtml(cfIp || "unknown");
  const safeBaseUrl = escapeJsString(baseUrl);
  const safeKey = escapeJsString(key);
  const safeCfIpJs = escapeJsString(cfIp || "");
  const cfChanged = cfResult?.changed ? "true" : "false";

  const body = `
    <div id="status">
      <h2>Updating whitelist...</h2>
      <div id="cf-ip" class="item">
        <span class="label">Connection IP:</span>
        <span class="value">${safeCfIpDisplay}</span>
        <span class="badge ${cfResult?.changed ? "added" : "ok"}">${cfResult?.changed ? "Added" : "Exists"}</span>
      </div>
      <div id="ipv4" class="item">
        <span class="label">IPv4:</span>
        <span class="value" id="v4">Detecting...</span>
        <span class="badge" id="v4badge"></span>
      </div>
      <div id="ipv6" class="item">
        <span class="label">IPv6:</span>
        <span class="value" id="v6">Detecting...</span>
        <span class="badge" id="v6badge"></span>
      </div>
    </div>
    <div id="summary"></div>
    <div id="entries"></div>
    <script>
      const BASE = "${safeBaseUrl}";
      const KEY = "${safeKey}";
      const CF_IP = "${safeCfIpJs}";

      async function probe(url, timeout) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
          const r = await fetch(url, { signal: ctrl.signal });
          clearTimeout(t);
          return (await r.text()).trim();
        } catch(e) {
          clearTimeout(t);
          return null;
        }
      }

      async function addIp(ip) {
        if (!ip || ip === CF_IP) return { changed: false, skip: true };
        try {
          const r = await fetch(BASE + "/?key=" + KEY + "&action=add&ip=" + encodeURIComponent(ip));
          return await r.json();
        } catch(e) {
          return { error: e.message };
        }
      }

      function setBadge(id, result) {
        const el = document.getElementById(id);
        if (!el) return;
        if (result.skip) { el.textContent = "Same as connection IP"; el.className = "badge ok"; }
        else if (result.error) { el.textContent = "Failed"; el.className = "badge err"; }
        else if (result.changed) { el.textContent = "Added"; el.className = "badge added"; }
        else { el.textContent = "Exists"; el.className = "badge ok"; }
      }

      async function run() {
        const [v4, v6] = await Promise.all([
          probe("https://api.ipify.org", 5000),
          probe("https://api64.ipify.org", 5000)
        ]);

        document.getElementById("v4").textContent = v4 || "Unavailable";
        document.getElementById("v6").textContent = v6 || "Unavailable";

        let r4 = { skip: true }, r6 = { skip: true };

        if (v4 && v4 !== CF_IP) {
          r4 = await addIp(v4);
        }
        if (v6 && v6.includes(":") && v6 !== CF_IP) {
          r6 = await addIp(v6);
        }

        setBadge("v4badge", v4 ? (v4 === CF_IP ? { skip: true } : r4) : { error: "N/A" });
        setBadge("v6badge", v6 && v6.includes(":") ? (v6 === CF_IP ? { skip: true } : r6) : { error: "N/A" });

        const added = [cfIpAdded(), r4.changed, r6.changed].filter(Boolean).length;
        document.getElementById("summary").innerHTML =
          '<p class="done">Done! ' + (added > 0 ? added + ' IP(s) added' : 'No new IPs') + '</p>';

        try {
          const lr = await fetch(BASE + "/?key=" + KEY + "&action=list");
          const ld = await lr.json();
          if (ld.success) {
            let html = '<h3>Current whitelist (' + ld.count + '/' + ld.max + ')</h3><ul>';
            for (const e of ld.entries) {
              html += '<li>' + e.ip + ' <small>' + e.ago + '</small></li>';
            }
            html += '</ul>';
            document.getElementById("entries").innerHTML = html;
          }
        } catch(e) {}
      }

      function cfIpAdded() { return ${cfChanged}; }

      run();
    </script>`;

  return htmlPage("IP Whitelist - " + device, body);
}

// ==================== Add / List / Remove ====================

async function handleAdd(device, ip, env) {
  const normalized = normalizeAccessIp(ip);
  if (!normalized) {
    return jsonResponse({ success: false, error: "Invalid IP address" }, 400);
  }
  const result = await addIpToDevice(device, normalized, env);
  return jsonResponse(result);
}

async function addIpToDevice(device, ip, env) {
  const normalized = normalizeAccessIp(ip);
  if (!normalized) {
    return { success: false, error: "Invalid IP address" };
  }

  const kvKey = "device:" + device;
  const raw = await env.DEVICE_IPS.get(kvKey, "json");
  let entries = Array.isArray(raw) ? raw : [];

  const existing = entries.find(
    (e) => e.ip === normalized || normalizeAccessIp(e.ip) === normalized
  );
  if (existing) {
    const now = Math.floor(Date.now() / 1000);
    const shouldSync = now - existing.ts >= EXISTING_IP_SYNC_INTERVAL_SECONDS;
    existing.ts = now;
    existing.ip = normalized;
    await env.DEVICE_IPS.put(kvKey, JSON.stringify(entries));
    if (shouldSync) await syncPolicy(env);
    return { success: true, changed: false, ip: normalized, device, entries: entries.length, synced: shouldSync };
  }

  entries.push({ ip: normalized, ts: Math.floor(Date.now() / 1000) });

  if (entries.length > MAX_IPS_PER_DEVICE) {
    entries.sort((a, b) => b.ts - a.ts);
    entries = entries.slice(0, MAX_IPS_PER_DEVICE);
  }

  await env.DEVICE_IPS.put(kvKey, JSON.stringify(entries));
  await registerDevice(device, env);
  await syncPolicy(env);

  return { success: true, changed: true, ip: normalized, device, entries: entries.length, max: MAX_IPS_PER_DEVICE };
}

async function handleList(device, env) {
  const kvKey = "device:" + device;
  const raw = await env.DEVICE_IPS.get(kvKey, "json");
  const entries = Array.isArray(raw) ? raw : [];

  return jsonResponse({
    success: true,
    device,
    entries: entries.sort((a, b) => b.ts - a.ts).map((e) => ({
      ip: e.ip,
      lastSeen: new Date(e.ts * 1000).toISOString(),
      ago: timeAgo(e.ts),
    })),
    count: entries.length,
    max: MAX_IPS_PER_DEVICE,
  });
}

async function handleRemove(device, ip, env) {
  const normalized = normalizeAccessIp(ip);
  const kvKey = "device:" + device;
  const raw = await env.DEVICE_IPS.get(kvKey, "json");
  let entries = Array.isArray(raw) ? raw : [];
  const before = entries.length;
  entries = entries.filter((e) => {
    if (e.ip === ip) return false;
    if (normalized && (e.ip === normalized || normalizeAccessIp(e.ip) === normalized)) return false;
    return true;
  });

  if (entries.length === before) {
    return jsonResponse({ success: false, error: "IP not found for " + device }, 404);
  }

  await env.DEVICE_IPS.put(kvKey, JSON.stringify(entries));
  await syncPolicy(env);

  return jsonResponse({
    success: true,
    action: "removed",
    ip: normalized || ip,
    device,
    remaining: entries.length,
  });
}

async function handlePreview(device, env) {
  const include = await buildPolicyInclude(env);
  return jsonResponse({
    success: true,
    device,
    policyId: env.POLICY_ID,
    include,
    count: include.length,
  });
}

// ==================== Policy Sync ====================

// Fixed IP ranges that are always included in the whitelist.
// Set via environment variable: wrangler secret put FIXED_IPS
// Format: comma-separated CIDRs, e.g. "203.0.113.0/24,198.51.100.0/24"
// Leave empty (default) if you have no fixed IPs.
function getFixedEntries(env) {
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

async function syncPolicy(env) {
  const include = await buildPolicyInclude(env);
  const policy = await cfFetch(env, "GET", `/access/policies/${env.POLICY_ID}`);
  const result = policy.result;

  const nextPolicy = { ...result, include };
  delete nextPolicy.id;
  delete nextPolicy.created_at;
  delete nextPolicy.updated_at;

  await cfFetch(env, "PUT", `/access/policies/${env.POLICY_ID}`, nextPolicy);
}

async function buildPolicyInclude(env) {
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

// ==================== Utilities ====================

function addIncludeEntry(include, seen, ip) {
  if (seen.has(ip)) return;
  seen.add(ip);
  include.push({ ip: { ip } });
}

function normalizeAccessIp(value) {
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

function isIPv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

function isHexGroup(group) {
  return /^[0-9a-fA-F]{1,4}$/.test(group);
}

function isIPv6(value) {
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
    head = value.slice(0, lastColon);
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsString(value) {
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

async function registerDevice(device, env) {
  const raw = await env.DEVICE_IPS.get(DEVICE_KEYS_MAP_KEY, "json");
  const keys = Array.isArray(raw) ? raw : [];
  if (!keys.includes(device)) {
    keys.push(device);
    await env.DEVICE_IPS.put(DEVICE_KEYS_MAP_KEY, JSON.stringify(keys));
  }
}

async function cfFetch(env, method, path, body) {
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
    console.error("CF API error:", data.errors);
    throw new Error("Cloudflare API request failed");
  }
  return data;
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8" },
  });
}

function htmlPage(title, body, status = 200) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,sans-serif;background:#1a1a2e;color:#eee;padding:20px;min-height:100vh}
h2{color:#0ff;margin-bottom:16px;font-size:18px}
h3{color:#aaa;margin:20px 0 10px;font-size:14px}
.item{display:flex;align-items:center;gap:8px;padding:10px;margin:6px 0;background:#16213e;border-radius:8px;font-size:14px}
.label{color:#888;min-width:60px}
.value{flex:1;word-break:break-all;font-family:monospace;font-size:13px}
.badge{padding:2px 8px;border-radius:4px;font-size:12px;white-space:nowrap}
.badge.added{background:#0a3;color:#fff}
.badge.ok{background:#555;color:#ccc}
.badge.err{background:#a00;color:#fff}
.done{margin-top:16px;padding:12px;background:#0a3;border-radius:8px;text-align:center;font-weight:bold}
ul{list-style:none;padding:0}
li{padding:8px 10px;margin:4px 0;background:#16213e;border-radius:6px;font-family:monospace;font-size:13px}
li small{color:#888;margin-left:8px}
</style>
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

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}
