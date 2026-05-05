# Cloudflare Worker IP 白名单自动更新

[English](README.md)

通过手机一键更新 [Cloudflare Access Policy](https://developers.cloudflare.com/cloudflare-one/policies/access/) IP 白名单。无需服务器，完全运行在 Cloudflare 免费额度上。

## 为什么需要这个？

Cloudflare Access 很适合保护自建服务，但 IP 白名单在手机 IP 频繁变化时（Wi-Fi ↔ 蜂窝网络、漫游）很烦人。这个 Worker 让你从手机上一键更新 Access Policy。

**使用场景**：你用 Cloudflare Tunnel 暴露家庭实验室服务，用 Access Policy IP 白名单作为第一道防线。

## 工作原理

```
手机 → GET https://your-worker.dev/?key=xxx
              ↓
Worker 读取 CF-Connecting-IP（你的真实 IP）
              ↓
客户端 JS 通过 ipify 探测 IPv4 + IPv6
              ↓
Worker 存储 IP 到 KV（每设备最多 8 个，自动淘汰最旧的）
              ↓
Worker 重建 Access Policy include 数组 → PUT CF API
              ↓
IP 在 Cloudflare 边缘节点生效，约 1 秒
```

## 功能特性

- **双栈探测**：自动检测并记录 IPv4 和 IPv6
- **多设备支持**：每个设备独立 IP 列表（可配置每设备上限）
- **一键更新**：收藏链接，IP 变化时点击即可
- **自动清理**：达到上限时自动淘汰最旧 IP，无残留
- **零依赖**：纯 Cloudflare Worker + KV，无外部服务

## 快速开始

### 前置条件

- Cloudflare 账户（免费版即可）
- 已安装 `wrangler` CLI（`npm install -g wrangler`）
- 已创建 Cloudflare Access Policy（如果还没有，参见 [CF 文档](https://developers.cloudflare.com/cloudflare-one/policies/access/)）

### 1. 创建 KV 命名空间

```bash
wrangler kv namespace create DEVICE_IPS
# 将返回的 id 填入 wrangler.toml
```

### 2. 配置

编辑 `wrangler.toml`：

```toml
name = "cf-ip-whitelist"
main = "src/index.js"
compatibility_date = "2024-01-01"
account_id = "你的账户ID"

kv_namespaces = [
  { binding = "DEVICE_IPS", id = "你的KV命名空间ID" }
]
```

### 3. 设置密钥

```bash
# 必填
wrangler secret put CF_API_TOKEN    # CF API Token，需要 Access: Apps and Policies Edit 权限
wrangler secret put ACCOUNT_ID      # 你的 Cloudflare 账户 ID
wrangler secret put POLICY_ID       # 要更新的 Access Policy ID

# 设备密钥（每设备一个，用以下命令生成：openssl rand -hex 16）
wrangler secret put KEY_DEVICE_1    # 第一个设备密钥
wrangler secret put KEY_DEVICE_2    # 第二个设备密钥

# 可选：固定 IP 段（逗号分隔的 CIDR）
# wrangler secret put FIXED_IPS    # 例如 "203.0.113.0/24,198.51.100.0/24"
```

### 4. 部署

```bash
wrangler deploy
# 记下返回的 URL：https://cf-ip-whitelist.你的子域名.workers.dev
```

### 5. 添加自定义域名（推荐）

`workers.dev` 在部分地区被屏蔽。通过 Cloudflare Dashboard → Workers → 你的 Worker → 设置 → 域名和路由 → 添加。

### 6. 为 Worker 设置 Access 放行

你的 Access Policy 可能会拦截 Worker 本身。为 Worker 域名创建 Bypass 策略：

```
Cloudflare Zero Trust → Access → 应用程序 → 添加
  - 域名：your-worker.example.com
  - 策略：Bypass（所有人）
```

### 7. 测试

```
# 从手机浏览器访问：
https://your-worker.example.com/?key=你的设备密钥&action=sync
```

## API 接口

| 端点 | 说明 |
|---|---|
| `GET /?key=KEY&action=sync` | 记录连接 IP + 返回自动探测双栈的 HTML 页面 |
| `GET /?key=KEY&action=add&ip=X.X.X.X` | 添加指定 IP（JSON 响应） |
| `GET /?key=KEY&action=list` | 列出该设备所有白名单 IP（JSON） |
| `GET /?key=KEY&action=remove&ip=X.X.X.X` | 从设备列表中移除 IP |

## 手机配置

### iOS（快捷指令 + Scriptable）

1. 安装 [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)（免费）
2. 创建新脚本，粘贴同步脚本（见下方）
3. 创建快捷指令自动化：
   - **加入 Wi-Fi 时** → 运行 Scriptable
   - **离开 Wi-Fi 时** → 运行 Scriptable

**同步脚本**（用于 Scriptable）：

```javascript
// 配置
const WORKER_URL = "https://your-worker.example.com";
const DEVICE_KEY = "你的设备密钥";

// 检测手动 vs 自动
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
  // 手动：在 WebView 中打开（sync 页面自动探测双栈）
  const wv = WebView.current();
  await wv.loadURL(WORKER_URL + "/?key=" + DEVICE_KEY + "&action=sync");
  await wv.present();
} else {
  // 自动：等待网络稳定，然后更新
  await delay(5000);

  // 通过 ipify 探测 IPv4/IPv6
  const [v4, v6] = await Promise.all([
    httpGet("https://api.ipify.org"),
    httpGet("https://api64.ipify.org")
  ]);

  // 逐个添加到白名单
  let added = 0;
  let result = "";
  if (v4) {
    const r4 = await callWorker("add", "ip=" + encodeURIComponent(v4));
    result += "IPv4: " + v4 + (r4.changed ? " (已添加)" : " (已存在)") + "\n";
    if (r4.changed) added++;
  }
  if (v6 && v6.includes(":")) {
    const r6 = await callWorker("add", "ip=" + encodeURIComponent(v6));
    result += "IPv6: " + v6 + (r6.changed ? " (已添加)" : " (已存在)") + "\n";
    if (r6.changed) added++;
  }

  result += added > 0 ? "新增 " + added + " 个 IP" : "无新增 IP";
  Notification.ready().title("IP 白名单").body(result).schedule();
}
```

### Android（HTTP Shortcuts）

1. 安装 [HTTP Shortcuts](https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts)（免费）
2. 创建"基本请求"快捷方式：
   - 方法：`GET`
   - URL：`https://your-worker.example.com/?key=你的设备密钥&action=sync`
3. 创建第二个快捷方式用于 IPv4：
   - URL：`https://your-worker.example.com/?key=你的设备密钥&action=add&ip=${动态值}`
   - 使用 App 的动态 IP 变量功能

## Cloudflare API Token

在 https://dash.cloudflare.com/profile/api-tokens 创建自定义 Token：

| 权限 | 访问级别 |
|---|---|
| Account > Access: Apps and Policies | Edit |
| Account > Workers Scripts | Edit |
| Account > KV Storage | Edit |
| Account > Account Settings | Read |

作用域：选择你的账户。

## 自定义配置

### 固定 IP 段

如果你有静态 IP（办公网络、运营商 NAT 段），通过环境变量设置：

```bash
wrangler secret put FIXED_IPS
# 输入：203.0.113.0/24,198.51.100.0/24
```

这些 IP 会始终包含在白名单中，与动态设备 IP 并存。

### 添加更多设备

编辑 `src/index.js`，在 `validateKey()` 中添加条目：

```javascript
function validateKey(key, env) {
  const devices = [
    { key: env.KEY_DEVICE_1, name: "device1" },
    { key: env.KEY_DEVICE_2, name: "device2" },
    { key: env.KEY_LAPTOP, name: "laptop" },  // 添加这一行
  ];
  // ...
}
```

然后设置新密钥：

```bash
wrangler secret put KEY_LAPTOP
```

### 每设备 IP 上限

修改 `src/index.js` 中的 `MAX_IPS_PER_DEVICE`（默认：8）。

## 更新 Worker

修改 `src/index.js` 后重新部署：

```bash
wrangler deploy
```

查看实时日志（调试用）：

```bash
wrangler tail
```

通过 API 查看设备当前 IP 状态：

```bash
curl "https://your-worker.example.com/?key=你的设备密钥&action=list"
```

## 重要：绕过 Cloudflare 人机验证

如果你的 Worker URL 或服务域名在 Cloudflare 后面，可能会遇到一个常见问题：**Cloudflare 的安全级别会触发 Managed Challenge（人机验证），导致 IP 刷新页面和手机 App 都无法正常使用。**

### 问题描述

Cloudflare 的安全级别会根据 IP 信誉对请求进行质询。当触发时：

1. **Worker IP 刷新页面** → 浏览器显示 Cloudflare 质询页面，而不是自动探测页面
2. **手机 App**（Home Assistant 等）→ App 连接，CF 返回 HTML 质询页面，App 无法处理 → 连接失败

Cloudflare 官方文档明确说明：*"Cloudflare challenges are generally not supported in embedded browsers"* —— 而 App 使用的正是内嵌浏览器。

### 修复方法：配置规则

创建 Cloudflare 配置规则，对你的域名关闭安全级别和浏览器完整性检查。

**控制台路径**：`Cloudflare Dashboard → 你的域名 → 规则 → 配置规则 → 创建规则`

**规则设置**：

- **规则名称**：`App 域名绕过质询`
- **匹配条件**：主机名等于以下之一：
  ```
  your-worker.example.com    # Worker IP 刷新页面
  ha.example.com             # Home Assistant 直连
  app.example.com            # 其他 App 直连域名
  ```
- **设置**：
  - 安全级别 → **关闭**
  - 浏览器完整性检查 → **关闭**

**表达式预览**：

```
(http.host in {"your-worker.example.com" "ha.example.com" "app.example.com"})
```

### 为什么这是安全的

| 防护层 | 是否受影响 | 原因 |
|---|---|---|
| DDoS 防护 | 否 | 独立的托管规则集 |
| WAF 托管规则 | 否 | 独立运行 |
| Bot Fight Mode | 否 | 独立产品 |
| 地理封锁 | 否 | 你的地理封锁规则仍然有效 |
| Access Policy | 否 | IP 白名单仍在边缘执行 |
| 威胁评分 | 不适用 | CF 已废弃威胁评分（始终为 0），此机制实际上已失效 |

你唯一关闭的是 IP 信誉质询，CF 自己也承认这个机制已不再有效。所有其他防护层保持活跃。

### 应该包含哪些域名

| 域名 | 原因 |
|---|---|
| Worker 域名 | 让 IP 刷新页面正常加载 |
| App 直连域名 | 让 App 能正常连接（App 无法完成质询） |
| **不要包含** 仅浏览器访问的管理域名 | 如果需要，可以保留这些域名的质询保护 |

## 故障排除

| 问题 | 解决方案 |
|---|---|
| `workers.dev` 无法加载 | 部分地区被屏蔽，添加自定义域名。 |
| Access Policy 拦截 Worker | 为 Worker 域名创建 Bypass 策略。 |
| 显示质询页面而非 IP 刷新页面 | 创建配置规则关闭 Worker 域名的安全级别。见 [重要：绕过 Cloudflare 人机验证](#重要绕过-cloudflare-人机验证)。 |
| App 无法连接（显示错误） | 同上：通过配置规则关闭 App 域名的安全级别。 |
| `unknown rule type: 'description'` | 不要在 CF Access include 条目中添加额外字段。 |
| 浏览器中中文乱码 | 确保响应头包含 `charset=utf-8`（代码中已修复）。 |
| 无法检测 IPv6 | 手机当前网络可能不支持 IPv6，IPv4 仍可正常工作。 |

## 安全说明

- 设备密钥存储为 Worker Secrets（不会暴露给客户端）
- 每个设备密钥映射到 KV 中唯一的设备名
- IP 带时间戳存储，最旧的自动淘汰
- Worker 仅有权读写指定的 Access Policy
- 建议定期轮换设备密钥

## 限制

- 每个 Worker 部署对应一个 Access Policy（多个 Policy 需要多个 Worker）
- CF Access include 数组限制：每个 Policy 1,000 条
- KV 最终一致性：约 60 秒传播（实际使用中几乎即时）

## 许可证

MIT
