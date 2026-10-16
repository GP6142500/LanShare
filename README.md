# LanShare · 局域网文件与文本互传

Windows 桌面应用：启动后在局域网内，其他设备用浏览器打开 `http://<本机IP>:<端口>` 即可互传文件与文本。中心辐射（hub-spoke）模型——Windows 主机运行服务，手机/笔记本/平板用各自浏览器访问，无需安装客户端。

当前版本 **v0.1.0**。控制面板「设置 → 关于」可查看版本号、构建时间、配置文件路径与程序路径。

## 技术栈

- **Tauri 2 + Rust**：原生窗口 + 系统托盘 + 内嵌 `axum` HTTP/WSS 服务
- **轻量前端**：零依赖原生 HTML/CSS/JS（遵循简洁现代、克制点缀色、暗/亮自适应的设计语言，无 emoji）
- 主机控制面板由 Tauri 资源服务加载；局域网客户端页面由 axum 直接内嵌服务

> 说明：UI 设计语言参考 `ui.md` 规范，但为保持轻量，未引入 Next.js/shadcn 构建链，改用零依赖原生实现。如需 shadcn 质感可后续替换前端。

## 功能

### 文件互传
- **双向传输**：设备 → 主机上传；主机「文件共享」→ 设备下载。落盘路径为 `<接收目录>/<上传者>/<8位id>__<原文件名>`
- **拖拽上传**：直接把文件拖到控制面板「传输」页即可上传，拖入时显示全屏遮罩提示
- **当前会话文件列表**（「传输」页）：只显示本次启动后上传的文件，重启后清空
- **历史文件管理**（「历史」页）：启动时扫描接收目录，列出全部历史文件（含往期），按时间从新到旧排列，并显示发送设备
  - 搜索框：按**文件名**或**设备名**实时过滤
  - 图标按钮：打开接收路径文件夹、清空所有文件（带确认）
  - 每行图标按钮：打开文件所在位置、删除文件（仅主机可用，点击整行可用默认程序打开）
- **接收目录可迁移**：在「设置」中修改接收路径时，已有文件会**自动移动**到新目录（保留上传者子目录结构；同名冲突自动加 `-1` 后缀不覆盖；跨盘符自动降级为复制+删除）
- **自动清理**：接收目录超过容量阈值（默认 2048 MB）时，启动时按最旧优先删除超过保留天数（默认 10 天）的文件；未超阈值的文件不删。阈值、天数、开关均可在「设置」中调整

### 文本同步
- **共享文本框**：所有端（主机 + 已连接设备）共用同一个文本框，任意一端编辑实时同步到其他端，无需发送/接收。支持图标式清空（带确认）与复制

### 连接与设备
- **设备配对（密码连接）**：主机设置一个 6 位连接密码；其他设备扫码/打开网址后输入密码即自动连接，无需主机审批
- **扫码免密**：二维码内含一次性令牌，手机扫码可直接连接、免输密码（令牌不落盘，换密码/刷新二维码即失效）
- **已连接设备**：「传输」页以小卡片展示，卡片右上角红叉可一键断开；「首页」底部同步展示，点击卡片直达「传输」页

### 设置即时生效
- **端口热切换**：修改端口**立即生效**，服务自动切到新端口并重连控制面板，无需重启软件
- **接收目录热迁移**：修改目录后已有文件立即迁移，无需重启

### 防火墙放行
- **自动检测**：启动时检测 Windows 防火墙是否已放行本程序，未放行时「首页」显示琥珀色提示条
- **一键放行**：点击后经 UAC 提权自动添加放行规则（覆盖域/专用/公用全部网络类型）
- **按程序放行，不绑端口**：规则绑定程序路径而非端口，因此**改端口、换网络都无需重新设置**
- **Profile 覆盖感知**：能识别「只给某一种网络类型放行」的情况（Windows 权限弹窗的常见陷阱），并在设置页提示

### 其他
- **服务开关**：控制面板「首页」可随时启动 / 停止局域网服务
- **二维码**：控制面板展示本机局域网地址二维码，手机扫码直达
- **接收目录**：可在「设置」中修改落盘路径（用系统原生文件夹选择器）
- **关于**：设置页底部展示版本号、构建时间、配置文件路径、程序路径

## 页面结构

