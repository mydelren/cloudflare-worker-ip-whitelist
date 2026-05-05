# Cloudflare Worker IP Whitelist

[中文文档](README_CN.md)

Auto-update [Cloudflare Access Policy](https://developers.cloudflare.com/cloudflare-one/policies/access/) IP whitelists from mobile devices. Zero server required — runs entirely on Cloudflare's free tier.

## Why?

Cloudflare Access is great for securing self-hosted services, but IP whitelisting becomes annoying when your phone's IP changes constantly (Wi-Fi ↔ cellular, roaming). This Worker lets you update your Access Policy with one click from your phone.

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
- `wrangler` CLI installed (`npm install -g wrangler`)
- A Cloudflare Access Policy already created (see [CF docs](https://developers.cloudflare.com/cloudflare-one/policies/access/) if you need to create one)

### 1. Create KV Namespace

```bash
wrangler kv namespace create DEVICE_IPS
# Copy the id to wrangler.toml
```

### 2. Configure

Edit `wrangler.toml`:

```toml
name = "cf-ip-whitelist"
main = "src/index.js"
compatibility_date = "2024-01-01"
account_id = "YOUR_ACCOUNT_ID"

kv_namespaces = [
  { binding = "DEVICE_IPS", id = "YOUR_KV_NAMESPACE_ID" }
]
```

### 3. Set Secrets

```bash
# Required
wrangler secret put CF_API_TOKEN    # CF API token with Access: Apps and Policies Edit
wrangler secret put ACCOUNT_ID      # Your Cloudflare account ID
wrangler secret put POLICY_ID       # Access Policy ID to update

# Device keys (one per device, generate with: openssl rand -hex 16)
wrangler secret put KEY_DEVICE_1    # First device key
wrangler secret put KEY_DEVICE_2    # Second device key

# Optional: fixed IP ranges (comma-separated CIDRs)
# wrangler secret put FIXED_IPS    # e.g. "203.0.113.0/24,198.51.100.0/24"
```

### 4. Deploy

```bash
wrangler deploy
# Note the URL: https://cf-ip-whitelist.YOUR_SUBDOMAIN.workers.dev
```

### 5. Add Custom Domain (recommended)

`workers.dev` is blocked in some regions. Add a custom domain via Cloudflare Dashboard → Workers → your worker → Settings → Domains & Routes → Add.

### 6. Set Up Access Bypass for Worker

Your Access Policy might block the Worker itself. Create a Bypass policy for the Worker's hostname:

```
Cloudflare Zero Trust → Access → Applications → Add
  - Domain: your-worker.example.com
  - Policy: Bypass ( Everyone )
```

### 7. Test

```
# From your phone's browser:
https://your-worker.example.com/?key=YOUR_DEVICE_KEY&action=sync
```

## API

| Endpoint | Description |
|---|---|
| `GET /?key=KEY&action=sync` | Records connection IP + returns HTML page that auto-detects dual-stack |
| `GET /?key=KEY&action=add&ip=X.X.X.X` | Adds a specific IP (JSON response) |
| `GET /?key=KEY&action=list` | Lists all whitelisted IPs for the device (JSON) |
| `GET /?key=KEY&action=remove&ip=X.X.X.X` | Removes an IP from the device's list |

## Phone Setup

### iOS (Shortcuts + Scriptable)

1. Install [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) (free)
2. Create a new Script, paste the sync script (see below)
3. Create Shortcuts Automations:
   - **Wi-Fi is Connected** → Run Scriptable
   - **Wi-Fi is Disconnected** → Run Scriptable

**Sync Script** (for Scriptable):

```javascript
// Config
const WORKER_URL = "https://your-worker.example.com";
const DEVICE_KEY = "YOUR_DEVICE_KEY";

// Detect manual vs automated
const isManual = !args.shortcutParameter;

async function callWorker(action, params) {
  let url = WORKER_URL + "/?key=" + DEVICE_KEY + "&action=" + action;
  if (params) url += "&" + params;
  try {
    const r = await request({ url: url });
    return JSON.parse(r.responseText);
  } catch(e) { return { error: e.message }; }
}

async function httpGet(url) {
  try {
    const r = await request({ url: url });
    return r.responseText.trim();
  } catch(e) { return null; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

if (isManual) {
  // Manual: open in WebView (sync page auto-detects dual-stack)
  const wv = WebView.current();
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
    const r4 = await callWorker("add", "ip=" + encodeURIComponent(v4));
    result += "IPv4: " + v4 + (r4.changed ? " (added)" : " (exists)") + "\n";
    if (r4.changed) added++;
  }
  if (v6 && v6.includes(":")) {
    const r6 = await callWorker("add", "ip=" + encodeURIComponent(v6));
    result += "IPv6: " + v6 + (r6.changed ? " (added)" : " (exists)") + "\n";
    if (r6.changed) added++;
  }

  result += added > 0 ? added + " IP(s) added" : "No new IPs";
  Notification.ready().title("IP Whitelist").body(result).schedule();
}
```

### Android (HTTP Shortcuts)

1. Install [HTTP Shortcuts](https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts) (free)
2. Create a "Basic Request" shortcut:
   - Method: `GET`
   - URL: `https://your-worker.example.com/?key=YOUR_DEVICE_KEY&action=sync`
3. Create a second shortcut for IPv4:
   - URL: `https://your-worker.example.com/?key=YOUR_DEVICE_KEY&action=add&ip=${dynamic_value}`
   - Use the app's dynamic IP variable feature

## Cloudflare API Token

Create a Custom Token at https://dash.cloudflare.com/profile/api-tokens:

| Permission | Access |
|---|---|
| Account > Access: Apps and Policies | Edit |
| Account > Workers Scripts | Edit |
| Account > KV Storage | Edit |
| Account > Account Settings | Read |

Scope: Include your account.

## Customization

### Fixed IP Ranges

If you have static IPs (office, carrier NAT ranges), set them via environment variable:

```bash
wrangler secret put FIXED_IPS
# Enter: 203.0.113.0/24,198.51.100.0/24
```

These IPs are always included in the whitelist alongside dynamic device IPs.

### More Devices

Edit `src/index.js`, add entries to `validateKey()`:

```javascript
function validateKey(key, env) {
  const devices = [
    { key: env.KEY_DEVICE_1, name: "device1" },
    { key: env.KEY_DEVICE_2, name: "device2" },
    { key: env.KEY_LAPTOP, name: "laptop" },  // Add this
  ];
  // ...
}
```

Then set the new secret:

```bash
wrangler secret put KEY_LAPTOP
```

### IP Limit Per Device

Change `MAX_IPS_PER_DEVICE` in `src/index.js` (default: 8).

## Updating the Worker

After making changes to `src/index.js`:

```bash
wrangler deploy
```

To view live logs for debugging:

```bash
wrangler tail
```

To check the current state of a device's IPs via API:

```bash
curl "https://your-worker.example.com/?key=YOUR_DEVICE_KEY&action=list"
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
- Each device key maps to a unique device name in KV
- IPs are stored with timestamps, oldest auto-evicted
- The Worker only has permission to read/write the specific Access Policy
- Consider rotating device keys periodically

## Limitations

- One Access Policy per Worker deployment (multiple policies need multiple Workers)
- CF Access include array limit: 1,000 entries per policy
- KV eventual consistency: ~60s propagation (practically instant for this use case)

## License

MIT
