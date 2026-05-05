# Cloudflare Worker IP 白名单自动更新

[English](README.md)

手机点一下，Cloudflare Access Policy 的 IP 白名单自动更新。不需要服务器，全跑在 Cloudflare 免费额度上。

## 这玩意解决什么问题？

你用 Cloudflare Tunnel 把家里的服务穿透出去，这很好。但 Tunnel 本身不拦人——谁知道了你的域名，就能看见你的登录页。你当然加了 Access Policy 做 IP 白名单，只有你手机的 IP 能放行，别人连登录界面都看不到。

**这才是真正的零信任：不认识你，连门都不让你看见。**

问题是，手机 IP 会变啊。切个 Wi-Fi、切回蜂窝、出趟门，IP 就变了，你就把自己锁外面了。每次还得打开 Cloudflare 后台手动改白名单。

这个 Worker 就是解决这个的：手机点一下收藏的链接，白名单自动更新。完事。

## 怎么工作的

```
手机打开刷新链接
        ↓
Worker 拿到你的 IP（CF-Connecting-IP，真实出口 IP）
        ↓
页面里 JS 用 ipify 测出 IPv4 和 IPv6
        ↓
存进 KV（每个设备最多存 8 个，超了就踢掉最旧的）
        ↓
重建 Access Policy 的 include 列表 → 调 CF API 写进去
        ↓
大概 1 秒就生效了
```

## 特点

- **双栈**：IPv4 和 IPv6 一起加，哪个都不断
- **多设备**：你和家人各用各的链接，互不影响
- **一键**：收藏链接点一下就行，不用进后台
- **不乱堆积**：每个设备最多 8 个 IP，最旧的自动清掉
- **零服务器**：全跑在 Cloudflare 上，NAS 上不装任何东西

## 快速开始

### 准备工作