| 页面 | 内容 |
| --- | --- |
| 首页 | 防火墙提示条（按需）、连接信息（局域网地址 + 二维码）、连接密码、服务开关、已连接设备小卡片 |
| 传输 | 已连接设备小卡片；左「文本同步」（共享文本框）、右「文件共享」（上传 + 当前会话文件列表）；拖拽上传遮罩 |
| 历史 | 接收目录全部历史文件的管理入口（搜索、打开目录、清空、删除、定位） |
| 设置 | 连接密码、服务端口、接收目录、历史文件自动清理、防火墙放行、关于（版本信息） |

## 数据与安全约定

- **路径不下发设备**：`/api/files` 仅对本机（loopback）返回磁盘路径与历史全量；局域网设备只拿到本次会话文件列表且不含路径
- **破坏性操作仅限本机**：删除单个文件、清空全部、修改设置均要求来自 loopback 且密码正确
- **令牌不下发设备**：扫码令牌仅 loopback 可读，且不落盘，只由二维码承载
- **历史可恢复**：重启后从磁盘扫描重建列表（上传者取自一级子目录名，文件名取自 `id__原名` 规则），无需持久化元数据

## 目录结构

```
lanshare/
├── src-tauri/            # Rust 后端 + Tauri 壳
│   ├── src/
│   │   ├── main.rs       # Tauri 入口：窗口 / 托盘 / 启动服务 / 注入端口 / 命令注册
│   │   ├── server.rs     # axum 服务：静态页 / 上传下载 / WS 文本 / 配对 / QR / 磁盘扫描 / 自动清理 / 端口热重启
│   │   └── firewall.rs   # Windows 防火墙检测 + 提权放行脚本生成
│   ├── web/
│   │   └── client.html   # 内嵌的局域网客户端页面（零依赖、自包含）
│   ├── icons/            # 应用图标
│   ├── capabilities/     # Tauri 权限
│   ├── Cargo.toml
│   ├── build.rs          # 注入构建时刻（供「关于」展示）
│   └── tauri.conf.json
└── frontend/             # 主机控制面板（Tauri 资源服务）
    ├── index.html
    ├── panel.js
    └── styles.css

LICENSE                   # MIT 许可证
e2e_*.mjs                 # 端到端测试脚本（Node，无需额外依赖）
verify_mask.html          # 拖拽遮罩的浏览器渲染验证页

# 不入库：scripts/release.sh（本地发版脚本）、.github-token（发版令牌）
```

## 构建与运行

前置：Rust 工具链（cargo 1.77+）、Node.js（含 pnpm/npm）、NSIS（用于 `nsis` 打包）、WebView2 运行时（Windows 11 自带）。

```bash
# 安装 Tauri CLI（若未装）
npm install        # 会安装 @tauri-apps/cli

# 开发模式（编译 Rust + 启动窗口）
npm run dev

# 打包为 Windows 安装包（nsis）
npm run build
# 或直接指定 bundle 类型（缺少 WiX 运行时则无法生成 msi）
npx tauri build --bundles nsis

# 运行后端单元测试（清理策略 / 磁盘扫描 / 目录迁移 / 防火墙脚本等）
cargo test --manifest-path src-tauri/Cargo.toml --bin lanshare
```

默认服务端口 `18765`，可在「设置」中运行期修改（立即生效）；也可改 `src-tauri/src/server.rs` 的 `config_dir()`/默认配置。

## 发布 Release

打包产物位于：

```
src-tauri/target/release/bundle/nsis/LanShare_<版本>_x64-setup.exe
```

发布到 GitHub Releases 有两种方式。

### 方式一：网页手动上传（最简单）

1. 打开 <https://github.com/GP6142500/LanShare/releases/new>
2. **Choose a tag** 填 `v0.1.0`（一般等于 `src-tauri/tauri.conf.json` 里的 `version`），点「Create new tag on publish」
3. 填标题，点 **Generate release notes** 自动生成变更说明
4. 把 `LanShare_0.1.0_x64-setup.exe` 拖进 **Attach binaries** 区域
5. 点 **Publish release**

### 方式二：脚本上传（本地脚本，不入库）

> `scripts/release.sh` 是**本地便利脚本，未纳入版本控制**（见 `.gitignore`）。克隆本仓库的人拿不到它，请走方式一，或按下方说明自行实现。该脚本的用法注释写在文件头部。

需要先生成一个 Personal Access Token（classic 勾 `repo`；fine-grained 勾 `Contents: Read and write`）：

<https://github.com/settings/tokens>

