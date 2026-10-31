# 部署包 — bitable-annotator

**这个 `release/` 目录就是要部署到服务器上的全部内容**，整个目录拷过去即可，不需要拷项目的其他文件，也**不需要 `node_modules`**（服务端只用 Node 自带模块）。

```
release/
├── README.md         本说明
├── deploy/
│   ├── deploy.sh     一键部署脚本
│   └── supervisor.conf   supervisord 程序配置模板
├── server/
│   └── server.mjs    生产服务：托管 dist/ + /api-proxy/ 通用代理
└── dist/             前端构建产物（npm run build 生成，不入库，要自己带过去）
```

本项目部署在 **阿里云 PAI DSW 容器**中，PID 1 是 `/etc/dsw/bin/entrypoint`，进程管理用的是 `supervisord`（不是 systemd，`systemctl` / `pm2 startup` 都不能用）。

> **服务端必须兼容 Node 14**（DSW 自带的是 14.x）：`server/server.mjs` 里不要用 `??=` / `||=` / `replaceAll` / `.at()` 等较新的写法，本机新版 Node 能跑不代表 DSW 上能跑。

---

## 快速开始

**1. 在本机构建**（`dist/` 会直接生成到 `release/dist/`）：

```bash
npm install     # 首次
npm run build
```

**2. 把整个 `release/` 目录拷到服务器**，例如放到 `/zyt_users/yuntong.li/server/bitable-annotator/release`。

> 也可以在服务器上构建：服务器上 `git pull` → `npm install`（依赖有变化时）→ `npm run build`，效果一样；前提是 DSW 能访问 npm 仓库。

**3. 在服务器上执行一键部署：**

```bash
bash /zyt_users/yuntong.li/server/bitable-annotator/release/deploy/deploy.sh
```

脚本会：

1. 把 supervisor 程序配置装到 `/etc/supervisor/conf.d/`，交给容器内的 supervisord 托管（自动重启 + 集中日志）
2. 在 `~/.prestart.d/` 里注册一个启动前钩子——DSW 每次容器启动、跑 supervisord 之前会 source 这个钩子，把配置重新装回易失的 rootfs
3. 停掉旧进程，立即拉起服务，并**真正访问一次端口**确认可用；失败会打印 node 版本和日志

> 脚本可以**从任意目录直接调用**（不需要 `cd`）；也是**幂等**的，反复跑没副作用。

**4. 验证：**

```bash
curl -I http://127.0.0.1:6868/
```

> 如果直接执行 `release/deploy/deploy.sh` 提示 `Permission denied`，用上面的 `bash …` 写法即可。

**建议**：加个 alias 更省事：

```bash
echo "alias redeploy-bitable='bash /zyt_users/yuntong.li/server/bitable-annotator/release/deploy/deploy.sh'" >> ~/.bashrc
```

### 从旧目录结构升级

部署脚本的位置先后变过两次（项目根目录 → `deploy/` → 现在的 `release/deploy/`）。升级后**必须用新路径跑一次**部署脚本：

- 旧的启动钩子和 supervisor 配置里记着旧路径，不重跑的话：正在运行的进程不受影响，但进程崩溃自动重启或容器重启后将找不到入口。
- 新脚本会识别历代入口路径、停掉旧进程，并重写钩子和 supervisor 配置。
- 旧路径下遗留的文件（项目根目录的 `deploy.sh`、`server.mjs` 等）可以删掉；日志里 supervisord 反复报 `Cannot find module …/server.mjs` 是它还记着旧配置，是历史报错，重启容器后会消失。

---

## 可选环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6868` | 本次启动使用的端口（不会写入 supervisor.conf；持久化端口请直接改 `deploy/supervisor.conf` 里的 `environment=` 行） |
| `NODE_BIN` | `$(command -v node)`，兜底 `/etc/dsw/node/bin/node` | 强制指定 node 可执行文件 |

---

