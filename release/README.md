# 部署包 — bitable-annotator

**这个 `release/` 目录就是要部署到服务器上的全部内容**，整个目录拷过去即可，不需要拷项目的其他文件，也**不需要 `node_modules`**（服务端只用 Node 自带模块）。

```
release/
├── README.md         本说明
├── deploy/
│   ├── deploy.sh     一键部署脚本
│   └── supervisor.conf   supervisord 程序配置模板
├── server/
│   ├── server.mjs    生产服务：托管 dist/ + /api-proxy/ 通用代理 + /api/functions 批处理函数接口 + /api/config 运行时配置
│   ├── config.json   运行时配置（目前只有教程链接 helpUrl）
│   └── functions/    批处理函数：一个函数一个文件夹（入口 function.mjs 或 function.py，模板见 _template/），可放多层分类目录，热加载
└── dist/             前端构建产物（npm run build 生成，不入库，要自己带过去）
```

本项目部署在 **阿里云 PAI DSW 容器**中，PID 1 是 `/etc/dsw/bin/entrypoint`，进程管理用的是 `supervisord`（不是 systemd，`systemctl` / `pm2 startup` 都不能用）。

> **服务端必须兼容 Node 14**（DSW 自带的是 14.x）：`server/server.mjs` 里不要用 `??=` / `||=` / `replaceAll` / `.at()` 等较新的写法，本机新版 Node 能跑不代表 DSW 上能跑。

---

## 运行时配置（不用重新构建、不用重启）

`server/config.json` 目前只有一项 `helpUrl`（☰ 菜单里「使用教程」的链接，也用于双栏面板预览窗格空状态里的教程链接）。服务每次收到 `/api/config` 请求都会重新读这个文件，在服务器上改完保存、用户刷新页面即生效。文件不存在、内容不合法或链接不是 http(s) 时，前端回落到 `src/shared/common.ts` 里内置的默认值。

---

## 扩充批处理函数（不用重启）

**完整的扩展规则见 [`server/functions/README.md`](server/functions/README.md)**（函数定义、批量约定、出参格式、环境变量、本地测试），下面是摘要。

在服务器的 `release/server/functions/` 下新增或修改函数文件夹即可，服务每次收到请求都会重新扫描目录：新增、修改、删除立即生效；一个函数 = 一个文件夹（入口文件 `function.mjs` / `function.py`，依赖的文件放同一个文件夹），文件夹可以放在任意多层分类目录里（目录结构就是面板里选函数的层级）；以 `_` 或 `.` 开头的文件和目录被忽略；某个文件语法错误只会在日志里报错，不影响其他函数。写法见 `functions/_template/`。前端切到“批处理”面板时会重新读取函数列表（也可点标题行的 ↻，或函数列表加载失败时面板里的「重试」）。

**批量计算**：所有函数（JS 和 Python）统一是批量接口，`run(rows)` 一次拿到一批行（函数每次拿多少行由它的 `batchSize` 决定，默认 100，最大 5000，由面板按这个数攒批 / 拆分；写回表格固定每 100 条一次），返回与 `rows` 等长、顺序一致的结果数组，方便把查询、模型推理合并成一次请求。某一行算不出来，就在对应位置返回一个 Error 对象（JS 的 `new Error('原因')` / Python 的 `ValueError('原因')`），只让这一行失败；某个出参这一行没有值、不想覆盖字段，就把它设为 `None` / `null`（该字段保留原值）；`run` 里直接抛异常则整批失败、运行中断。

**出参值怎么对应字段类型**：函数返回的值要直接是该字段类型在多维表格里的原生形态，面板不做宽松转换（不解析日期字符串、不拆分隔符），类型不对只会让这一行失败，原因写在失败明细里。

| 目标字段类型 | 函数返回 |
| --- | --- |
| 文本 | 字符串（数字也行） |
| 数字 / 货币 / 进度 / 评分 | 数字 |
| 单选 | 选项名（字符串）。选项必须已存在，不会自动新增 |
| 多选 | 选项名数组，如 `["紧急", "普通"]` |
| 日期 | 毫秒时间戳（数字） |
| 复选框 | `true` / `false` |
| 电话 / 邮箱 | 字符串 |
| 超链接 | 链接字符串，或 `{"link": "...", "text": "..."}` |
| 人员 | 人员数组 `[{"id": "..."}]` |

公式、附件、关联、地理位置、群组、自动编号等暂不支持写入，选了会在运行前被拦住。

**Python 函数**：在函数文件夹里放入口 `function.py`，写法见 `functions/_template/function.py`（一个 `META` 加一个 `run(rows)`），函数依赖的其他模块和数据文件放在同一个文件夹里。服务用系统的 `python3` 执行（可用环境变量 `PYTHON_BIN` 指定其他解释器），`functions/_python_executor.py` 是执行器，不要删。数据通过临时目录里的 JSON 文件传给 Python 和取回结果，不经过命令行参数和管道，没有大小限制，用完自动清理；每批启动一次 Python 进程，函数里 `print` 的内容进服务日志。

注意：函数文件夹里任何文件（含入口依赖的模块、数据）变了都会重新加载这个函数；唯一的例外是 JS 入口 `import` 的其他 `.mjs` 模块——被 Node 缓存住了，改了仍需重启服务（Python 函数每次调用都是新进程，没有这个限制）。

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
3. 停掉旧进程（先让 supervisor 停掉自己管的那份，再按命令行匹配，最后**按端口兜底**：不管旧进程从哪个目录启动，只要是占着端口的 node 进程都会被清掉；占端口的不是 node 就报错退出，不误杀），立即拉起服务，并**真正访问一次端口**确认可用；失败会打印 node 版本和日志

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