- 一个 Cloudflare 账号（免费版就行）
- 装好 `wrangler` CLI（`npm install -g wrangler`，或者每次用 `npx wrangler` 也行）
- 已经在 CF Zero Trust 里建好了 Access Policy（新建的话看 [官方文档](https://developers.cloudflare.com/cloudflare-one/policies/access/)）

### 1. 建 KV 命名空间

```bash
wrangler kv namespace create DEVICE_IPS
# 把返回的 id 填到 wrangler.toml 里
```

### 2. 改配置

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

### 3. 设密钥

```bash
# 这仨必须设
wrangler secret put CF_API_TOKEN    # CF API Token，权限下面有说
wrangler secret put ACCOUNT_ID      # Cloudflare 账户 ID
wrangler secret put POLICY_ID       # 要更新的 Access Policy ID

# 设备密钥，每设备一个（用 openssl rand -hex 16 生成）
wrangler secret put KEY_DEVICE_1    # 给第一个设备
wrangler secret put KEY_DEVICE_2    # 给第二个设备

# 可选：固定要加到白名单里的 IP 段，逗号分割
# wrangler secret put FIXED_IPS    # 比如 "203.0.113.0/24,198.51.100.0/24"
```

### 4. 部署

```bash
wrangler deploy
# 会返回一个 URL，像这样：https://cf-ip-whitelist.你的子域名.workers.dev
```

### 5. 绑一个自己的域名（强烈建议）

`workers.dev` 在国内打不开。去 Cloudflare Dashboard → Workers → 你的 Worker → 设置 → 域名和路由 → 添加自定义域名。

### 6. 给 Worker 域名开 Bypass

你的 Access Policy 会拦截一切，包括 Worker 自己。给 Worker 的域名建一条放行规则：

```
Cloudflare Zero Trust → Access → 应用程序 → 添加
  - 域名：your-worker.example.com
  - 策略：Bypass（所有人）
```

### 7. 试试能不能用

```
# 手机浏览器打开：
https://your-worker.example.com/?key=你的设备密钥&action=sync
```

## API

| 接口 | 干什么的 |
|---|---|
| `GET /?key=KEY&action=sync` | 记下连接 IP，返回一个页面自动测出双栈 |
| `GET /?key=KEY&action=add&ip=X.X.X.X` | 手动加一个 IP（返回 JSON） |
| `GET /?key=KEY&action=list` | 查看当前设备所有白名单 IP（JSON） |
| `GET /?key=KEY&action=remove&ip=X.X.X.X` | 删掉某个 IP |

## 手机上怎么用

### iOS（快捷指令 + Scriptable）

1. 装 [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)（免费）
2. 新建脚本，贴上下面这段
3. 在快捷指令 App 里建两个自动化：
   - **加入 Wi-Fi** → 运行 Scriptable 脚本
   - **离开 Wi-Fi** → 运行 Scriptable 脚本

**同步脚本**：

```javascript
// 改成你自己的
const WORKER_URL = "https://your-worker.example.com";
const DEVICE_KEY = "你的设备密钥";

// 判断是手动点还是自动触发
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
  // 手动点：打开页面看结果
  const wv = WebView.current();
  await wv.loadURL(WORKER_URL + "/?key=" + DEVICE_KEY + "&action=sync");
  await wv.present();
} else {
  // 自动触发：后台更新
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

1. 装 [HTTP Shortcuts](https://play.google.com/store/apps/details?id=ch.rmy.android.http_shortcuts)（免费）
2. 建一个"基本请求"，方法 `GET`，URL 填：
   ```
   https://your-worker.example.com/?key=你的设备密钥&action=sync
   ```
3. 把上面那个收藏到桌面，IP 变了点一下就行

## Cloudflare API Token 权限

去 https://dash.cloudflare.com/profile/api-tokens ，创建自定义 Token：

| 权限 | 访问级别 |
|---|---|
| Account > Access: Apps and Policies | Edit |
| Account > Workers Scripts | Edit |
| Account > KV Storage | Edit |
| Account > Account Settings | Read |

作用域选你的账户就行。

## 高级配置

### 固定 IP 段

如果你有固定的 IP（比如公司的公网出口），可以设成环境变量，这些 IP 会一直挂在白名单里：

```bash
wrangler secret put FIXED_IPS
# 输入：203.0.113.0/24,198.51.100.0/24
```

### 加设备

编辑 `src/index.js`，找到 `validateKey()`，加一行：

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

然后设密钥：

```bash
wrangler secret put KEY_LAPTOP
# 填你给这台设备生成的随机字符串
```

### 每设备最多存几个 IP

改 `src/index.js` 里的 `MAX_IPS_PER_DEVICE`（默认 8）。

## 更新和调试

改完代码重新部署：

```bash
wrangler deploy
```

想看实时日志：

```bash
wrangler tail
```

用 API 查某设备当前有哪些 IP：

```bash
curl "https://your-worker.example.com/?key=你的设备密钥&action=list"
```

## 重点：绕过 Cloudflare 人机验证

你的 Worker 域名和 App 直连域名都在 Cloudflare 后面，可能会碰到一个问题：Cloudflare 的安全级别会触发人机验证（Managed Challenge），把你的刷新页面和手机 App 都卡死。

### 什么情况

Cloudflare 偶尔会根据 IP 信誉弹一个验证页面。这时候：

1. **Worker 刷新页面** → 一打开就是 CF 的人机验证，看不到白名单更新界面
2. **手机 App**（Home Assistant 之类）→ App 访问你的服务，CF 返回一个人机验证页面，App 不是浏览器，根本不知道怎么处理，直接报错

CF 官方文档写了：*"Cloudflare challenges are generally not supported in embedded browsers"* —— App 用的就是内嵌浏览器，不支持。

### 怎么修

建一条 Configuration Rule，把这几个域名的安全级别关了就行。

**路径**：`Cloudflare Dashboard → 你的域名 → 规则 → 配置规则 → 创建规则`

**规则设置**：

- **名称**：随便写，比如 `关闭人机验证`
- **匹配**：主机名等于以下之一：
  ```
  your-worker.example.com    # Worker 域名
  ha.example.com             # Home Assistant
  app.example.com            # 其他 App
  ```
- **设置**：
  - 安全级别 → **关闭**
  - 浏览器完整性检查 → **关闭**

**表达式**：

```
(http.host in {"your-worker.example.com" "ha.example.com" "app.example.com"})
```

### 关了安全吗？

| 防护层 | 受影响吗 | 原因 |
|---|---|---|
| DDoS 防护 | 不影响 | 独立规则集管着 |
| WAF 托管规则 | 不影响 | 独立跑 |
| Bot Fight Mode | 不影响 | 独立产品 |
| 地理封锁 | 不影响 | 你设的封锁规则照旧 |
| Access Policy | 不影响 | IP 白名单照样在边缘执行 |
| 威胁评分 | 不用管了 | CF 自己已经废弃了这个机制（始终返回 0） |

关掉的只是 IP 信誉质询——一个 CF 自己都不再维护的老机制。其它防护全在。

### 哪些域名需要加进去

| 域名 | 为什么 |
|---|---|
| Worker 域名 | 让刷新页面正常打开 |
| App 直连域名 | App 里的请求才能过 |
| **不要加** 纯浏览器访问的管理域名 | 留着验证也可以 |

## 故障排除

| 问题 | 怎么搞 |
|---|---|
| `workers.dev` 打不开 | 国内被墙了，绑自己的域名 |
| Access Policy 把 Worker 拦了 | 给 Worker 域名建 Bypass 策略 |
| 打开不是刷新页面，是 CF 人机验证 | 建一条 Configuration Rule 关掉安全级别，看上面那节 |
| App 连不上，报错 | 一样，把你 App 的域名也加进 Configuration Rule |
| `unknown rule type: 'description'` | Access Policy 的 include 里别加多余字段，只放 IP |
| 中文乱码 | 代码已经修了，`charset=utf-8` 写死在返回头里 |
| 测不出 IPv6 | 你当前网络可能没有 IPv6，只加 IPv4 也能用 |

## 安全相关

- 设备密钥存的是 Worker Secrets，代码里都看不到，不会泄露
- 每个设备单独存自己的 IP 列表
- IP 带时间戳，最旧的自动清掉
- Worker 只能读写你指定的那一条 Access Policy
- 建议隔一段时间换一次设备密钥

## 限制

- 一个 Worker 对应一条 Access Policy，多条 Policy 就多部署几个
- CF Access include 数组上限：每条 Policy 1,000 个条目
- KV 最终一致性大概 60 秒（实际用起来基本就是即时的）

## 许可证

MIT
