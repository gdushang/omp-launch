# omp-launch

给 [oh-my-pi (omp)](https://github.com/oh-my-pi) 加启动动画：启动时全屏播放一段视频，**只有一个动画、完整播完才显示首页**；默认按普通键即可提前跳过（`allowSkip`）。

## 这是什么

一段用你自己的视频做的开机动画，播放区域是整个终端。

- **两级渲染**：终端支持 **SIXEL** 时输出**像素级画面**；否则回退到**真彩半块字符**（`▀`/`█` + 24bit 前景/背景色）。两条路都铺满窗口，任意 truecolor 终端可用。
- **素材是你自己的视频**：放进配置目录，或用路径直接指定。**没有内置片库**——配置目录里没有视频就跳过动画、直接进首页（不算错误，也不会提示）。
- **启动几乎零等待**：SIXEL 走**预编码缓存**，命中时只读缓存文件（实测首帧 233ms），不解码也不编码；没有缓存则显示「正在预编码」并在后台编码，下次启动生效，`/launch encode` 可提前生成，设置面板里可清理。彩色块不走缓存，实时渲染。
- **只在交互式主会话播放**：`ctx.hasUI && ctx.agent.kind === "main"`，其余场合完全不介入。

## 安装

仓库地址：<https://github.com/gdushang/omp-launch>（public，默认分支 `master`）。两步：**装扩展**（把插件交给 omp）+ **装依赖**（`ffmpeg` / `ffprobe`，可选）。

### 用 omp 安装

```bash
omp install github:gdushang/omp-launch        # 从 GitHub 安装（等价：omp install https://github.com/gdushang/omp-launch）
omp install <仓库目录>                        # 从本地目录安装：link 语义，改目录即时生效
omp plugin list                               # 查看已装插件
omp plugin uninstall omp-launch               # 卸载（名称以 `omp plugin list` 输出为准）
```

- 目标可以是 GitHub 仓库（`github:user/repo`）、npm 包名（`pkg@1.2.3`）或本地路径；`omp install` 是 `omp plugin install` 的别名。
- 安装落在 `~/.omp/plugins/`（omp 维护的一个私有 npm 项目；`omp plugin doctor` 会打印它的位置）。
- `--scope project` 只对 marketplace 安装有效；`--dry-run` 只看动作不落盘。
- 只本次加载、不安装：`omp --extension <仓库目录>`；会话内 `/reload-plugins` 重载。

本扩展没有发布到 npm（`package.json` 里 `private: true`），所以只能从 GitHub 仓库或本地目录安装。

### 用包管理器装依赖

依赖只有 `ffprobe-static`（自带 ffprobe 二进制，随包分发，不需要下载）。在**仓库目录**执行、任选其一（仓库自带 `package-lock.json`）：

```bash
npm install          # npm
pnpm install         # pnpm
yarn install         # yarn
bun install          # bun
```

**ffmpeg 的来源顺序**（安装时与运行时用同一套判断）：

1. `FFMPEG_BIN` 环境变量指向的文件；
2. `PATH` 上的 `ffmpeg`；
3. `<配置目录>/bin/ffmpeg[.exe]`（第 4 步下载后的存放位置）；
4. 前三者都没有 → 安装时由 `postinstall`（`scripts/ensure-ffmpeg.mjs`）下载一次静态二进制到第 3 步的位置，约 36MB。可用 `FFMPEG_BINARIES_URL` 指向镜像源。

也就是说：**系统里已有 ffmpeg 就不会下载任何东西**；只想用系统 ffmpeg 也无需任何配置。

安装完成后 `<配置目录>`（`~/.omp/agent/launch/`，根路径可用 `PI_CODING_AGENT_DIR` 覆盖）会被自动创建，把视频放进去即可。

从 GitHub 安装时依赖由 npm 一并装好；**本地目录安装是 link**，不替源目录装依赖，需要在该目录自己先跑一次上面的命令。

## 使用

### 快速开始

四步跑通：装扩展 → 放素材 → 启动一次建缓存 → 之后每次启动自动播放。

**1. 装上扩展。**

```bash
omp install github:gdushang/omp-launch         # 从 GitHub 安装
omp install <仓库目录>                          # 或从本地目录安装（link，改动即时生效）
```

只想本次试一下、不安装：`omp --extension <仓库目录>`（这种方式不会创建配置目录，需要自己 `mkdir -p ~/.omp/agent/launch`）。

**2. 放素材。** 把你自己的视频（`mp4` / `mkv` / `webm` / `mov` / `gif` / `avi` / `wmv` / `m4v` / `apng` / `webp`）放进配置目录（安装时已自动创建）：

```bash
cp <你的视频> ~/.omp/agent/launch/
# Windows 上这个目录是 C:\Users\<你>\.omp\agent\launch\
```

也可以不放这里，改用路径指定（`launch.json` 的 `source` 或环境变量 `OMP_LAUNCH`，见「素材与配置」）。

**3. 启动一次，把缓存建起来。** 直接 `omp`。**第一次**在该终端尺寸下没有缓存，屏幕显示「正在预编码…」与实时进度条，编码结束即进首页（**本次不播素材**）；**之后每次启动**直接读缓存播放（实测首帧 233ms），完整播完才显示首页。

不想等这一次：先在会话里跑 `/launch encode`，下次启动就是缓存命中。换素材用 `/launch default <视频路径>`，会自动检查并后台补建缓存。

**4. 日常使用。** 见下表与「命令」「设置面板」。

| 想做的事 | 怎么做 |
|---|---|
| 跳过动画 | 按任意**普通键**（字母/数字/空格/回车/Tab）；方向键与 Esc 不算，切窗口不会误触 |
| 换默认素材 | `/launch default <视频路径>`（下次启动生效）；只从配置目录里挑：`/launch default auto` |
| 临时试播一个视频 | `/launch <视频文件>`，只播一次，不动配置 |
| 调画面/播放参数 | `/launch` 打开面板（方向键 + 回车，改动即时写入 `launch.json`） |
| 看当前状态 | `/launch info`：协议、窗口、cell、可用网格、素材、预编码缓存 |
| 提前生成缓存 | `/launch encode`（配置目录内全部 + 当前素材）或 `/launch encode <视频路径>` |
| 清理缓存 | 面板「清理预编码」，或直接删 `<配置目录>/cache/` |
| 关掉启动动画 | `OMP_LAUNCH=off`，或把 `launch.json` 的 `source` 设为 `"skip"` / `"builtin"` |

### 命令

| 命令 | 作用 |
|---|---|
| `/launch` | 打开设置面板（方向键 + 回车；预览即从此处播放） |
| `/launch settings` | 同上（等价写法，`/launch config` 同义） |
| `/launch list` | 列出配置目录里的视频文件 |
| `/launch info` | 当前协议、窗口、cell、可用网格、素材与预编码状态 |
| `/launch encode [路径\|all]` | 按**当前终端尺寸**预编码并写入缓存；不带参数或 `all` = 配置目录内全部视频 + 当前素材 |
| `/launch default` | 显示当前默认素材 |
| `/launch default <视频路径>` | 设为默认素材，下次启动生效（写入 `source`），并检查/补建它的缓存 |
| `/launch default auto` | 恢复自动：用配置目录内的首个视频 |
| `/launch <视频文件>` | 只临时播一次，不动配置 |

配置写进当前生效的 `launch.json`（项目目录优先，都不存在时创建 `~/.omp/agent/launch/`），只覆盖 `source` 一个键，其余字段保持原样。

### 设置面板

`/launch` 打开交互式面板：方向键移动、回车切换值或进入子菜单、Esc 退出，改动即时写入 `launch.json`。

| 分组 | 项 | 形式 |
|---|---|---|
| 素材 | 默认素材 | 子菜单：列出配置目录里的视频与当前素材，选定即成为默认 |
| 素材 | 预览 | 子菜单：选定后关闭面板并立刻播放一次，不改默认值 |
| 素材 | 裁剪方式 | 循环切换：保持宽高比 / 居中 / 方向裁剪 |
| 画面 | 渲染协议 | 循环切换：自动 / SIXEL / 彩色块 |
| 画面 | 帧率上限、单帧像素上限、帧内存预算、播放时最大化窗口 | 循环切换 |
| 画面 | 清理预编码 | 子菜单：确认清理 / 取消（行上显示当前缓存文件数与体积） |
| 播放 | 按键可跳过、循环次数、接管内置动画 | 循环切换 |

改「默认素材」会自动检查该视频的预编码缓存并后台补建；改「裁剪方式 / 渲染协议 / 帧率上限 / 单帧像素上限 / 播放时最大化窗口」会让已缓存的序列不再匹配，面板会提示重新编码（这些字段都写进缓存键）。

裁剪方式（`fit`）三种取值：

| 值 | 面板名 | 行为 |
|---|---|---|
| `contain` | 保持宽高比（默认） | 等比缩放至完整可见，宽度拉满，多余空间留在下方 |
| `contain-center` | 居中 | 同上，但多余空间上下均分 |
| `cover` | 方向裁剪 | 等比放大到铺满窗口，超出部分裁掉（ffmpeg `scale=…:force_original_aspect_ratio=increase,crop=…`） |

## 素材与配置

插件只播**你自己的视频文件**（没有内置片库）。

配置目录按顺序找：`<cwd>/.omp/launch/`（项目，存在即用）→ `~/.omp/agent/launch/`（用户；用户目录根可用 `PI_CODING_AGENT_DIR` 覆盖）。写配置时也写进当前生效的目录，都不存在则创建用户目录。

素材来源按优先级：`launch.json` 的 `source` → `OMP_LAUNCH` 环境变量 → 配置目录内首个视频文件（按文件名排序）→ **没有素材就跳过启动动画**（直接进首页，不播任何东西）。

- `source` 写具体文件时的解析规则：`~` 展开；含 `/` 或 `\` 视为路径（相对路径相对当前工作目录），不含分隔符则当作配置目录内的文件名；文件不存在或不是已知视频扩展名即视为无效，退回下一个来源。
- **写了 `source` 就不再读 `OMP_LAUNCH`**；`source: "auto"` 同样屏蔽它，此时取配置目录内的首个视频。
- `source: "builtin"`（或 `"skip"`）是显式的"不播动画"写法；`OMP_LAUNCH=off`（或 `0` / `false` / `none`）直接关闭插件，优先于其他设置。

`launch.json`：

```json
{
  "source": "auto",
  "protocol": "auto",
  "fps": 60,
  "maxPixels": 0,
  "resizeWindow": true,
  "fit": "contain",
  "maxFrames": 900,
  "frameBudgetMb": 512,
  "loop": 1,
  "waitMaxMs": 15000,
  "allowSkip": true,
  "takeover": true
}
```

| 字段 | 说明 |
|---|---|
| `source` | `auto`（默认，取配置目录里首个视频）\| `builtin` / `skip`（都不播，直接进首页）\| 视频文件路径 |
| `protocol` | `auto`（静态终端表 → Windows Terminal 判定 → XTSMGRAPHICS 探测）\| `sixel` \| `blocks`（强制彩色块）。只支持这两种渲染路径 |
| `maxPixels` | 单帧渲染像素上限，默认 `0`（不限制 = 按窗口）。只决定帧缓冲的分辨率与内存，**不参与布局**：画面始终按 `fit` 铺满窗口，低于窗口分辨率的帧被放大显示 —— 设 480p 得到整窗 480p 清晰度，而不是一个 480p 的小画面。SIXEL 下逐像素流量仍按窗口像素（每帧约 2.0MB、24fps 约 47MB/s，见"分辨率"） |
| `fit` | `contain`（默认，完整画面顶部对齐）\| `contain-center`（完整画面居中）\| `cover`（放大铺满并裁掉超出） |
| `fps` | 帧率上限（默认 `60`，`0` 等同 `120`）；实际播 `max(24, min(上限, 源帧率))` |
| `resizeWindow` | 播放时按屏幕像素最大化窗口，播完还原（默认 `true`） |
| `maxFrames` | 帧数上限，达到即终止 ffmpeg |
| `frameBudgetMb` | 解码帧常驻内存预算（MB，默认 512）；超预算自动降帧率 |
| `loop` | 循环次数 |
| `waitMaxMs` | 素材首批帧超过这个时间仍未就绪，本次直接跳过启动动画（默认 15000）；就绪之前画面为空 |
| `allowSkip` | 默认 `true`（按普通键即可跳过）。跳过只认**普通键**（字母/数字/空格/回车/Tab）；方向键与 Esc 属于转义序列，与终端焦点事件、鼠标事件、启动查询的回复一样不算按键，避免切窗口就把动画掐掉 |
| `takeover` | 检测到 `startup.showSplash: true` 时用 `omp config set` 关掉内置动画，避免连播两段 |

`OMP_LAUNCH=off` 禁用；`OMP_LAUNCH=<path>` 直接指定视频（`launch.json` 里写了 `source` 时不生效）。

## 分辨率

| 渲染路径 | 画面分辨率 | 前提 |
|---|---|---|
| **SIXEL** | **窗口宽度 × (宽度/源宽高比)**：宽度拉满，高度自适应并锁比例；再次按 `maxPixels` 压到帧缓冲上 | 终端支持 SIXEL |
| 彩色块（`▀`+24bit 色） | 窗口列数 × 行数×2 | 任意 truecolor 终端 |

`maxPixels`（面板里的"单帧像素上限"）**只压帧缓冲，从不参与布局**：显示网格永远按 `fit` 铺满窗口，低于窗口分辨率的帧由 SIXEL 编码侧放大到整块网格。所以 `480p` 的观感是**整窗 480p 清晰度**，不是一个 480p 的小画面。

SIXEL 的代价：协议里没有缩放原语，放大只能发生在编码侧，逐像素流量仍按窗口像素（1790×1007 每帧约 2.0 MB，实测）。`maxPixels` 在这里只省解码内存与清晰度上限（源片分辨率以下才看得出差别）；要降播放负载与缓存体积请调 `fps`、缩小窗口，或把终端字体调**大**（字体小 → 列数多 → 像素更多）。

彩色块不是调参能救的：ANSI 里一个字符位置只有前景/背景两种颜色，`▀` 半块已经把两个亚像素各给了一整条 24bit 色，**颜色上无损**，瓶颈只在网格密度（179×52 的窗口 = 178×100 逻辑像素，对 1280×720 差 50 倍）。所以提高分辨率只有两条路：SIXEL，或更大的网格。

`protocol: "auto"` 只判定 SIXEL 与彩色块：

1. omp 的静态终端表或 `PI_FORCE_IMAGE_PROTOCOL` 已把 `TERMINAL.imageProtocol` 定为 SIXEL → 直接用；定为其他协议（Kitty / iTerm2）会被清掉，因为本插件只剩 SIXEL 与彩色块两条渲染路径；
2. Windows Terminal（`WT_SESSION`）→ 直接采用 SIXEL：1.22 起内置，但 1.24.11911.0 既不设 `TERM_PROGRAM_VERSION`、也不回 XTSMGRAPHICS，而 DA1（它确实报 attribute 4）被 `ProcessTerminal` 吞掉，`WT_SESSION` 是唯一剩下的信号；
3. 否则发 **XTSMGRAPHICS** `CSI ? 2;1;0S`（应答 `CSI ? 2;Ps;PvS`，`Ps=0` 且有非零几何即支持）；
4. 都不成立 → 彩色块。

不用 DA1（`CSI c`）：omp 的 `ProcessTerminal` 会吞掉整场会话的所有 `CSI ? … c` 回复，字节永远到不了输入监听器，DA1 探测必然失败。

窗口会先按屏幕像素最大化（`CSI 14 t` 查询 + `CSI 8 t` 调整，**播完还原**）。画面按窗宽拉满、高度 = 宽度 / 源宽高比，窗口比源大就放大，比例始终锁在源上。cell 像素尺寸由 `CSI 14 t` 的像素值除以实测列/行反推（而不是用 omp 的 9×18 估计值），否则会请求一个屏幕装不下的网格、被终端静默拒绝；实测值同时写回 pi-tui 的 `setCellDimensions()`，它据此计算图像适配，停留在 9×18 会把画面按错误比例压小。SIXEL 的行由插件自己拼（直接调 pi-tui 的 `renderImage`，见 `sixelFrameLines`）。行数只留 1 行余量，避免满高画面把终端顶出滚动。

一处已知的舍入：SIXEL 以 6 像素为一带，最终高度会向上取整到行边界（例如 1790×1007 → 1790×1020），纵向约有 1% 的轻微拉伸。要精确比例就只能让宽度退让，与"宽度拉满"冲突。

若 `protocol: "auto"` 落到彩色块（`/launch info` 显示"无（彩色块）"）：

1. 强制试一次：`{"protocol": "sixel"}`，或环境变量 `PI_FORCE_IMAGE_PROTOCOL=sixel`（omp 原生开关，`off`/`none` 关闭图形协议）
2. 仍不行说明该终端不支持 SIXEL —— 换 Windows Terminal 1.22+ / WezTerm / kitty / Ghostty，或接受彩色块（可叠加缩小终端字体来提升：cell 变小 → 同屏行列更多 → 分辨率上升）

## 帧率

帧率**跟随视频原始帧率**：24fps 片源播 24，240fps 片源播 60（上限默认 `60`），**任何情况都不低于 24**。解码帧常驻内存有预算，但预算只作安全阀——真到不了就自动降帧率（同样不低于 24）、绝不缩短时长，原因写进日志 `notes`。

- 预算：`{"frameBudgetMb": 512}`（默认 512 MB，实际只是安全阀）。SIXEL 按渲染分辨率（受 `maxPixels` 限制）常驻整帧，编码后每帧约 2.0 MB（1790×1007 窗口像素口径），169 帧约 334 MB——播放结束即回收（解码出的 PNG 要等后台编码全部完成才释放）
- 固定帧率：`{"fps": 12}`
- 帧数上限：`{"maxFrames": 900}`（达到即终止 ffmpeg，会缩短总时长）

## 预编码缓存

启动只读预编码文件：命中就直接播（不解码、不编码），没有则显示提示并在后台编码，**下次启动生效**。

| 项 | 说明 |
|---|---|
| 位置 | `<配置目录>/cache/<素材tag>-<键hash>.seq`（项目 `.omp/launch/cache/`，否则 `~/.omp/agent/launch/cache/`） |
| 体积 | 整段 SIXEL 序列（每帧 4 字节长度前缀 + UTF-8），179×51 网格、169 帧实测 **334MB**；同一素材只保留一份，重新编码替换旧的 |
| 键 | 源文件路径 + 大小 + mtime + 帧率 + 渲染分辨率 + 显示网格（列×行）+ cell 像素 + 裁剪方式 |
| 失效 | cell 由 `CSI 14 t` 实测、网格来自实际窗口。换终端、改字体、改窗口大小、改 `maxPixels`/`fit`/`fps`、换素材文件都会 miss 并重新编码；`resizeWindow` 开启时每次最大化到同一形状，键才稳定 |
| 写入 | 先写 `.seq.tmp` 再改名；读取时校验魔数、格式版本与键，截断或损坏的文件直接删除 |
| 生成 | `/launch default <视频>` 选定后检查并后台补建；`/launch encode [路径\|all]` 手动编码；启动缺缓存时也会自动后台编码 |
| 范围 | 只对 SIXEL 生效；彩色块没有缓存，仍走实时渲染 |

## 时序：首帧之前的等待

omp 在 `InteractiveMode.init` 里**先画首页**（`interactive-mode.ts:1767`），**之后才初始化扩展并 emit `session_start`**（`:1871`）。插件只能把窗口压到最小：`session_start` handler 里任何 await 之前就挂 fullscreen overlay（借 alt screen 遮住首页），探测/调窗口/读缓存/解码/编码都在 overlay 内部完成。观感为「开机 → 首页闪现极短一瞬 → 视频（完整）→ 首页」。彻底消除需要 omp 把 `suppressWelcomeIntro` 暴露给扩展。

overlay 挂上到首帧出现之间屏幕是空的，所以这段等待要短。三条路径：

- **命中缓存（启动）**：探针 + 协议/窗口探测 + 顺序读缓存文件，没有解码、没有编码、没有 worker。179×51 网格实测**首帧 233ms**。
- **未命中缓存（启动）**：本次不播素材。overlay 显示「正在预编码…」与实时帧进度条，**持续到编码真正结束**（实测约 6s；解码阶段显示「正在解码素材…」），结束显示完成/失败后再进入首页。编码一开始还会发一条通知，所以按普通键提前进首页时也知道后台在跑。
- **预览与试播**（`/launch` 面板的预览、`/launch <视频文件>`）：走实时路径——解码后**只等 SIXEL 首批 16 帧**就开播，其余帧在播放中续编。编码落后播放头时重复最新已就绪的一帧，不闪黑也不停住；播放结束、按键跳过或 overlay 卸载会立刻终止仍在跑的 worker。

179×51 网格、169 帧 1280×720 的实时路径实测：探针 60ms、解码 562ms、首批编码约 0.5s，首帧约 1.2–1.5s（改动前全量预编码 6.2s）；后台编码 4.8–5.2s 完成，片长 7.1s，所以播放期间不会断帧。日志：`notes` 的 `首帧耗时`、`omp-launch: playback` 的 `mode`/`path`、`omp-launch: SIXEL 编码完成`、`omp-launch: 预编码完成`。

## 排错

| 现象 | 处理 |
|---|---|
| 画面是灰度/黑白 | 说明终端没有按 24bit 解色。确认 `COLORTERM=truecolor`；Windows Terminal 默认满足 |
| 画面不够清晰 | 先看「单帧像素上限」是否被设成了 720p/480p——那是主动降渲染分辨率；再看 `/launch info` 的"可用网格"：若远大于当前窗口，说明终端不支持 `CSI 8 t` 放大窗口；此时缩小终端字体最有效 |
| 播放卡顿 | 降 `{"fps": 8}`；每帧体积随 列×行 增长。SIXEL 下调「单帧像素上限」只能省内存，逐像素流量仍按窗口像素（见"分辨率"） |
| 窗口没被调整 / 播放后没还原 | 终端不支持 `CSI 8 t`（无副作用）；还原值以播放前记录的尺寸为准 |
| 没有播放动画 | 配置目录里没有视频 → **按设计跳过**（`/launch list` 看清单）；或插件没装（`omp plugin list` 查看，`omp install <仓库>` 安装）；或 `OMP_LAUNCH=off`；或素材解码失败（看日志 `notes` 与 `outcome: failed`） |
| 启动只看到「正在预编码」 | 该终端尺寸还没有缓存：编码完成后**下次启动**直接播放；想提前生成用 `/launch encode`，或在 `/launch default` 换素材时自动补建 |
| 每次启动都在重新编码 | 窗口/字体/分辨率变了就换键：固定窗口大小，或开 `resizeWindow` 让它每次最大化到同一形状；`/launch info` 看当前网格与 cell |
| 缓存占空间 | 每素材一份、实测约 334MB（179×51 网格、7s）：在设置面板「清理预编码」里删，或删掉 `<配置目录>/cache/`，下次启动会重新编码 |

每轮决策写进日志，搜 `~/.omp/logs/` 里的 `omp-launch: playback`：
含 `path`（`cache`/`image`/`notice`/`blocks`）/ `outcome`（`played`/`skipped`/`failed`）/ `mode`（`cache`/`live`）/ `grid` / `frameMs` / `configuredFps` / `resized` / `notes`（含窗口与像素探测结果）；预编码与播放结束另有 `omp-launch: 预编码完成`、`omp-launch: SIXEL 编码完成`、`omp-launch: 播放结束`（`reason` = `duration`/`skip`/`wait`/`empty`/`settled`）。

## 行为边界

- 仅交互式主会话播放：`ctx.hasUI && ctx.agent.kind === "main"`。
- 素材预解码进内存（`maxFrames` + `frameBudgetMb` 上限，超预算自动降帧率而不是缩短时长）。
- 半块像素是正方形（cell 9×18 → 半块 9×9），因此按 cell 网格缩放即可保持视频比例，无需额外校正。
- 定时器走 `ctx.setTimeout` / `ctx.clearTimer`，`dispose()` 幂等清理。

## 结构

```
src/index.ts        扩展工厂：协议判定、窗口探测、解码、播放、/launch
src/window.ts       窗口网格规划、帧几何（显示网格 / 渲染像素）、应用与还原
src/player.ts       overlay 播放组件（等待期→播放、可选跳过、幂等 dispose）
src/sixel-pool.ts   SIXEL 编码池：worker 逐帧回传、首批即播、结束即停
src/sixel-worker.ts 编码 worker（逐帧回传，动态导入宿主 pi-tui）
src/video-cache.ts  预编码缓存：键、二进制格式、原子写、损坏即弃
src/video-frames.ts ffmpeg → PNG 帧
src/color-blocks.ts ffmpeg → RGB → 真彩半块行
src/probe.ts        ffprobe 探测宽高/帧率/时长
src/config.ts       配置与素材发现（含写回）
src/settings.ts     交互式设置面板（SettingsList 主菜单 + SelectList 子菜单）
src/ffmpeg.ts       ffmpeg 路径解析（FFMPEG_BIN → PATH → 安装时下载的副本）
scripts/ensure-ffmpeg.mjs  postinstall：前三处都没有 ffmpeg 时才下载静态二进制
```

开发与验证约定（模块分层、哪些模块能离线跑、改动的验证阶梯）见 [`AGENTS.md`](AGENTS.md)。
