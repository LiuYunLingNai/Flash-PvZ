# 植物大战僵尸 · 在线版（账号 + 云存档）

原版 Flash 汉化 SWF，用 [Ruffle](https://ruffle.rs) 在浏览器里跑，外加一个
Node + SQLite 后端：每个玩家注册账号后，游戏进度自动同步到服务器，换设备也能接着玩。

## 目录

```
server.js          Express 服务器：托管游戏 + 账号/存档 API
config.js          配置加载：default_config 默认值 + config.yaml 本机覆盖 + 环境变量
config/            配置目录
  default_config.yaml  出厂默认（随代码更新，勿改）
  config.yaml          本机配置（首次启动自动生成，已 gitignore，改这份）
db.js              SQLite 存储层（用 Node 内置 node:sqlite，无需编译）
data.db            运行时自动生成，含用户与存档（已 gitignore，勿公开）
public/            对外暴露的静态文件（唯一 web 根目录）
  index.html       游戏页 + 登录界面
  auth.js          登录/注册 + 存档同步
  auth.css
  plants-vs-zombies.swf  resources.swf  data.xml
  music/  properties/  fonts/  ruffle/
```

## 本地运行

```bash
pnpm install
pnpm start            # 默认 http://127.0.0.1:8123
```

浏览器打开 http://127.0.0.1:8123 ，注册账号即可游玩。

## 配置

配置放在 `config/`，加载优先级 **环境变量 > `config/config.yaml` > `config/default_config.yaml`**：

- `config/default_config.yaml` —— 出厂默认值（含所有键和注释），**别改这个**，它随代码更新。
- `config/config.yaml` —— 你的本机配置，**首次启动自动从默认值复制生成**；以后默认值里
  新增的项也会自动补进这份（保留注释、不覆盖你已改的值）。已 gitignore，改动不入库、
  `git pull` 也不会覆盖你的部署配置。只改你要改的键即可。

改完**重启服务器**生效。可调项如下：

| 配置项 | 说明 | 默认 |
|---|---|---|
| `port` | 监听端口 | 8123 |
| `secureCookie` | HTTPS 部署时设 `true`，会话 cookie 带 Secure | false |
| `dbPath` | 数据库文件路径（相对根目录或绝对路径） | data.db |
| `sessionDays` | 登录会话保留天数 | 30 |
| `username.minLength` / `maxLength` | 用户名长度 | 2 / 20 |
| `password.minLength` / `maxLength` | 密码长度 | 6 / 200 |
| `rateLimit.maxAttempts` / `windowMinutes` | 同一 IP 时间窗内登录/注册次数上限 | 50 / 15 |
| `saveMaxKb` | 单次存档上传体积上限（KB） | 1000 |

环境变量 `PORT` / `SECURE_COOKIE` / `DB_PATH` 优先级高于配置文件，方便部署时临时覆盖。

## 部署到公网

需要一台能长期跑进程的机器（VPS / Fly.io / Render 等）。

1. 上传代码，`pnpm install --prod`，`pnpm start`（用 pm2 或 systemd 守护）。
2. **必须挂 HTTPS**：账号密码是明文提交的，务必在前面放 Nginx/Caddy 反代做 TLS，
   并在 `config/config.yaml` 里设 `secureCookie: true`（或环境变量 `SECURE_COOKIE=1`）让会话 cookie 带 Secure。
3. 端口在 `config/config.yaml` 的 `port` 调整（或用 `PORT` 环境变量，反代通常指向内网端口）。
4. 固定域名很重要：Ruffle 的存档 key 与访问来源(origin)绑定，域名变了旧 key 对不上。

## 存档原理

游戏用 Flash 的 `SharedObject`（存档名 `com_popcap_flash_games_pvz_PVZFlash`）保存进度，
Ruffle 把它以 base64 存进浏览器 `localStorage`。前端在开局前把该账号的存档写回
localStorage，游戏运行时读到；游戏中每 15 秒 + 切走/关闭页面时，把 localStorage
快照上传到 `/api/save`，按账号存进 SQLite。

## 安全说明

- 密码用 Node 内置 `crypto.scrypt` 加盐哈希，不存明文。
- 会话是 httpOnly cookie + 服务端 sessions 表，30 天过期。
- 登录/注册有简单的按 IP 限流。
- `data.db`、`server.js` 等都在 `public/` 之外，静态服务不会外泄。
- 生产环境务必上 HTTPS（见上）。

## 中文显示

SWF 用设备字体“Microsoft YaHei”画中文，Ruffle 自带字体无中文字形，因此：
- 默认注入 `public/fonts/msyh-face0.ttf`（从系统雅黑 TTC 抽出的单一 TTF）。
- 或访问 `?renderer=canvas` 改用 canvas 渲染器，直接用系统字体。
若字偏上/偏下，调 `public/data.xml` 里的 `<fontcn><offsetY>`。

## 手机上拖影 / 图片缺失

现象是画面残留拖影、部分贴图不显示——这不是网络或素材问题，而是 Ruffle 默认的
GPU 渲染后端（WebGPU）在个别手机 GPU/浏览器上有 bug，加上手机 GPU 的最大
贴图尺寸较小，大图集上传失败就“缺图”。用 `renderer` 查询参数切换图形后端即可：

- `?renderer=wgpu-webgl` —— 强制走 WebGL2（wgpu 后端），跳过较新、手机上易出问题的
  WebGPU，仍是 GPU 加速（先试这个）。
- `?renderer=canvas` —— 强制 2D canvas 渲染器，最高兼容，基本能消除拖影和缺图，但较慢。

> 注意：不要用 `?renderer=webgl`。那是已弃用的旧 WebGL1 后端，在很多设备上直接黑屏
> （没画面）；要 WebGL 加速请用上面的 `wgpu-webgl`（走 WebGL2）。

页面左下角的提示里也放了 `wgpu-webgl` / `canvas` 两个可点的切换链接，手机上直接点即可。

