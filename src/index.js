import {
  validateKey,
  extractDeviceKey,
  parseRequestBody,
  checkRateLimit,
  scheduleSync,
  flushSync,
  enqueueFlush,
  normalizeAccessIp,
  trimDeviceEntries,
  escapeHtml,
  escapeJsString,
  timeAgo,
  jsonResponse,
  htmlPage,
  corsHeaders,
  buildPolicyInclude,
  log,
  MAX_IPS_PER_DEVICE,
  EXISTING_IP_SYNC_INTERVAL_SECONDS,
  RATE_LIMIT_WINDOW_SECONDS,
} from "./lib.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const action = url.searchParams.get("action") || "sync";

    if ((action === "add" || action === "remove") && request.method !== "POST") {
      return jsonResponse(
        {
          success: false,
          error: "Method Not Allowed",
          hint: "Use POST with header X-Device-Key (or Authorization: Bearer) and JSON/form body { ip }. Optional body.key if header omitted. Query key/ip are not accepted for add/remove.",
        },
        405,
        request
      );
    }

    if (request.method !== "GET" && request.method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405, request);
    }

    let body = null;
    if (request.method === "POST") {
      body = await parseRequestBody(request);
    }

    const key = extractDeviceKey(request, url, body, action);
    if (!key) {
      if (action === "sync") {
        return htmlPage("Error", "<p>Missing key parameter</p>", 403);
      }
      return jsonResponse({ success: false, error: "Missing key" }, 403, request);
    }

    const device = validateKey(key, env);
    if (!device) {
      if (action === "sync") {
        return htmlPage("Error", "<p>Invalid key</p>", 403);
      }
      return jsonResponse({ success: false, error: "Invalid key" }, 403, request);
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
    const allowed = await checkRateLimit(device, clientIp, env);
    if (!allowed) {
      log("warn", "rate_limit_exceeded", { device, clientIp });
      return jsonResponse(
        { success: false, error: "Rate limit exceeded", retryAfter: RATE_LIMIT_WINDOW_SECONDS },
        429,
        request
      );
    }

    try {
      if (action === "sync") {
        if (request.method !== "GET") {
          return jsonResponse({ success: false, error: "sync requires GET" }, 405, request);
        }
        return await handleSync(request, device, key, env, ctx);
      } else if (action === "add") {
        const ip = body && body.ip;
        if (!ip) return jsonResponse({ success: false, error: "Missing ip" }, 400, request);
        return await handleAdd(device, ip, env, ctx, request);
      } else if (action === "list") {
        return await handleList(device, env, request);
      } else if (action === "remove") {
        const ip = body && body.ip;
        if (!ip) return jsonResponse({ success: false, error: "Missing ip" }, 400, request);
        return await handleRemove(device, ip, env, ctx, request);
      } else if (action === "preview") {
        return await handlePreview(device, env, request);
      } else {
        return htmlPage("Error", "<p>Unknown action</p>", 400);
      }
    } catch (e) {
      log("error", "worker_error", { error: String(e && e.message ? e.message : e) });
      return htmlPage("Error", "<p>An unexpected error occurred</p>", 500);
    }
  },
};

async function handleSync(request, device, key, env, ctx) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  let cfResult = null;

  if (cfIp) {
    const normalizedCfIp = normalizeAccessIp(cfIp);
    if (normalizedCfIp) {
      cfResult = await addIpToDevice(device, normalizedCfIp, env);
    } else {
      log("error", "invalid_cf_connecting_ip", { cfIp });
    }
  }

  enqueueFlush(ctx, env);

  const baseUrl = new URL(request.url).origin;
  const safeCfIpDisplay = escapeHtml(cfIp || "unknown");
  const safeBaseUrl = escapeJsString(baseUrl);
  const safeKey = escapeJsString(key);
  const safeCfIpJs = escapeJsString(cfIp || "");
  const cfChanged = cfResult?.changed ? "true" : "false";

  let cfBadgeClass = "ok";
  let cfBadgeText = "Exists";
  if (!cfIp) {
    cfBadgeClass = "err";
    cfBadgeText = "Missing";
  } else if (!cfResult) {
    cfBadgeClass = "err";
    cfBadgeText = "Invalid";
  } else if (cfResult.changed) {
    cfBadgeClass = "added";
    cfBadgeText = "Added";
  }

  const body = `
    <div id="status">
      <h2>Updating whitelist...</h2>
      <div id="cf-ip" class="item">
        <span class="label">Connection IP:</span>
        <span class="value">${safeCfIpDisplay}</span>
        <span class="badge ${cfBadgeClass}">${cfBadgeText}</span>
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

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

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
          const r = await fetch(BASE + "/?action=add", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Device-Key": KEY,
            },
            body: JSON.stringify({ ip: ip }),
          });
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
          const lr = await fetch(BASE + "/?action=list", {
            headers: { "X-Device-Key": KEY },
          });
          const ld = await lr.json();
          if (ld.success) {
            let html = '<h3>Current whitelist (' + ld.count + '/' + ld.max + ')</h3><ul>';
            for (const e of ld.entries) {
              html += '<li>' + escapeHtml(e.ip) + ' <small>' + escapeHtml(e.ago) + '</small></li>';
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

async function handleAdd(device, ip, env, ctx, request) {
  const normalized = normalizeAccessIp(ip);
  if (!normalized) {
    return jsonResponse({ success: false, error: "Invalid IP address" }, 400, request);
  }
  const result = await addIpToDevice(device, normalized, env);
  await flushSync(env, ctx);
  return jsonResponse(result, 200, request);
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
    if (shouldSync) scheduleSync();
    return { success: true, changed: false, ip: normalized, device, entries: entries.length, synced: shouldSync };
  }

  entries.push({ ip: normalized, ts: Math.floor(Date.now() / 1000) });
  entries = trimDeviceEntries(entries, MAX_IPS_PER_DEVICE);

  await env.DEVICE_IPS.put(kvKey, JSON.stringify(entries));
  scheduleSync();

  return { success: true, changed: true, ip: normalized, device, entries: entries.length, max: MAX_IPS_PER_DEVICE };
}

async function handleList(device, env, request) {
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
  }, 200, request);
}

async function handleRemove(device, ip, env, ctx, request) {
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
    return jsonResponse({ success: false, error: "IP not found for " + device }, 404, request);
  }

  await env.DEVICE_IPS.put(kvKey, JSON.stringify(entries));
  scheduleSync();
  await flushSync(env, ctx);

  return jsonResponse({
    success: true,
    action: "removed",
    ip: normalized || ip,
    device,
    remaining: entries.length,
  }, 200, request);
}

async function handlePreview(device, env, request) {
  const include = await buildPolicyInclude(env);
  return jsonResponse({
    success: true,
    device,
    policyId: env.POLICY_ID,
    include,
    count: include.length,
  }, 200, request);
}
