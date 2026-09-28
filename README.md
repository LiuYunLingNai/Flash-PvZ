# 植物大战僵尸 · 在线版（账号 + 云存档）

原版 Flash 汉化 SWF，用 [Ruffle](https://ruffle.rs) 在浏览器里跑，外加一个
Node + SQLite 后端：每个玩家注册账号后，游戏进度自动同步到服务器，换设备也能接着玩。

## 目录

```
server.js          Express 服务器：托管游戏 + 账号/存档 API
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

## 部署到公网

需要一台能长期跑进程的机器（VPS / Fly.io / Render 等）。

1. 上传代码，`pnpm install --prod`，`pnpm start`（用 pm2 或 systemd 守护）。
2. **必须挂 HTTPS**：账号密码是明文提交的，务必在前面放 Nginx/Caddy 反代做 TLS，
   并设环境变量 `SECURE_COOKIE=1` 让会话 cookie 带 Secure。
3. 端口用 `PORT` 环境变量调整（反代通常指向内网端口）。
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
