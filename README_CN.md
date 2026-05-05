# Cloudflare Worker IP 白名单自动更新

[English](README.md)

通过手机一键更新 Cloudflare Access Policy 的 IP 白名单。无需服务器，完全运行在 Cloudflare 免费额度上。

## 解决什么问题

如果你用 Cloudflare Tunnel 把家里服务穿透到公网，Tunnel 本身不做访问控制——任何人知道你的域名就能看到登录页面。加上 Access Policy IP 白名单后，只有你手机的 IP 能直接放行，其他人连登录界面都看不到。这才是真正的零信任：未经验证的请求，连入口都摸不到。

问题在于手机 IP 会变。Wi-Fi 和蜂窝网络切换一次，出口 IP 就变了，你就会把自己锁在外面。每次手动去 Cloudflare 后台改白名单很麻烦。

这个 Worker 就是解决这个的：手机点一下收藏的链接，白名单自动更新。

## 工作流程

```
手机打开刷新链接
        ↓
Worker 获取 CF-Connecting-IP（你的真实出口 IP）
        ↓
页面内 JS 通过 ipify 探测 IPv4 和 IPv6
        ↓
存储到 KV（每设备最多 8 个，超出时淘汰最旧的）
        ↓
重建 Access Policy 的 include 列表 → PUT CF API
        ↓
约 1 秒后 IP 在 Cloudflare 边缘节点生效
```

## 功能

- **双栈**：自动检测并记录 IPv4 和 IPv6
- **多设备**：每个设备独立管理白名单，可配置每设备上限
- **一键更新**：收藏链接，IP 变化时点击即可
- **自动清理**：达到上限时自动淘汰最旧 IP，不留冗余
- **零依赖**：纯 Cloudflare Worker + KV，无需额外服务

## 快速开始

### 准备工作

