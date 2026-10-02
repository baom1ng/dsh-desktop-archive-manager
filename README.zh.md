# dsh-desktop-archive-manager（归档管理器）

[English](README.md) | 中文

给 DeepSeek Harness 桌面端补上「管理归档」的能力：**浏览已归档的会话，并把它们从磁盘上永久删除**。

> 现状：DSH 自带归档（Archive）但从未提供删除。官方 `ui-workspace` 的已知限制里写着
> “No Session deletion — sessions can be archived but never deleted”。
> 本插件就是这个缺口的补丁。

这是一个**可安装的 DSH bundle 插件**：自带补丁层与浏览器端，通过 Plugin Manager / `dsh plugin` 安装，
不需要手改配置档。

**平台：仅 DeepSeek Harness Desktop。** 这是桌面端的归档界面，所以 bundle 补丁里的行带
`disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`——在 `web`/`headless`/`tui` 等其它配置档中
本插件不会装载任何东西（而不是留一个等待 webserver 的行）。桌面端是唯一目标环境。

---

## 1. 安装与卸载

### 一体化入口：设置 → 插件 → 本地插件（推荐）

本机装了配套的 **本地插件源**（`dsh-local-plugin-source`）：它把
`%USERPROFILE%\.dsh\local-plugins` 变成应用内的插件源。打开
**设置 → 插件 → 本地插件**，对列表里的 `dsh-desktop-archive-manager` 点：

- **安装 / 重新安装** —— 安装并启用（改了源码后点它即可让新版本进入 profile）；
- **停用 / 启用** —— 只切换 bundle 层选择，依赖与磁盘文件保留；
- **卸载** —— 走 pnpm remove。

也就是说：**卸载之后随时都能在应用里一键装回来**，不需要命令行，也不需要 Agent。

### 从路径安装（等价的手动方式）

桌面配置档由应用独占管理（CLI 明确拒绝 `--profile desktop`），手动装法有二：

1. 侧边栏 **插件 → 添加插件**，粘贴本地绝对路径 `C:\Users\Administrator\.dsh\local-plugins\dsh-desktop-archive-manager`；
2. Agent 侧的 `plugin_manager` 工具：`install_bundle(target: "C:\\Users\\Administrator\\.dsh\\local-plugins\\dsh-desktop-archive-manager")`。

