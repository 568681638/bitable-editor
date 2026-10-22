# 部署说明 — bitable-annotator

本项目部署在 **阿里云 PAI DSW 容器**中，PID 1 是 `/etc/dsw/bin/entrypoint`，进程管理用的是 `supervisord`（不是 systemd，`systemctl` / `pm2 startup` 都不能用）。

部署前先在项目目录执行 `npm install && npm run build` 生成 `dist/`（`dist/` 不入库）。本目录下的一键脚本会：

1. 把 supervisor 程序配置装到 `/etc/supervisor/conf.d/`，交给容器内的 supervisord 托管（自动重启 + 集中日志）
2. 在 `~/.prestart.d/` 里注册一个启动前钩子——DSW 每次容器启动、跑 supervisord 之前会 source 这个钩子，把配置重新装回易失的 rootfs
3. 立即拉起（或重启）服务

> 脚本可以**从任意目录直接调用**（不需要 `cd` 进项目目录）；也是**幂等**的，反复跑没副作用。

---

## 一键部署

```bash
# 从任意目录直接调用（推荐）
/zyt_users/yuntong.li/server/bitable-annotator/deploy.sh

# 或者进项目目录再跑，效果一样
cd /zyt_users/yuntong.li/server/bitable-annotator && ./deploy.sh
```

脚本内部用 `${BASH_SOURCE[0]}` 定位自己所在的目录作为 `PROJECT_DIR`，跟当前工作目录（`$PWD`）无关，所以从哪儿调用都可以。

首次执行会安装文件；再次执行是幂等的——安全地重装 + 重启。

**建议**：加个 alias 更省事：

```bash
echo "alias redeploy-bitable='/zyt_users/yuntong.li/server/bitable-annotator/deploy.sh'" >> ~/.bashrc
# 之后随时随地：
redeploy-bitable
```

**可选环境变量：**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `6868` | 本次启动使用的端口（不会写入 supervisor.conf；持久化端口请直接改 `supervisor.conf` 里的 `environment=` 行） |
| `NODE_BIN` | `$(command -v node)`，兜底 `/etc/dsw/node/bin/node` | 强制指定 node 可执行文件 |

---

## 部署后会生成/修改哪些文件

| 位置 | 是否持久化 | 作用 |
| --- | --- | --- |
| `./supervisor.conf` | ✅ 持久 (NFS) | supervisord 程序模板，占位符 `{{PROJECT_DIR}}` / `{{NODE}}` |
| `./deploy.sh` | ✅ 持久 (NFS) | 一键部署脚本 |
| `~/.prestart.d/00-bitable-annotator.sh` | ✅ 持久 (`/root`) | 容器启动钩子——DSW entrypoint 会自动 source |
| `/etc/supervisor/conf.d/bitable-annotator.conf` | ❌ 易失 (rootfs) | 已渲染的 supervisor 配置；容器重启后由启动钩子重建 |
| `/etc/dsw-logs/bitable-annotator.log` | ❌ 易失 (rootfs) | 运行日志（stdout + stderr） |

---

## 常用管理

```bash
# 查看是否在跑
pgrep -af server.mjs

# 看日志
tail -f /etc/dsw-logs/bitable-annotator.log

# 手动重启 (直接再跑一次 deploy.sh 就好)
./deploy.sh

# 只停止 (不删配置)
pkill -f "node .*server\.mjs"

# 端口占用排查
ss -ltnp | grep 6868
```

> **注意**：容器里的 supervisord 没有开 RPC 端口，`supervisorctl` 用不了。要重启由 supervisord 托管的实例：要么走 `deploy.sh` 一路杀掉再拉起，要么重启整个容器（会让 supervisord 按新配置自动拉起）。

---

## 修改配置

**改端口 / 加环境变量** — 编辑 `supervisor.conf` 里的这一行：

```ini
environment=PORT="6868",NODE_ENV="production"
```

改完再跑一次 `./deploy.sh` 即可（会重新渲染 + 重启）。

**换项目位置** — 直接把整个目录移到新位置，然后在新位置跑 `./deploy.sh`。脚本会用它自己所在的目录作为 `PROJECT_DIR`，钩子里保存的路径也会自动更新。

**不用 DSW 默认的 node** — `NODE_BIN=/path/to/node ./deploy.sh`

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
| `./deploy.sh` 说 node 找不到 | `NODE_BIN=/etc/dsw/node/bin/node ./deploy.sh` |
| 服务启动失败 | 看 `/etc/dsw-logs/bitable-annotator.log` |
| 容器重启后没自动起 | 检查 `ls -la ~/.prestart.d/` 里钩子还在不在；`ls /etc/supervisor/conf.d/` 看配置是否被钩子重建；`grep bitable /etc/dsw-logs/supervisord.log` 看 supervisord 加载情况 |
| 想同时挂多个 prestart 脚本 | DSW entrypoint 用的是 `. $HOME/.prestart.d/*`（bash 内建 `.` 只接一个文件），多个文件会有兼容性问题。目前钩子命名为 `00-…` 会排在最前；如果确实要多脚本，建议把它们合并到 `00-…` 里，或让 `00-…` 循环 source 其它文件 |