- Cloudflare 账户（免费版即可）
- 安装了 `wrangler` CLI（`npm install -g wrangler`，也可使用 `npx wrangler`）
- 已在 Cloudflare Zero Trust 中创建 Access Policy（如未创建，参考 [官方文档](https://developers.cloudflare.com/cloudflare-one/policies/access/)）

### 1. 创建 KV 命名空间

```bash
wrangler kv namespace create DEVICE_IPS
# 将返回的 id 填入 wrangler.toml
```

### 2. 配置文件

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
# 必须设置的
wrangler secret put CF_API_TOKEN    # CF API Token，权限见下方说明
wrangler secret put ACCOUNT_ID      # Cloudflare 账户 ID
wrangler secret put POLICY_ID       # 要更新的 Access Policy ID

# 设备密钥（每设备一个，使用 openssl rand -hex 16 生成）
wrangler secret put KEY_DEVICE_1    # 第一个设备
wrangler secret put KEY_DEVICE_2    # 第二个设备

# 可选：需要始终包含在白名单中的固定 IP 段（逗号分隔）
# wrangler secret put FIXED_IPS    # 例如 "203.0.113.0/24,198.51.100.0/24"
```

### 4. 部署

```bash
wrangler deploy
# 运行后会返回 URL，格式为：https://cf-ip-whitelist.你的子域名.workers.dev
```

### 5. 绑定自定义域名（推荐）

`workers.dev` 在部分地区无法访问。在 Cloudflare Dashboard → Workers → 你的 Worker → 设置 → 域名和路由 → 添加自定义域名。

### 6. 为 Worker 域名设置 Access 放行

Access Policy 可能会拦截 Worker 自身的请求。为 Worker 域名创建一条 Bypass 策略：

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

| 接口 | 说明 |
|---|---|
| `GET /?key=KEY&action=sync` | 记录连接 IP 并返回自动探测双栈的 HTML 页面 |
| `GET /?key=KEY&action=add&ip=X.X.X.X` | 添加指定 IP（返回 JSON） |
| `GET /?key=KEY&action=list` | 列出当前设备所有白名单 IP（JSON） |
| `GET /?key=KEY&action=remove&ip=X.X.X.X` | 移除指定 IP |

## 手机端配置

### iOS（快捷指令 + Scriptable）

1. 安装 [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)（免费）
2. 创建新脚本，粘贴下方代码
3. 在快捷指令 App 中创建两个自动化：
   - **加入 Wi-Fi** → 运行 Scriptable 脚本
   - **离开 Wi-Fi** → 运行 Scriptable 脚本

**同步脚本**：

```javascript
// 替换为你的配置
const WORKER_URL = "https://your-worker.example.com";
const DEVICE_KEY = "你的设备密钥";

// 判断是手动触发还是自动化触发
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
  // 手动触发：在 WebView 中打开同步页面
  const wv = WebView.current();
  await wv.loadURL(WORKER_URL + "/?key=" + DEVICE_KEY + "&action=sync");
  await wv.present();
} else {
  // 自动触发：等待网络稳定后后台更新
  await delay(5000);

  const [v4, v6] = await Promise.all([
    httpGet("https://api.ipify.org"),
    httpGet("https://api64.ipify.org")
  ]);

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
2. 创建"基本请求"快捷方式，方法选择 `GET`，URL 填写：
   ```
   https://your-worker.example.com/?key=你的设备密钥&action=sync
   ```
3. 将此快捷方式收藏到桌面，IP 变化时点击运行即可

## Cloudflare API Token

在 https://dash.cloudflare.com/profile/api-tokens 创建自定义 Token：

| 权限 | 访问级别 |
|---|---|
| Account > Access: Apps and Policies | Edit |
| Account > Workers Scripts | Edit |
| Account > KV Storage | Edit |
| Account > Account Settings | Read |

作用域选择你的账户。

## 高级配置

### 固定 IP 段

如果你有固定的 IP（如公司公网出口），可通过环境变量设置，这些 IP 将始终保留在白名单中：

```bash
wrangler secret put FIXED_IPS
# 输入：203.0.113.0/24,198.51.100.0/24
```

### 添加更多设备

编辑 `src/index.js`，在 `validateKey()` 中添加条目：

```javascript
function validateKey(key, env) {
  const devices = [
    { key: env.KEY_DEVICE_1, name: "device1" },
    { key: env.KEY_DEVICE_2, name: "device2" },
    { key: env.KEY_LAPTOP, name: "laptop" },  // 新设备
  ];
  // ...
}
```

然后设置对应的密钥：

```bash
wrangler secret put KEY_LAPTOP
```

### 每设备 IP 存储上限

修改 `src/index.js` 中的 `MAX_IPS_PER_DEVICE`（默认：8）。

## 更新与调试

修改代码后重新部署：

```bash
wrangler deploy
```

查看实时日志：

```bash
wrangler tail
```

通过 API 查询某设备当前的白名单状态：

```bash
curl "https://your-worker.example.com/?key=你的设备密钥&action=list"
```

## 重要：绕过 Cloudflare 人机验证

如果你的 Worker URL 或服务域名通过 Cloudflare 代理，可能会遇到一个常见问题：Cloudflare 的安全级别触发了 Managed Challenge（人机验证），导致 IP 刷新页面和手机 App 都无法正常访问。

### 问题原因

Cloudflare 的安全级别会根据 IP 信誉触发验证页面。当触发时：

1. **Worker IP 刷新页面** → 浏览器显示 Cloudflare 验证页面而非自动探测界面
2. **手机 App**（Home Assistant 等）→ App 访问服务时，CF 返回 HTML 验证页面，App 内嵌浏览器无法处理 → 连接失败

Cloudflare 官方文档明确说明：*"Cloudflare challenges are generally not supported in embedded browsers"*——App 使用的正是内嵌浏览器。

### 解决方案：配置规则

创建 Cloudflare Configuration Rule，对相关域名关闭安全级别和浏览器完整性检查。

**控制台路径**：`Cloudflare Dashboard → 你的域名 → 规则 → 配置规则 → 创建规则`

**规则设置**：

- **规则名称**：`App 域名绕过验证`
- **匹配条件**：主机名属于以下之一：
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

### 安全影响分析

| 防护层 | 是否受影响 | 原因 |
|---|---|---|
| DDoS 防护 | 否 | 独立托管规则集 |
| WAF 托管规则 | 否 | 独立运行 |
| Bot Fight Mode | 否 | 独立产品 |
| 地理封锁 | 否 | 自定义封锁规则不受影响 |
| Access Policy | 否 | IP 白名单仍在边缘节点执行 |
| 威胁评分 | 不适用 | CF 已废弃此机制（始终返回 0） |

关闭的仅是 IP 信誉质询——一个 CF 已不再维护的旧机制。所有其他防护层保持活跃。

### 需要加入的域名

| 域名 | 原因 |
|---|---|
| Worker 域名 | 确保 IP 刷新页面正常加载 |
| App 直连域名 | 确保 App 请求能通过（App 无法完成验证） |
| **不要加入** 仅浏览器访问的管理域名 | 可按需保留这些域名的验证保护 |

## 故障排除

| 问题 | 解决方法 |
|---|---|
| `workers.dev` 无法访问 | 部分地区被屏蔽，添加自定义域名 |
| Access Policy 拦截了 Worker | 为 Worker 域名创建 Bypass 策略 |
| 打开后显示 CF 验证页面而非刷新界面 | 创建 Configuration Rule 关闭该域名的安全级别，详见上方章节 |
| App 连接报错 | 同上，将 App 对应的域名也加入 Configuration Rule |
| `unknown rule type: 'description'` 错误 | Access Policy 的 include 条目中不要添加额外字段 |
| 浏览器中中文显示乱码 | 已修复，响应头中包含 `charset=utf-8` |
| 无法检测到 IPv6 | 当前网络可能不支持 IPv6，仅 IPv4 也能正常使用 |

## 安全说明

- 设备密钥存储为 Worker Secrets，不会暴露给客户端
- 每个设备密钥映射到 KV 中唯一的设备名
- IP 带时间戳存储，最旧的条目自动淘汰
- Worker 仅有权限读写指定的 Access Policy
- 建议定期轮换设备密钥

## 限制

- 一个 Worker 部署对应一条 Access Policy，多条 Policy 需要多个 Worker
- CF Access include 数组上限：每条 Policy 1,000 个条目
- KV 最终一致性约 60 秒（实际使用基本瞬时生效）

## 许可证

MIT