安装器会：`pnpm add <绝对路径>` → 校验包里的 `dsh.bundle.patch` → 把包名追加进
`<profile>/package.json` 的 `dsh.profile.bundles` → 立刻重组并生效（无需重启）。
本机安装后的事实：

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\package.json
"dsh": { "profile": { "bundles": [ ..., "dsh-desktop-archive-manager" ] } },
"dependencies": {
  "dsh-desktop-archive-manager": "link:C:/Users/Administrator/.dsh/local-plugins/dsh-desktop-archive-manager"
}
```

### 其它配置档 / 发布到 npm 之后

```text
dsh plugin --profile <web|tui|headless|...> add <绝对路径或包名>
dsh plugin --profile <web|tui|headless|...> remove dsh-desktop-archive-manager
```

`dsh plugin` 会把 `add`/`remove`/`list` 等参数原样转给 pnpm，因此本地路径、tarball、git 地址、
registry 包名都能装；桌面配置档除外（见上）。

### 卸载

在**设置 → 插件 → 本地插件**里点卸载，或侧边栏插件页卸载：移除 bundle 选择 → 卸载 Loader 行 → `pnpm remove`。
插件不写全局状态，卸载后无残留（唯一的外部痕迹是它删除过的会话本身）。

## 2. 用户看到的界面

| 位置 | 内容 |
|---|---|
| 侧边栏底部面板图标（`sidebar.panellist`，order 30） | 新增「归档」图标，点开即归档管理面板 |
| 主面板（`main`，key `archive-manager`） | 归档列表：搜索、全选、批量恢复 / 批量删除、单行恢复 / 删除、占用空间合计 |
| 会话行「…」菜单（order 900） | 已归档的会话多一项「永久删除」 |
| 全局浮层（`shell.overlay`） | 删除确认框（需勾选确认）＋ 结果提示 |

中英双语，随界面语言切换（locale 命名空间 `archive-manager`）。

## 3. 删除到底删了什么

对每个会话，主机端只做三件事：

1. **会话日志目录**：`<root>/<项目目录>/<sessionId>/`（含该会话的全部格式世代，例如
   `session.v4.jsonl.zstd`、`.v3`、`.v2`…）。路径由持久化后端自己的 `locate()` 给出；
   后端不支持时退回扫描 `<root>/*/<sessionId>/`。
2. **投影缓存记录**：`session_projcache` 域中该会话那一条，通过 `ctx.storageDomain` 的域 API 删除。
3. **归档标记**：从 `workspace.json` 的 `archivedSessionIds` 中移除，并触发侧边栏刷新。

其它任何东西都不动：项目目录、其它会话、附件、工作区记录保持原样。

### 安全闸门

- 只接受**当前已归档**的会话 id，否则 `archive-manager/not-archived`；
- 会话 id 必须是单段安全字符（正则 + 拒绝 `..`），杜绝路径穿越；
- 有运行中工作的会话拒绝删除（`workspace/session-activity` + Agent 状态双重检查）；
- 接口只注册一条精确路由，做同源校验（Origin + 自定义请求头），不触碰 `/api` 信任边界。

## 4. 「仍在内存中」的会话

某个会话可能在**本次运行**中创建或打开过，于是进程里还活着（Agent/Session 在内存、写句柄仍持有）。
此时删文件可以做到，但列表行无法立刻消失；如果解除归档，它还可能被再次唤醒。

| 会话状态 | 行为 |
|---|---|
| **冷会话**（本次运行未使用） | 删文件 → 删缓存 → 移除归档标记 → **列表行立刻消失** |
| **活跃会话**（仍在内存中） | 删文件 → 删缓存 → **保留归档标记**（归档闸门继续挡住新回合）→ 行留在归档视图并标注「已删除 · 待重启清理」 |

插件在每次启动时执行一次 `prune`：清掉「既没有磁盘日志、进程里也没有它」的归档标记，
活跃会话留下的痕迹会在**下次启动时自动消失**。

## 5. 包结构

```text
dsh-desktop-archive-manager/
├── package.json          # dsh.bundle.patch + dsh.client（同一个包两半都在）
├── cordis.patch.yml      # bundle 补丁层：插入一条 desktop-archive-manager 行（desktop 限定）
├── lib/host.js           # 主机端：Cordis 插件 + POST /archive-manager/api
├── lib/client.js         # 浏览器端：预构建的 __ModuleLoader__ 包
├── lib/core.js           # 无依赖的删除内核（可单测）
├── test/*.test.mjs       # node --test 套件（38 项）
├── LICENSE
└── README.md / README.zh.md
```

关键声明：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": [], "external": [] }
}
```

- `dsh.bundle.patch` 让包成为一个 bundle：安装器把它列进 `dsh.profile.bundles`，并按其补丁层插入行。
- `dsh.client`（+ `exports["./client"]`）让**同一条行**同时拥有浏览器端：
  client-modules 扫描已启用的 Loader 行，发现该包声明后即提供 `lib/client.js`。
  因此主机端与浏览器端来自同一个包、同一个版本。

## 6. 主机端接口

一条精确路由：`POST /archive-manager/api`，请求体为 JSON 对象，
响应统一 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。

| `op` | 请求 | 返回 |
|---|---|---|
| `list` | — | 每个归档会话：id、创建时间、工作目录、归属工作区、日志目录、文件数、字节数、是否在内存中、是否需要重启清理 |
| `plan` | `sessionId` | 只检查与统计，**不删任何东西**（界面用它展示「将要删除的路径」） |
| `delete` | `sessionId` | 删除结果（`removed/bytes/files/projectionCache/live/pendingRestart/remaining`） |
| `deleteMany` | `sessionIds[]` | 逐项结果 + 剩余归档集合（单项失败不影响其它项） |
| `prune` | — | 清理没有任何存储痕迹的归档标记 |
| `status` | — | 路由、存储根目录、当前归档集合（自检用） |

## 7. 次要开发约定（改这个插件前先看）

- **注入面（inject face）的 `hooks` 会被渲染器摊平**：`inject: () => ({ hooks: { archives } })`
  投影到组件上的是 **`useArchives`** 这个选择器 Hook（`ui-renderer` 的 `bindInjectSources`），
  `hooks` 键本身会被丢掉。写成 `props.hooks.archives` 会在渲染时直接抛错，
  并被 SlotErrorBoundary 记为「abdicate」，表现为该座位**静默消失**。
  自定义来源请起不会与宿主标准 Hook 冲突的名字（本插件用 `archiveWorkspaces`/`archiveSessions`，
  因为 `shell.overlay`、`main` 等座位本身就带标准 `useWorkspaces`/`useSessions`）。
- 浏览器端是**预构建包**，不经过打包器：只用平台种子表内的模块
  （`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`）。

## 8. 自测

```powershell
# 在包目录下
& "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" --test "test/*.test.mjs"
```

38 项覆盖：删除内核（路径穿越、只删目标会话、兄弟目录保留）、主机端
（冷删 / 活跃策略 / prune 三判定 / 请求闸门 / 批量部分失败）、浏览器端
（槽位注册、host 调用封装、失败与「待重启」提示、恢复流程），以及**渲染测试**：
把注册面按渲染器的真实投影规则摊平成 props 再渲染组件，正是这项测试抓出了上面第 7 节的注入面契约 bug。

## 9. 已知限制

- **活跃会话的列表行要等重启**：DSH 没有公开的「按 id 释放 Agent/Session」接口，插件不越界去
  dispose 别的插件的 fiber；重启后进程不再持有它，行随之消失（标记也会被 `prune` 清掉）。
- **只删会话自身**：不级联删除该会话派生的子代理会话（它们各自是独立会话）。
- **内容索引不在清理范围**：本配置档的会话检索索引是 `:memory:`（`openAt: never`），无需清理；
  若部署改用磁盘索引，重启后重建即可，插件不直接操作它。
- 删除**不可撤销**：界面因此要求显式勾选确认，并在确认框里列出每个会话的日志目录。
