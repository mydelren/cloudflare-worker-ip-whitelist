# Cloudflare Worker IP Whitelist

[中文文档](README_CN.md)

Auto-update [Cloudflare Access Policy](https://developers.cloudflare.com/cloudflare-one/policies/access/) IP whitelists from a private link on any device. Zero server required — runs entirely on Cloudflare's free tier.

## Why?

Cloudflare Access is great for securing self-hosted services, but IP whitelisting becomes annoying when your phone's IP changes constantly (Wi-Fi ↔ cellular, roaming). This Worker lets you update your Access Policy with one click from a private bookmark or direct link.

**Use case**: You have a Cloudflare Tunnel exposing your homelab services and use Access Policy IP whitelisting as your first line of defense.

## How It Works

```
Phone → GET https://your-worker.dev/?key=xxx
              ↓
Worker reads CF-Connecting-IP (your real IP)
              ↓
Client-side JS detects IPv4 + IPv6 via ipify
              ↓
Worker stores IPs in KV (max 8 per device, auto-evicts oldest)
              ↓
Worker rebuilds Access Policy include array → PUT CF API
              ↓
IPs whitelisted at Cloudflare edge in ~1 second
```

## Features

- **Dual-stack**: Automatically detects and records both IPv4 and IPv6
- **Multi-device**: Each device gets its own IP list (configurable max per device)
- **One-click**: Bookmark the URL, tap when IP changes
- **Auto-cleanup**: Oldest IPs evicted when limit reached, no stale entries
- **Zero dependencies**: Pure Cloudflare Worker + KV, no external services

## Quick Start

### Prerequisites

- Cloudflare account (free tier works)
- A Cloudflare Access Policy already created (see [CF docs](https://developers.cloudflare.com/cloudflare-one/policies/access/) if you need to create one)

---

### Option A: Deploy via Dashboard (recommended — no CLI needed)

All steps are done in the browser. No need to install Node.js or wrangler.

#### 1. Create a Worker

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. Click **Create application**
3. Choose **Create Worker**
4. Give it a name (e.g. `cf-ip-whitelist`)
5. Replace the default code with the contents of [`src/index.js`](src/index.js)
6. Click **Deploy**

#### 2. Create a KV Namespace

1. In the Dashboard, go to **Workers & Pages** → **KV**
2. Click **Create a namespace**
3. Name it `DEVICE_IPS`
4. Save

#### 3. Bind KV to Your Worker

1. Go back to your Worker → **Settings** → **Variables**
2. Under **KV namespace bindings**, click **Add binding**
3. Set:
   - Variable name: `DEVICE_IPS`
   - KV namespace: select the `DEVICE_IPS` namespace you just created
4. Click **Deploy** to save

#### 4. Set Environment Variables

Still in your Worker → **Settings** → **Variables** → **Environment variables**, add these:

| Variable | Value | Example |
|---|---|---|
| `CF_API_TOKEN` | Your Cloudflare API token | `cfut_...` |
| `ACCOUNT_ID` | Your Cloudflare account ID | `d20a6...` |
| `POLICY_ID` | The Access Policy ID to update | `5800b1...` |
| `KEY_DEVICE_1` | Random secret for device 1 | `bd6ec9...` |
| `KEY_DEVICE_2` | Random secret for device 2 | `8291e7...` |
| `DEVICE_KEYS_JSON` | *(Optional)* Device map JSON — add devices without code change | See [More Devices](#more-devices) |
| `FIXED_IPS` | *(Optional)* Fixed CIDRs | `203.0.113.0/24` |

Generate device keys with any random string (e.g. from [uuidgenerator.net](https://www.uuidgenerator.net/)).

With `DEVICE_KEYS_JSON` set, device secrets are read from the env vars named in the JSON (recommended). Without it, the Worker falls back to `KEY_DEVICE_1` / `KEY_DEVICE_2`.

Click **Deploy** after adding all variables.

#### 5. Add a Custom Domain

`workers.dev` is blocked in some regions. Add your own domain:

1. Worker → **Settings** → **Triggers** → **Custom Domains**
2. Click **Add Custom Domain**
3. Enter a subdomain you control (e.g. `wl.example.com`)
4. Save

#### 6. Set Up Access Bypass for the Worker

Your Access Policy might block the Worker itself. Create a Bypass policy for the Worker's hostname:

```
Cloudflare Zero Trust → Access → Applications → Add
  - Domain: your-worker.example.com
  - Policy: Bypass ( Everyone )
```

#### 7. Test

Open this URL on your phone:

```
https://your-worker.example.com/?key=YOUR_DEVICE_KEY&action=sync
```

You should see a page showing your IP and a confirmation that it was added.

---

### Important: Treat the Link Like a Secret

The `key` in the URL is a bearer-style secret. Keep the bookmark private and do not paste it into chat, public notes, shared documents, browser sync on shared machines, or screenshots.

### Important: Use a Dedicated Access Policy

This Worker updates one simple reusable Access Policy. Create a dedicated policy for it and do not point it at a complex policy with extra approval, MFA, or connection rules.

---

### Option B: Deploy with wrangler (for developers)

If you prefer the CLI or need to manage the project in Git:

```bash
# 1. Install wrangler
npm install -g wrangler

# 2. Log in
wrangler login

# 3. Create KV namespace
wrangler kv namespace create DEVICE_IPS
# Copy the returned id into wrangler.toml

# 4. Edit wrangler.toml with your account_id and kv_namespace id

# 5. Set secrets
wrangler secret put CF_API_TOKEN
wrangler secret put ACCOUNT_ID
wrangler secret put POLICY_ID
wrangler secret put KEY_DEVICE_1
wrangler secret put KEY_DEVICE_2
# Optional:
# wrangler secret put FIXED_IPS
# Plain env (not secret) for device map — see More Devices:
# DEVICE_KEYS_JSON='[{"env":"KEY_DEVICE_1","name":"device1"},{"env":"KEY_DEVICE_2","name":"device2"}]'

# 6. Deploy
wrangler deploy
```

## API

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/?action=sync` | `GET` | Query `key` (bookmark UX) or `X-Device-Key` / `Authorization: Bearer` | Records connection IP + HTML page that auto-detects dual-stack |
| `/?action=add` | `POST` only | Header preferred (`X-Device-Key` or Bearer); body `key` ok. **No query key/ip** | Adds a specific IP. Body: `{ "ip": "..." }` (JSON or form) |
| `/?action=list` | `GET` | Header preferred; query `key` still accepted for simple curls | Lists whitelisted IPs for the device (JSON) |
| `/?action=remove` | `POST` only | Same as add | Removes an IP. Body: `{ "ip": "..." }` |
| `/?action=preview` | `GET` | Header preferred; query `key` still accepted | Previews Access Policy `include` list (JSON) |

**Mutations (`add` / `remove`)**: GET returns `405` with a hint to use POST. Do not put secrets in query strings for mutations.

**Auth priority**: `X-Device-Key` → `Authorization: Bearer <key>` → POST body `key` → (GET only) query `key`.

**CORS**: Reflects `Origin` only when it matches this Worker URL origin (never `*`). Allows `GET`, `POST`, `OPTIONS`.

**Rate limit**: After a valid key, ~30 requests / 60s per device key + client IP (KV-backed). Exceeded → `429` JSON.

### Examples

```bash
# Sync (bookmark / browser)
open "https://your-worker.example.com/?key=YOUR_DEVICE_KEY&action=sync"

# Add IP (POST + header)
curl -X POST "https://your-worker.example.com/?action=add" \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: YOUR_DEVICE_KEY" \
  -d '{"ip":"203.0.113.10"}'

# Add IP (POST + body key)
curl -X POST "https://your-worker.example.com/?action=add" \
  -H "Content-Type: application/json" \
  -d '{"key":"YOUR_DEVICE_KEY","ip":"203.0.113.10"}'

# List (header)
curl "https://your-worker.example.com/?action=list" \
  -H "X-Device-Key: YOUR_DEVICE_KEY"

# Remove
curl -X POST "https://your-worker.example.com/?action=remove" \
  -H "Content-Type: application/json" \
  -H "X-Device-Key: YOUR_DEVICE_KEY" \
  -d '{"ip":"203.0.113.10"}'
```

## Phone Setup

The main workflow is still the bookmark/direct-link above. The optional automation below only helps when you want a more hands-off trigger.

### iOS (Shortcuts + Scriptable)

1. Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) (free)
2. Create a new Script, paste the sync script (see below)
3. Create Shortcuts Automations if you want auto-run:
   - **Wi-Fi is Connected** → Run Scriptable
   - **Wi-Fi is Disconnected** → Run Scriptable

You can also skip automation entirely and just keep the link in a private bookmark.

**Sync Script** (for Scriptable):

```javascript
// Config
const WORKER_URL = "https://your-worker.example.com";
const DEVICE_KEY = "YOUR_DEVICE_KEY";

// Detect manual vs automated
const isManual = !args.shortcutParameter;

async function callWorker(action, bodyObj) {
  // Mutations (add/remove) must be POST; key via header (not query)
  const url = WORKER_URL + "/?action=" + action;
  try {
    const r = new Request(url);
    r.method = "POST";
    r.headers = {
      "Content-Type": "application/json",
      "X-Device-Key": DEVICE_KEY,
    };
    r.body = JSON.stringify(bodyObj || {});
    const text = await r.loadString();
    return JSON.parse(text);
  } catch(e) { return { error: e.message }; }
}

async function httpGet(url) {
  try {
    const r = new Request(url);
    return (await r.loadString()).trim();
  } catch(e) { return null; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

if (isManual) {
  // Manual: open in WebView (sync page auto-detects dual-stack)
  const wv = new WebView();
  await wv.loadURL(WORKER_URL + "/?key=" + DEVICE_KEY + "&action=sync");
  await wv.present();
} else {
  // Automated: wait for network, then update
  await delay(5000);

  // Probe IPv4/IPv6 via ipify
  const [v4, v6] = await Promise.all([
    httpGet("https://api.ipify.org"),
    httpGet("https://api64.ipify.org")
  ]);

  // Add each IP to the whitelist
  let added = 0;
  let result = "";
  if (v4) {
    const r4 = await callWorker("add", { ip: v4 });
    result += "IPv4: " + v4 + (r4.changed ? " (added)" : " (exists)") + "\n";
    if (r4.changed) added++;
  }
  if (v6 && v6.includes(":")) {
    const r6 = await callWorker("add", { ip: v6 });
    result += "IPv6: " + v6 + (r6.changed ? " (added)" : " (exists)") + "\n";
    if (r6.changed) added++;
  }

  result += added > 0 ? added + " IP(s) added" : "No new IPs";
  const n = new Notification();
  n.title = "IP Whitelist";
  n.body = result;
  await n.schedule();
}
```

### Android (HTTP Shortcuts)

1. Install [HTTP Shortcuts](https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts) (free)
2. Create a "Basic Request" shortcut:
   - Method: `GET`
   - URL: `https://your-worker.example.com/?key=YOUR_DEVICE_KEY&action=sync`
3. Optionally create extra shortcuts: use `GET` for `list`/`preview` (header or query key), and `POST` with JSON body + `X-Device-Key` for `add`/`remove`.

## Cloudflare API Token

Create a Custom Token at https://dash.cloudflare.com/profile/api-tokens.

### Runtime token (required for the Worker)

The `CF_API_TOKEN` secret used by the Worker at runtime only needs permission to update the Access Policy:

| Permission | Access | Why |
|---|---|---|
| Account > Access: Apps and Policies | Edit | GET/PUT the Access Policy include list |
| Account > Account Settings | Read | Resolve account-scoped Access API calls as needed |

Scope: Include your account.

Do **not** grant Workers Scripts Edit or KV Storage Edit on the runtime token. The Worker already has KV access via its namespace binding; script deploys are separate.

### Deploy-time permissions (Dashboard / wrangler — not the runtime token)

Creating the Worker, editing code, and managing KV namespaces is done through the Cloudflare Dashboard (or `wrangler login` OAuth), not through `CF_API_TOKEN`. If you use a CI deploy token for wrangler, that is a **separate** token from the Worker's runtime secret and may need:

| Permission | Access | When |
|---|---|---|
| Account > Workers Scripts | Edit | Deploying/updating the Worker via API/CI |
| Account > KV Storage | Edit | Creating/managing KV namespaces via API/CI |

Keep runtime and deploy credentials separate whenever possible.

## Customization

### Fixed IP Ranges

If you have static IPs (office, carrier NAT ranges), add them via the Dashboard:

1. Worker → **Settings** → **Variables** → **Environment variables**
2. Add `FIXED_IPS` with value like `203.0.113.0/24,198.51.100.0/24`
3. Click **Deploy**

These IPs are always included in the whitelist alongside dynamic device IPs. The Worker rebuilds the full Access Policy `include` list on sync, so any IP or CIDR that must be preserved should be listed in `FIXED_IPS`.

### More Devices (no code change)

Preferred: set a plain env var `DEVICE_KEYS_JSON` that maps secret env names to device names. Secrets stay in separate secret vars; the JSON only references their names.

1. Create a secret for the new device (Dashboard **Variables** / `wrangler secret put KEY_LAPTOP`)
2. Set `DEVICE_KEYS_JSON` (plain text env var is fine):

```json
[
  {"env":"KEY_DEVICE_1","name":"device1"},
  {"env":"KEY_DEVICE_2","name":"device2"},
  {"env":"KEY_LAPTOP","name":"laptop"}
]
```

3. Deploy / save variables — no `src/index.js` edit required.

If `DEVICE_KEYS_JSON` is absent or empty, the Worker falls back to hard-coded `KEY_DEVICE_1` → `device1` and `KEY_DEVICE_2` → `device2`.

You may also use `{"secret":"...","name":"..."}` entries, but referencing env var names (`env`) is preferred so secrets are not duplicated in JSON.

### IP Limit Per Device

Change `MAX_IPS_PER_DEVICE` in `src/lib.js` (default: 8), then redeploy.

## Development

Lightweight unit tests (no heavy deps) for IP normalize + per-device eviction:

```bash
npm test
```

Logs for CF API errors, rate limits, sync lock contention, and invalid `DEVICE_KEYS_JSON` are JSON lines via a thin `log(level, msg, fields)` helper.

Policy rebuild uses KV `list({ prefix: "device:" })` as the source of truth for device IP lists (no separate device registry key).

## Updating the Worker

### Via Dashboard

1. Go to your Worker in the Dashboard
2. Click **Edit code**
3. Paste the updated code
4. Click **Deploy**

### Via wrangler (for developers)

```bash
wrangler deploy
```

View live logs:

```bash
wrangler tail
```

Check a device's current IPs via API:

```bash
curl "https://your-worker.example.com/?action=list" \
  -H "X-Device-Key: YOUR_DEVICE_KEY"
```

Preview the Access Policy `include` list without modifying it:

```bash
curl "https://your-worker.example.com/?action=preview" \
  -H "X-Device-Key: YOUR_DEVICE_KEY"
```

## Important: Bypass Cloudflare Managed Challenge

If your Worker URL or service domains are behind Cloudflare, you may hit a common pitfall: **Cloudflare's Security Level triggers a Managed Challenge (人机验证) that breaks both the IP refresh page and mobile Apps.**

### The Problem

Cloudflare's Security Level can challenge requests based on IP reputation. When this happens:

1. **Worker IP refresh page** → Browser shows a Cloudflare challenge page instead of the auto-detect page
2. **Mobile Apps** (Home Assistant, etc.) → App connects, CF returns an HTML challenge page, App can't process it → connection fails

Cloudflare's own documentation confirms: *"Cloudflare challenges are generally not supported in embedded browsers"* — which is what Apps use.

### The Fix: Configuration Rule

Create a Cloudflare Configuration Rule to disable Security Level and Browser Integrity Check for your domains.

**Dashboard path**: `Cloudflare Dashboard → your zone → Rules → Configuration Rules → Create rule`

**Rule settings**:

- **Rule name**: `App domains bypass challenge`
- **Match**: Hostname is one of:
  ```
  your-worker.example.com    # Worker IP refresh page
  ha.example.com             # Home Assistant direct access
  app.example.com            # Other App direct access domains
  ```
- **Settings**:
  - Security Level → **Off**
  - Browser Integrity Check → **Off**

**Expression preview**:

```
(http.host in {"your-worker.example.com" "ha.example.com" "app.example.com"})
```

### Why This Is Safe

| Protection Layer | Affected? | Why |
|---|---|---|
| DDoS Protection | No | Independent managed ruleset |
| WAF Managed Rules | No | Runs separately |
| Bot Fight Mode | No | Independent product |
| Geographic Blocking | No | Your geo-block rules still work |
| Access Policy | No | IP whitelist still enforces at edge |
| Threat Score | N/A | CF has deprecated threat score (always 0), this mechanism is effectively dead |

The only thing you're disabling is the IP reputation challenge, which CF itself has acknowledged is no longer functional. All other protection layers remain active.

### Which Hostnames to Include

| Domain | Why |
|---|---|
| Worker domain | So the IP refresh page loads without challenge |
| App direct-access domains | So Apps can connect (they can't complete challenges) |
| **Don't include** browser-only admin domains | Keep challenge protection for those if you want |

## Troubleshooting

| Problem | Solution |
|---|---|
| `workers.dev` doesn't load | Blocked in some regions. Add a custom domain. |
| Access Policy blocks the Worker | Create a Bypass policy for the Worker hostname. |
| Challenge page appears instead of IP refresh | Create a Configuration Rule to disable Security Level for the Worker domain. See [Important: Bypass Cloudflare Managed Challenge](#important-bypass-cloudflare-managed-challenge). |
| App can't connect (shows error) | Same fix: disable Security Level for the App's domain via Configuration Rule. |
| `unknown rule type: 'description'` | Don't add extra fields to CF Access include entries. |
| Chinese text garbled in browser | Make sure response has `charset=utf-8` (already fixed in code). |
| IPv6 not detected | Phone may not have IPv6 on current network. IPv4 still works. |

## Security Notes

- Device keys are stored as Worker Secrets (never exposed to clients)
- Sync bookmarks still put `key` in the URL — keep that link private. Mutations (`add`/`remove`) use POST + header/body so the key is not required in query strings
- CORS never reflects `*`; only same Worker origin is allowed when `Origin` is present
- Authenticated requests are rate-limited (~30/min per device key + client IP)
- Each device key maps to a unique device name in KV
- IPs are stored with timestamps, oldest auto-evicted
- The Worker only has permission to read/write the specific Access Policy
- The Access Policy should be dedicated to this Worker and kept simple
- Consider rotating device keys periodically

## Limitations

- One Access Policy per Worker deployment (multiple policies need multiple Workers)
- CF Access include array limit: 1,000 entries per policy
- KV eventual consistency: ~60s propagation (practically instant for this use case)

## License

MIT
