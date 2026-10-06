# dsh-splash-animation（改动版）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一段**自定义开屏动画**：启动时播放你选的视频或动图，播完渐隐，露出 DSH 界面。

> **这是 [`KDDKBD/DeepSeek-splash-animation`](https://github.com/KDDKBD/DeepSeek-splash-animation) 的 fork。**
> 底子（客户端模块形态、媒体解析、Range 流式传输、自带默认视频）全部来自上游；本仓库在它之上做了几件上游当时没做的事。**先说清楚哪些是我们加的**，别把功劳记错人——见下面的[这个 fork 多了什么](#这个-fork-多了什么)和[致谢与来源](#致谢与来源)。

**这一版最大的不同，是不再让你手动填一个视频路径。** 指一个文件夹，插件列出里面所有能播的东西，你打勾选，每次启动从勾里的随机挑一个。

---

## 这个 fork 多了什么

| | 上游 | 本仓库 |
|---|---|---|
| 选素材 | 手填**一个**视频/动图的完整路径 | 指定一个**文件夹**，插件列出里面能播的，**打勾**选择 |
| 多段素材 | 只能播那一个 | **随机播放**：每次启动从打勾的里面挑一个 |
| 空选择 | — | **一个都不勾 = 不播放**，DSH 直接启动（不会被当成"全选"，也不会退回自带视频顶替） |
| 旧配置 | — | 以前存的单个路径会**自动**解成「文件夹 + 它自己已打勾」，升级不像丢数据 |
| 片尾过渡 | 播完 → 停住 → 再淡出 | 可选**片尾交叉溶解**：界面在影片还在演的时候就透出来，交接正好落在最后一帧 |
| 启动窗口 | 保持上次大小 | 可选**启动时最大化**（Windows） |
| 跳过 | 右下角一个「跳过」按钮 | 可改成**点画面任意位置跳过**，底部只留一条淡色提示 |
| 设置入口 | 设置 →「内置插件」里的一个标签页 | 设置**左侧栏独立入口**，和「皮肤」那些同级 |
| 开屏全屏 | `splashFullscreen` 开关 | **已移除**——见[为什么](#关于开屏全屏它被删掉了) |

---

## 安装

从本仓库装（会**取代**上游插件，两者是同一个包名，不要同时装）：

```bash
dsh plugin --profile <你的 profile> add github:tenebris173/DeepSeek-splash-animation
```

装完**重启 DSH**。新插件的浏览器半要重新进模块图，只刷新页面不够。

手动装也可以：把本目录放进 profile 的 `node_modules`，`package.json` 里加依赖、`dsh.profile.bundles` 里加 `dsh-splash-animation`，然后 `pnpm install`。

---

## 用起来是什么样

**设置 → 开屏动画**（左侧栏独立入口）：

```
素材文件夹    C:\Users\你\.dsh\dsh-splash-animation\media        [选择文件夹…]

文件夹里的素材                          已勾选 2 / 共 4   [刷新]
 ┌────────────────────────────────────────────────────┐
 │ ☑  开头.mp4                视频 ·   8.0 MB          │
 │ ☑  备用.webm               视频 ·  10.6 MB          │
 │ ☐  节日.gif                动图 ·   2.4 MB          │
 │ ☐  长的那个.mp4             视频 ·  21.9 MB          │
 └────────────────────────────────────────────────────┘
 打勾的会参与开屏播放；一个都不打勾就不播，DSH 直接启动。点整行即可切换。

 ☑ 随机播放        每次启动从打勾的里面随机挑一个
 ☑ 片尾交叉溶解     界面在影片还在演的时候就透出来
 ☑ 启动默认最大化    应用启动时把窗口最大化（仅 Windows）
```

点「**选择文件夹…**」直接开在那个素材文件夹上（没配过的话，开在插件推荐的 `$DSH_HOME/dsh-splash-animation/media`）。往文件夹里丢进新文件后点「**刷新**」，不用重启。

**推荐把素材放这里**：

```
$DSH_HOME/dsh-splash-animation/media/
```

`$DSH_HOME` 就是 DSH 的数据目录（Windows 上通常是 `C:\Users\你\.dsh`）。

> ⚠️ **别把素材放进 `node_modules`。** 那里面的一切都可能被包管理器在下次安装时整个重建——放进去的视频会**直接消失**。这个坑我们踩过两次。

---

## 配置

两个入口，**设置页的值优先**（设置页写的是 `$DSH_HOME/dsh-splash-animation/config.json`，profile 的 patch 行是默认值）：

```yaml
# profile 的 cordis.patch.yml
- id: dsh-splash-animation
  config:
    folder: C:/Users/你/.dsh/dsh-splash-animation/media
    random: true
    tailDissolve: true
    startMaximized: true
    skip: click
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `folder` | 未设置 | 素材文件夹。**没设置时**退回 `src`（旧版的单一路径），再退回插件自带的那段视频 |
| `selected` | `[]` | 打勾的**文件名**（不是路径，所以整个文件夹改名搬家都不会失效）。**空 = 不播** |
| `random` | `false` | 从打勾的里面随机挑；关闭时播列表里第一个 |
| `tailDissolve` | `false` | 片尾交叉溶解 |
| `startMaximized` | `false` | 启动时最大化窗口（仅 Windows） |
| `skip` | `button` | `button` / `click` / `auto` / `never`，见下 |
| `skipAfterMs` | `1200` | `skip: auto` 时多久自动跳过 |
| `src` | 未设置 | 旧版的单一路径。一旦配了 `folder` 就会被清空——文件夹取代它 |

### 跳过方式

| 值 | 行为 |
|---|---|
| `button` | 右下角一个「跳过」按钮（上游默认） |
| `click` | **点画面任意位置跳过**，底部只留一条淡色提示 |
| `auto` | `skipAfterMs` 之后自动跳过 |
| `never` | 不能跳过 |

`click` 模式下那条底部提示设了 `pointer-events: none`——否则它横在底部，会把"点击任意位置"的那次点击**自己吃掉**。

### 片尾交叉溶解

关闭时是上游原有行为：整段播完、停在最后一帧、过 `holdAfterEndMs` 之后开始淡出，界面要等影片结束后再过 `fadeOutMs` 才完全露出来。

打开后改成边播边溶解：淡出提前 `fadeOutMs` 开始，影片最后一帧出现的那一刻交接正好完成。观感上不再是「播完 → 黑一下 → 界面」，而是一段连续过渡。

计时按 `duration`（若设了更短的上限就以它为准）和 `playbackRate` 一起算，2 倍速时等待时间减半，所以交接仍落在影片真正的最后一帧。`maxReplays > 0` 时不生效，避免截断重播。

---

## 说在前面的几处笨拙

这一节是故意留的：下面几件事不是"还没做"，是**做法本身有代价**，你应该先知道再用。

### 关于开屏全屏：它被删掉了

上游有个 `splashFullscreen`：开屏期间把窗口切成真全屏。上游的实现方式是在**插件宿主里调 Electron 的窗口 API**——而这是**不可能生效的**。

插件宿主不是 Electron 主进程，而是一个以 `ELECTRON_RUN_AS_NODE=1` 跑起来的**普通 Node 子进程**（窗口对象属于主进程，桌面外壳也没有暴露任何能改窗口几何的 IPC）。所以在宿主里 `require('electron').BrowserWindow` 恒为 `undefined`，那一项从加进来的第一天起就是**静默的空操作**——开关打得开，什么都不会发生。

留着只会让人以为开了有用，所以删了。同类需求请用下面的 `startMaximized`，它是真的能工作的。

### 启动默认最大化的代价

宿主碰不到 Electron 窗口，页面也没有任何窗口权限，所以这一项是**从系统层面驱动**的：宿主调用自带的 `tools/maximize-window.ps1`，用 Win32 的 `ShowWindow(SW_MAXIMIZE)` 作用在拥有主窗口的那个进程上。

代价说清楚：

- **仅 Windows**，其他平台静默不生效；
- 是从**外部**操作窗口，不是应用自己的行为；
- 脚本按**可执行文件名**找窗口（由宿主自己的 `process.execPath` 推出，不写死路径），要求窗口有非零句柄和非空标题。

它**一个进程只做一次**，因为浏览器半是在每次页面加载时报到的，由宿主判定只有第一次算"启动"。所以你手动还原窗口后按 F5，**窗口不会被弹回去**。

### 为什么有些地方看起来像绕路

`folder` + `selected` 这套判定，**配置路由（告诉页面播什么）和取流路由（真正把字节发出去）共用同一个函数**。这两边曾经各算各的：文件夹接管后 `src` 会被清空，而取流路由还在按 `src` 找文件——结果页面拿到一个 404 的地址，开屏一片空白。这类"两个地方各写一遍规则"的 bug 在插件里特别容易出，所以现在只留一个判定源。

---

## 支持的格式

**视频**（用 `<video>` 播）：`mp4` `m4v` `webm` `mov` `mkv` `ogv` `ogm` `mpg` `mpeg` `ts`
**动图与静态图**（用 `<img>` 显示）：`gif` `apng` `webp` `avif` `png` `jpg` `jpeg` `svg` `bmp` `ico`

**推荐 `webm`(VP9) 或 `mp4`(H.264)**，这两个在各平台都能播。文件夹清单里**只会列出这些格式**——放进去的其他文件不会出现在列表中。

`mov` 和 `mkv` 只是容器，能不能播取决于内部编码（装 ProRes 或 DNxHD 就解不了）。转码：

```bash
ffmpeg -i input.mov -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an opening.mp4
ffmpeg -i input.mov -c:v libvpx-vp9 -crf 32 -b:v 0 -an opening.webm
```

`-movflags +faststart` 把索引移到文件开头，播放器不用下完整个文件就能起播。

---

## 常见问题

**选了素材但还是不播**
先看设置页「已勾选」是不是 0——**一个都不勾就是不播**，这是刻意的。其次看 `problem` 那行提示：文件被删了、格式不支持、或者文件夹路径写错了都会说明。

**我勾的文件被删了，为什么退回播自带的视频？**
不会。**不会退回**。拿一段你没选的片子顶替，比什么都不播更糟，所以这时插件整个不介入，DSH 正常启动。

**有画面但没声音**
Chromium 要求用户先与页面交互才允许播放带声音的媒体，而开屏发生在交互之前。插件会自动静音重试，所以画面正常、声音没有。

**启动时还能看到 DSH 自己的小鲸鱼**
那是 Electron 主窗口在 harness 启动前加载的启动画面，插件无法替换。插件负责的是它之后的那一段。

**「选择文件夹…」没反应 / 显示"读不到插件配置"**
对话框在**运行 DSH 的那台机器**上弹出；如果你是从另一台机器访问浏览器界面，就看不到它，直接手输路径。如果显示"读不到插件配置"，那是宿主那条路由出错了——把插件版本号告诉我们。

**启动时一直黑屏，过十来秒才出现界面**
说明插件的界面部分没能启动，那层遮盖由兜底机制在约 10 秒后自行撤掉——界面最终会回来，不会永久黑屏。常见原因是安装不完整（`client.js` 没到位）或插件加载时被停用。重装：

```bash
dsh plugin --profile <你的 profile> add github:tenebris173/DeepSeek-splash-animation
```

**跳过点了没反应**
插件在开屏期间于 `window` 捕获阶段接管输入，正常不会被别的插件抢走。若确实遇到，多半是同屏还有另一个用**位置**（而不是事件目标）判定点击的插件，命中区域重叠时它可能先吞掉事件。

**开屏动画被别的插件挡住了**
本插件把画面挂到 `<body>` 下（React portal），而不是留在槽位容器里，这样层级不会被槽位祖先的层叠上下文限制住。同类问题的原因通常是这个：任何带 `transform`、`filter`、`contain`、`isolation` 的祖先都会创建层叠上下文，把后代的 `z-index` 关在里面——此时数值多大都没用，只能把节点挂到 `body` 下。

---

## 致谢与来源

这个仓库是 **[`KDDKBD/DeepSeek-splash-animation`](https://github.com/KDDKBD/DeepSeek-splash-animation) 的 fork**，不是从零写的。原作者的框架、客户端模块形态、媒体解析与 Range 流式传输、以及自带的那段默认视频，都是本仓库的地基。

| 项目 | 作者 / 来源 | 许可证 | 本仓库用到什么 |
| --- | --- | --- | --- |
| [KDDKBD/DeepSeek-splash-animation](https://github.com/KDDKBD/DeepSeek-splash-animation) | KDDKBD 及贡献者 | MIT | **上游本体**：本仓库是它的 fork，保留其全部版权声明 |
| [lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) | lxj5820 及贡献者 | MIT | **参考**：另一套开屏/开机动画插件，改造时对照过它的做法 |

### 素材声明

- 仓库内 `assets/` 下的 `default.mp4`、`fit-compare.png`、`screenshot-splash.png` 是**上游自带**的文件，随上游的 MIT 许可一起分发。
- 任何**用户自己放进素材文件夹**的视频（游戏、影视、录制片段等）**都不属于本仓库**，也不应随本仓库分发——那类素材的著作权属于原权利人。
- 三段演示片段（`开机动画*.mp4`）取自 `lxj5820/dsh-boot-animation`，**不包含在本仓库里**，仅在本地测试时使用。

### 与上游的关系

改动集中在：素材文件夹 + 打勾选择 + 随机播放、片尾交叉溶解、启动默认最大化（Windows）、跳过提示改为底部淡色条、设置页改为左侧栏独立入口，以及移除那个永远不生效的 `splashFullscreen`。

**上游的默认行为没有被单方面改掉**——`tailDissolve`、`startMaximized`、`random` 默认仍是 `false`，不配置的话行为和上游一致。

如果这些改动对上游有价值，欢迎以 patch 形式回流。

---

## 许可

[MIT](LICENSE)，与上游一致。原版权声明保留：

```
MIT License

Copyright (c) 2025 dsh-splash-animation contributors
```