推荐把 token 写进项目根目录的 `.github-token`（已在 `.gitignore` 中忽略，不会入库，也不会留进 shell 历史）：

```bash
echo ghp_xxxxxxxx > .github-token
bash scripts/release.sh                    # 版本号自动从 tauri.conf.json 读取
bash scripts/release.sh 0.2.0 --draft      # 或指定版本 + 存为草稿
```

也支持环境变量 `GITHUB_TOKEN` / `GH_TOKEN`（优先于 `.github-token`）。

脚本行为：

- 调用前先自检 token（`GET /repos/:owner/:repo` 返回 200 才继续），权限不足会直接告诉你原因
- 创建 Release；若 tag 已存在则自动复用，不会重复建
- 上传前**按文件名精确匹配并删除同名旧资产**，所以同一个版本可以反复执行
- 最后打印资产的 `browser_download_url` 与 Release 页面链接

> 说明：脚本**不会**尝试从 git 凭据助手借用 token。GCM 在凭据库为空时会弹出图形授权窗口等待登录，在无终端环境里会永久挂起；宁可明确报错也不卡住。

> **注意**：创建 Release 与上传安装包是**两步**。只完成第一步会得到一个 `assets = 0` 的空 Release——Release 页面上看不到 setup.exe，就是这个原因。

发布前记得先把 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json` 三处版本号改成一致。

## 端到端测试

仓库根目录的 `e2e_*.mjs` 为 Node 脚本（无需额外依赖）：

```bash
EXE="C:\\path\\to\\src-tauri\\target\\debug\\lanshare.exe"

# 纯逻辑 / DOM 桩（不需要 exe）
node e2e_firewall_guard.mjs      # 防火墙检测与一键放行流程
node e2e_drop_upload.mjs         # 拖拽上传遮罩逻辑

# 需要真实 exe（会拉起服务、使用独立测试配置目录）
node e2e_upload_endpoint.mjs      "$EXE"
node e2e_port_hot_switch.mjs      "$EXE"
node e2e_restart_port_stable.mjs  "$EXE"
node e2e_scan_token.mjs           "$EXE"
node e2e_qr_and_client.mjs        "$EXE"

# 真实浏览器渲染（Edge headless + CDP，需要 file:// URL）
node e2e_firewall_render.mjs      "file:///.../frontend/index.html"
node e2e_about_render.mjs         "file:///.../frontend/index.html"
node e2e_drop_mask_render.mjs     "file:///.../verify_mask.html"
```

测试过程中生成的截图（`*-preview.png`）已加入 `.gitignore`，仅作本地人工核对用，不入库。

测试用 `LANSHARE_CONFIG_DIR` 环境变量把配置目录指向临时目录，因此**不会改动你的真实配置**。

## 默认路径与配置

- **接收目录**：`<系统下载目录>/LanShare`（跨机器可移植：优先系统报告的下载目录，回退 `%USERPROFILE%\Downloads`，最终回退系统临时目录）
- **配置文件**：`%APPDATA%\lanshare\config.json`（端口、密码、接收目录、自动清理策略）。新增字段均带 `serde(default)`，旧配置可直接升级。设置页「关于」卡片会显示实际路径

## 注意事项

- **防火墙**：首次运行 Windows 防火墙会弹窗询问，请允许**专用网络**；若不确定，直接点首页提示条的「一键放行」补齐全部网络类型（系统弹窗只会给当时所在的那一种网络类型加规则，换网络就会失效）。
- **多网卡**：若有多块网卡/虚拟网卡，控制面板会列出所有非回环 IPv4，请选择实际局域网那块。
- **剪切板**：当前为「文本传输」而非系统剪切板自动同步；如需一键写入系统剪切板需启用 HTTPS（自签证书），留待后续版本。
- **安全**：6 位连接密码阻止同网段误蹭；明文 HTTP 仅在可信局域网内使用，敏感场景建议后续启用 HTTPS。
- **接收目录中的其他文件**：历史页会扫描接收目录下的**所有**文件。直接放在根目录的文件会归为「未知」来源，因此建议不要往该目录另存无关文件。
- **打包**：`--bundles nsis` 生成 `.exe` 安装包；若要 `msi` 需先安装 WiX 运行时。

## 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。

```
Copyright (c) 2026 高鹏
```

你可以自由使用、修改、商用与再分发，只需保留版权声明与许可证原文。