## 部署后会生成/修改哪些文件

| 位置 | 是否持久化 | 作用 |
| --- | --- | --- |
| `release/`（本目录） | ✅ 持久 (NFS) | 部署包本体 |
| `~/.prestart.d/00-bitable-annotator.sh` | ✅ 持久 (`/root`) | 容器启动钩子——DSW entrypoint 会自动 source |
| `/etc/supervisor/conf.d/bitable-annotator.conf` | ❌ 易失 (rootfs) | 已渲染的 supervisor 配置；容器重启后由启动钩子重建 |
| `/etc/dsw-logs/bitable-annotator.log` | ❌ 易失 (rootfs) | 运行日志（stdout + stderr，追加写入，多次部署的内容会叠在一起） |

---

## 常用管理

```bash
# 查看是否在跑
pgrep -af server.mjs

# 看日志
tail -f /etc/dsw-logs/bitable-annotator.log

# 手动重启 (直接再跑一次 deploy.sh 就好)
bash /zyt_users/yuntong.li/server/bitable-annotator/release/deploy/deploy.sh

# 只停止 (不删配置)
pkill -f "node .*server\.mjs"

# 端口占用排查
ss -ltnp | grep 6868
```

> **注意**：容器里的 supervisord 没有开 RPC 端口，`supervisorctl` 用不了。要重启由 supervisord 托管的实例：要么走 `deploy.sh` 一路杀掉再拉起，要么重启整个容器（会让 supervisord 按新配置自动拉起）。

---

## 修改配置

**改端口 / 加环境变量** — 编辑 `deploy/supervisor.conf` 里的这一行：

```ini
environment=PORT="6868",NODE_ENV="production"
```

改完再跑一次 `deploy.sh` 即可（会重新渲染 + 重启）。

**换位置** — 直接把整个 `release/` 目录移到新位置，然后在新位置跑 `deploy/deploy.sh`。脚本会用它自己所在的目录定位 `server/` 和 `dist/`，钩子里保存的路径也会自动更新。

**不用 DSW 默认的 node** — `NODE_BIN=/path/to/node bash deploy/deploy.sh`

---

## 卸载

```bash
# 1. 停止当前服务
pkill -f "node .*server\.mjs"

# 2. 移除启动钩子 (下次容器启动就不再托管)
rm -f ~/.prestart.d/00-bitable-annotator.sh

# 3. 移除本次容器里的 supervisor 配置 (下次容器启动会消失)
rm -f /etc/supervisor/conf.d/bitable-annotator.conf
```

---

## 故障排查

| 现象 | 排查 |
| --- | --- |
| 部署脚本报「缺少 dist/」 | 本机 `npm run build` 后，把**整个** `release/` 目录（含 `dist/`）重新拷过去 |
| 部署脚本说 node 找不到 | `NODE_BIN=/etc/dsw/node/bin/node bash deploy/deploy.sh` |
| 脚本报「服务未能启动」 | 看它打印的 node 版本和日志；最常见的是服务端代码用了 Node 14 不支持的新语法（见上面的 Node 14 提醒） |
| 访问显示 `ECONNREFUSED` | 说明端口上没有进程在监听，服务没起来或已崩溃，看 `/etc/dsw-logs/bitable-annotator.log` 最后几十行 |
| 容器重启后没自动起 | 检查 `ls -la ~/.prestart.d/` 里钩子还在不在；`ls /etc/supervisor/conf.d/` 看配置是否被钩子重建；`grep bitable /etc/dsw-logs/supervisord.log` 看 supervisord 加载情况 |
| 想同时挂多个 prestart 脚本 | DSW entrypoint 用的是 `. $HOME/.prestart.d/*`（bash 内建 `.` 只接一个文件），多个文件会有兼容性问题。目前钩子命名为 `00-…` 会排在最前；如果确实要多脚本，建议把它们合并到 `00-…` 里，或让 `00-…` 循环 source 其它文件 |
