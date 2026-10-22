# 多维表格标注器 (bitable-annotator)

飞书多维表格插件：在表格右侧面板中逐条查看和编辑记录字段，支持视频 / 图片 / 音频预览，并内置服务端代理，解决浏览器访问不到的内网资源。

- 仓库：https://github.com/568681638/bitable-annotator
- 本地开发地址（飞书自定义插件）：`http://localhost:5173/`
- 内网部署地址：`https://dsw-vrip9i7k-8082-ado-euc.k8s.zytintra.com/proxy/6868/`

## 目录结构

```
src/index.ts          插件主逻辑
src/index.scss        样式
index.html            插件 HTML 模板
vite.config.js        Vite 配置
tsconfig*.json        TypeScript 配置
server.mjs            生产服务：托管 dist/ 静态文件 + /api-proxy/ 通用代理
supervisor.conf       supervisord 程序配置模板
deploy.sh             一键部署（详见 DEPLOY.md）
DEPLOY.md             部署与运维说明
dist/                 编译产物（不入库，部署前需 npm run build）
```

## 开发与部署

```bash
npm install
npm run dev          # Vite 开发服务器 → http://localhost:5173/
npm run build        # tsc + vite build → dist/
./deploy.sh          # 安装 supervisor 配置并（重）启动 server.mjs，端口 6868
```

服务器上更新插件的完整流程：`git pull` → `npm run build` → `./deploy.sh`。
部署、日志、排障等细节见 [DEPLOY.md](DEPLOY.md)。

> `npm run deploy`（gh-pages）只能发布纯静态页面，没有 `/api-proxy/`，不适用于需要代理的场景。

## 核心功能

1. **记录导航**：上一条 / 下一条；输入编号回车跳转。切换记录时调用 `showFieldValueEditor` 在表格中定位高亮。
2. **字段渲染**：文本、数字、单选、多选、日期、复选框、URL、公式、附件、人员、群组、位置、自动编号、电话、邮箱。
   - URL 字段自动识别类型，渲染为 `<video>` / `<img>` / `<audio>` / `<iframe>`（网页 16:9 自适应）。
   - 人员、群组只读展示名称。
3. **编辑与保存**：改动后保存按钮亮起，`setRecord` 写回表格；撤销按钮恢复原值。
   只读字段：首字段、URL、公式、关联、附件、人员、群组、位置、自动编号。
4. **刷新按钮 ↻**：同步字段元数据、视图可见字段顺序、单/多选选项、记录列表。

## 服务端代理 `/api-proxy/`

浏览器（飞书页面）直接访问不了内网资源时，由本服务代为请求。

- 用法：`/api-proxy/<encodeURIComponent(目标URL)>`（相对路径，避免与 k8s 的 `/proxy/<port>/` 路由冲突）。
- 前端策略：内网 OSS 域名（`oss-cn-shenzhen-internal.aliyuncs.com`）一开始就走代理；其他 URL 先直连，
  `<img>` / `<video>` / `<audio>` / `<source>` 加载失败时，由全局 error 监听自动改走代理重试一次（`src/index.ts`）。
- 服务端：支持 Range（拖进度条）、跟随重定向（最多 5 次）、流式转发；仅允许 GET / HEAD，不转发 cookie，且仅支持 http / https。
- 安全：**不设域名白名单**，有意放行内网网段（10/8、172.16/12、192.168/16、100.64/10），
  因此能访问本服务的人可以借它探测内网。已拦截回环（含 `localhost`）、链路本地 / 云元数据（169.254.x）、
  组播与保留地址，并固定 DNS 解析结果以防 rebinding。
- 不覆盖 `<iframe>` 网页：代理后页面里的相对链接和脚本会失效。

## 技术决策记录

| 决策 | 原因 |
|------|------|
| 不用 SDK 表格事件自动刷新 | `RecordModify` 等事件触发太频繁，影响标注体验；改为手动刷新按钮 |
| 切换记录时自动定位高亮 | 用 `showFieldValueEditor` 打开首字段编辑框，触发表格定位 |
| 不做 `normalizeOssUrl` | 内网 OSS 地址没有对应公网地址，转公网会 404 |
| 代理路径用相对路径 `api-proxy/` | 避免与 k8s 的 `/proxy/<port>/` 路由冲突 |
| 代理从“内网 OSS 白名单”改为“通用代理 + 失败自动回退” | 别的内网域名（如 bcebos，解析到 10.x）浏览器同样访问不到；见上方安全说明 |
| TTE 等会破框的域名不渲染 iframe | 只展示可点击链接，避免页面无限重刷 |
| 用 supervisord 托管进程 | 部署环境是 DSW 容器，没有 systemd，pm2 自启不可用 |

## SDK 关键 API

| API | 用途 |
|-----|------|
| `bitable.base.getTableById(id)` | 获取表对象 |
| `table.getFieldMetaList()` | 获取所有字段元数据 |
| `view.getVisibleFieldIdList()` | 获取视图可见字段 ID 列表 |
| `table.getRecords({viewId})` | 获取视图记录列表 |
| `field.getOptions()` | 获取单选 / 多选字段的选项 |
| `table.setRecord(recordId, {fields})` | 保存记录 |
| `bitable.ui.showFieldValueEditor(...)` | 打开字段编辑弹窗（触发表格定位高亮） |
| `bitable.base.onSelectionChange(cb)` | 监听表 / 视图切换 |
