# dsh-splash-animation

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一段**自定义开屏动画**：启动时播放你指定的视频，播完后 0.3 秒渐隐，露出 DSH 界面。

插件自带一段默认视频，**装上就能用**，也可以在设置里换成自己的。

![开屏动画：视频铺满画面，右下角是跳过按钮](assets/screenshot-splash.png)

## 推荐安装法

**因为这插件是大肥鱼写的，我也不懂。所以我只推荐直接告诉大肥鱼让她自己安装，以下是提示词**

```
帮我安装插件 https://github.com/KDDKBD/DeepSeek-splash-animation
安装 spec 用 github:KDDKBD/DeepSeek-splash-animation（pnpm 的 git 形式）。

优先用 plugin_manager 工具：action=install_bundle，target 填上面的 spec。

如果你的工具列表里没有 plugin_manager（源码版 dsh web 的默认 profile 就没挂这个包），
就手动装，别猜路径：
1. profile 目录是 <home>/profiles/<profile 名>，<home> 取 resolveDshHome() 的结果
   （默认 $DSH_HOME，未设置时为 ~/.dsh）；如果那个目录不存在，先把实际位置告诉我，
   不要自己编一个；
2. 在该目录的 package.json 里加依赖 "dsh-splash-animation":
   "github:KDDKBD/DeepSeek-splash-animation"，并把 "dsh-splash-animation"
   加进 dsh.profile.bundles；
3. 在该目录里用 DSH 自带的 pnpm 执行 install；
4. 装完告诉我需要重启 DSH，以及设置页在哪儿。
```

**注意 `plugin_manager` 不是哪儿都有。** 它来自 `@deepseek-ai/dsh-plugin-manager` 包，
而 `web` profile 的默认模板只有 `@deepseek-ai/dsh-base` 和 `@deepseek-ai/dsh-web-app`——
所以从源码跑的 `dsh web` 里通常没有这个工具，DSH 会照着上面第 2 段手动装（那部分是准的，
不依赖任何工具是否存在）。DSH 桌面版内置了这个包，所以桌面版走第一条就行。

## 普通安装法

**如果上面那条走不通**，用命令行（`dsh` **不随 DSH Desktop 附带**，要先从 npm 装）：

```bash
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add github:KDDKBD/DeepSeek-splash-animation
```

**都不行就手动改配置文件**：先找到 profile 目录，默认在 `<home>/profiles/<profile 名>`
（`<home>` 是 `$DSH_HOME`，未设置时为 `~/.dsh`）。DSH 桌面版的实际位置是
`%APPDATA%\dsh-desktop\harness\profiles\web`。然后编辑该目录的 `package.json`，
把依赖加进 `dependencies`、把 `dsh-splash-animation` 加进 `dsh.profile.bundles`，
并在该目录下执行 `pnpm install`（没有全局 pnpm 就用桌面版自带的
`%APPDATA%\dsh-desktop\harness\.desktop-bin\pnpm.cmd`）。

以上方式装完都**重启 DSH** 生效。`--profile web` 只用于命令行；DSH 桌面版虽然内部也是 `web`
profile，但它自己决定，不需要你指定。

卸载：在 **设置 → 插件** 里停用或卸载，或者

```bash
dsh plugin --profile web remove dsh-splash-animation
```

> 界面里的插件市场只收录社区精选列表里的插件。如果那里搜不到本插件，用上面的方式安装即可。
> 通过 GitHub 安装需要本机装有 `git`。

## 使用

装好重启后就有开屏动画，播放的是插件自带的视频。

要换成自己的：打开 **设置 → 插件 → 开屏动画**，点「选择文件…」在弹出的文件框里挑一个视频，点「保存」。也可以直接把路径粘进输入框。

要彻底关掉：在同一个页面点「清除」。

## 行为

| 状态 | 表现 |
|---|---|
| 没设置过 | 播放插件自带的视频 |
| 设置了路径 | 播放该视频。路径无效则**不播放**（不会回退到自带视频），原因显示在设置页 |
| 点过「清除」 | **不播放**，DSH 与未安装插件时一致 |

视频播完会停在最后一帧，然后渐隐消失。默认渐隐 0.3 秒。

### 启动过程

```
原生启动窗 → 黑屏（本插件已接管）→ 播放视频 → 渐隐 → 界面
```

插件来不及显示画面的那一两秒里，屏幕是**黑的**而不是先露出界面：插件在页面第一帧就把应用内容盖住，等自己的画面挂上才放开。所以启动时看不到"界面闪一下再出现动画"。

**开屏期间画面拥有输入。** 那段黑屏和视频是覆盖在整个界面上的，点击不会穿透到下面的应用；跳过之后立即恢复。

### 退出方式

默认右下角有一个「跳过」按钮，按 `Esc`、空格或回车也可以提前退出。想改成点任意位置跳过、固定时长自动退出、或干脆不让退出，见下面的 `skip`。

## 配置

在 profile 的 `cordis.patch.yml` 里写覆盖项即可调整细节（Windows 上通常是 `%APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml`）：

```yaml
- id: dsh-splash-animation
  config:
    fit: contain      # 完整显示（默认是 cover 铺满裁切）
    muted: false      # 带声音
    fadeOutMs: 600    # 渐隐时长改为 0.6 秒
    skip: click       # 点任意位置跳过
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `src` | 空 | 视频路径。空 = 使用自带视频；清空后不再播放 |
| `fadeOutMs` | `300` | 播完后渐隐的时长（毫秒） |
| `fadeInMs` | `320` | 出现时的淡入时长 |
| `skip` | `button` | 退出方式：`button` 右下角按钮 / `click` 点任意位置 / `auto` 自动 / `never` 不可退出 |
| `skipAfterMs` | `1200` | 仅 `skip: auto` 时有效 |
| `muted` | `true` | 是否静音。默认静音，因为 Chromium 会拦截带声音的自动播放 |
| `volume` | `0.6` | 音量 0–1 |
| `fit` | `cover` | `cover` 铺满裁切（默认，不拉伸，超出部分裁掉）/ `contain` 完整显示、四周留边 / `fill` 拉伸填满 |
| `background` | `#000000` | 画面底色 |
| `playbackRate` | `1` | 播放倍速 0.1–4 |
| `duration` | `0` | 最长播放毫秒数，`0` 表示播放到结束 |
| `maxReplays` | `0` | 重复播放次数 |
| `holdAfterEndMs` | `0` | 播完到开始渐隐之间的停顿 |
| `tailDissolve` | `false` | **片尾交叉溶解**：淡出从影片结束前 `fadeOutMs` 就开始，影片还在演的时候界面就在下面透出来，交接正好落在最后一帧。关闭（默认）是原有行为：整段播完、停在最后一帧，再淡出。`maxReplays > 0` 时不生效，避免截断重播 |
| `startMaximized` | `false` | **启动默认最大化**：应用启动时把窗口最大化，一个进程只做一次，之后刷新页面不会再把窗口弹回最大化。仅桌面端有效 |
| `waitForAppMs` | `2500` | 仅动图使用：动图没有结束事件，只能按时间退出 |

字段填写有误只会退回默认值，不会导致启动失败。

### 素材文件夹、打勾与随机播放（本仓库新增）

原本只能指定**一个**视频路径。现在改成指定**一个文件夹**，插件列出里面所有能播的视频与动图，**打勾**决定哪些参与，开屏时从打勾的里面随机挑一个。

```jsonc
// $DSH_HOME/dsh-splash-animation/config.json
{
  "folder": "C:\\Users\\你\\.dsh\\dsh-splash-animation\\media",
  "selected": ["a.mp4", "b.webm"],   // 只存文件名，不存路径
  "random": true,
  "skip": "click"
}
```

几个刻意的取舍：

- **只存文件名，不存路径。** 整个文件夹改名或搬家之后，勾选不会全部失效。
- **打勾是唯一让素材参与的方式。** 一个都不打勾就是**不播**，DSH 直接启动——「没选」不会被悄悄当成「全选」。
- **勾的文件不见了也不退回自带视频。** 拿一段你没选的片子来顶替，比什么都不播更糟。插件这时完全不介入，DSH 正常启动。
- **配置路由与取流路由共用同一个判定源。** 两边曾经各算各的：文件夹接管后 `src` 会被清空，而取流路由还在按 `src` 找文件，于是页面拿到的地址是 404，开屏一片空白。现在「能播哪些」只有一个函数说了算。
- **旧配置会自动搬家。** 以前存的单个路径会被解成「文件夹 = 它的目录 + 它自己已打勾」，所以升级不会看起来像丢数据。

设置页里有「刷新」按钮：往文件夹里丢进新文件后不用重启。

### 跳过方式（本仓库新增）

`skip` 沿用上游的取值，这里说明本仓库默认用哪个以及为什么：

| 值 | 行为 |
| --- | --- |
| `button` | 上游默认：右下角一个「跳过」按钮 |
| `click` | **本仓库默认**：点画面任意位置跳过，底部只留一条淡色提示 |
| `auto` | `skipAfterMs` 之后自动跳过 |
| `never` | 不能跳过 |

提示条的做法：贴底整宽、居中、`opacity: 0.42`、无边框，配一层从底部向上渐隐的极淡黑（而不是实心条），并且设了 `pointer-events: none`——否则它横在底部会把"点击任意位置"的那次点击自己吃掉。

### 片尾交叉溶解（本仓库新增）

默认行为是**先播完、再淡出**：影片停在最后一帧，`holdAfterEndMs` 之后开始渐隐，渐隐用掉 `fadeOutMs`——也就是说界面要等到影片结束后再过 `fadeOutMs` 才完全露出来。

打开 `tailDissolve` 后改成**边播边溶解**：渐隐提前 `fadeOutMs` 开始，界面在影片还在演的时候就慢慢透出来，影片最后一帧出现的那一刻交接正好完成。观感上不再是「播完 → 黑一下 → 界面」，而是一段连续的过渡。

两个入口，改哪个都行，**设置页的值优先**：

1. **设置 → 插件 → 开屏动画** 里的「片尾交叉溶解」勾选框（即时生效，不用重启）；
2. profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-splash-animation
  config:
    tailDissolve: true
```

计时按 `duration`（若设了更短的播放上限，就以它为结束点）和 `playbackRate` 一起算：2 倍速时等待时间减半，所以交接仍然落在影片真正的最后一帧，而不是按固定秒数硬等。

### 关于「开屏全屏」（已移除）

早先的版本里有一个 `splashFullscreen`：开屏期间把窗口切成真全屏。**它被删掉了，因为它永远不可能生效。**

插件宿主不是 Electron 主进程，而是一个以 `ELECTRON_RUN_AS_NODE=1` 跑起来的**普通 Node 子进程**——窗口对象属于主进程，跨进程拿不到，桌面外壳也没有暴露任何能改窗口几何的 IPC。所以 `require('electron').BrowserWindow` 在宿主里恒为 `undefined`，那一项从加进去的第一天起就是**静默的空操作**。

留着只会让人以为开了有用。同类需求请用下面的 `startMaximized`，它是真的能工作的。

### 启动默认最大化（本仓库新增）

打开 `startMaximized` 后，**应用启动时**把 DSH 窗口最大化。它不还原——最大化是你要的最终状态，不是开屏期间的临时状态。

```yaml
- id: dsh-splash-animation
  config:
    startMaximized: true
```

**实现方式，以及为什么这么脏。** 宿主半是普通 Node 子进程，碰不到 Electron 的窗口对象；桌面外壳也没有给页面任何改窗口的通道。所以这一项是**从系统层面驱动窗口**的：宿主调用自带的 `tools/maximize-window.ps1`，用 Win32 的 `ShowWindow(SW_MAXIMIZE)` 作用在拥有主窗口的那个进程上。

代价说清楚：

- **仅限 Windows**，其他平台静默不生效；
- 脚本按**可执行文件名**找窗口（由宿主进程自己的 `process.execPath` 推出，不写死），要求该窗口有非零句柄和非空标题；
- 找不到窗口时**不算已处理**，留到下次页面加载再试——外壳还没建好窗口的情况靠这条兜住。

关键在「启动」两个字怎么界定。浏览器半在**每次页面加载**时都会报一声「我起来了」，**由宿主决定只有第一次算启动**——一个进程只最大化一次。所以：

- 你手动把窗口还原，然后按 F5 刷新 —— **窗口不会被弹回最大化**。少了这条，这个功能会非常烦人；
- 窗口本来就已经最大化 —— 什么都不做，但算作已处理；
- 那一刻还找不到窗口 —— 不算已处理，下次再试。

画面尺寸本身仍由 `fit` 决定（见下），最大化只是把窗口放大到屏幕。

### 画面怎么填满

默认 `fit: cover`：**按比例放大到铺满整个画面，超出的部分裁掉，不拉伸**。视频比窗口更宽就裁两侧，更高就裁上下。

如果素材被裁掉的部分不能少，改成 `fit: contain` 就会完整显示，代价是四周留黑边。

![三种填充方式对比：contain 上下留黑边、cover 铺满裁切、fill 拉伸](assets/fit-compare.png)

## 支持的格式

视频用 `<video>` 播放：`mp4`、`m4v`、`webm`、`mov`、`mkv`、`ogv`、`ogm`、`mpg`、`mpeg`、`ts`

动图与静态图用 `<img>` 显示：`gif`、`apng`、`webp`、`avif`、`png`、`jpg`、`jpeg`、`svg`、`bmp`、`ico`

**推荐 `webm`(VP9) 或 `mp4`(H.264)**，这两个在所有平台上都能播放。

`mov` 和 `mkv` 只是容器，能否播放取决于内部编码：装 ProRes 或 DNxHD 就无法解码。转码命令：

```bash
ffmpeg -i input.mov -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart -an opening.mp4
ffmpeg -i input.mov -c:v libvpx-vp9 -crf 32 -b:v 0 -an opening.webm
```

`-movflags +faststart` 把索引移到文件开头，播放器不必下完整个文件就能起播。

## 常见问题

**选了视频但没有播放**
检查设置页是否显示「下次启动播放」，以及 `%APPDATA%\dsh-desktop\harness\dsh-splash-animation\config.json` 里的 `src` 是否正确。设置改动后刷新页面即可生效，不需要重启。

**有画面但没声音**
Chromium 要求用户先与页面交互才允许播放带声音的媒体，而开屏发生在交互之前。插件会自动静音重试，所以画面正常、声音没有。

**启动时还能看到 DSH 自己的小鲸鱼**
那是 Electron 主窗口在 harness 启动前加载的启动画面，插件无法替换。插件负责的是它之后的那一段。

**「选择文件…」没有反应**
对话框在运行 DSH 的机器上弹出，如果你是从另一台机器访问浏览器界面就看不到它，直接手输路径即可。

**启动时一直黑屏，过十来秒才出现界面**
说明插件的界面部分没能启动，那层遮盖由兜底机制在约 10 秒后自行撤掉——所以界面最终会回来，不会永久黑屏。常见原因是安装不完整（`client.js` 没到位）或插件在加载时被停用。重装一次即可：

```bash
dsh plugin --profile web add github:KDDKBD/DeepSeek-splash-animation
```

**跳过按钮点了没反应**
插件在开屏期间会在 `window` 捕获阶段接管输入，正常不会被别的插件抢走。若确实遇到，多半是同屏还有一个用**位置**（而不是事件目标）判定点击的插件——两边的命中区域重叠时它可能先吞掉事件。把那个插件的悬浮位置挪开即可。

**开屏动画被别的插件挡住了**
本插件把画面挂到 `<body>` 下（React portal），而不是留在槽位容器里，这样它的层级不会被槽位祖先的层叠上下文限制住。如果你在别的插件里遇到同类问题，原因通常就是这个：`shell.overlay` 的槽位包装元素本身是 `display: contents`、不产生盒子，但**它的祖先仍在**，任何带 `transform`、`filter`、`contain`、`isolation` 的祖先都会创建层叠上下文，把后代的 `z-index` 关在里面——此时数值多大都没用，只能把节点挂到 `body` 下。

## 致谢与来源

这个仓库是 **`KDDKBD/DeepSeek-splash-animation` 的改动版（fork）**，不是从零写的。原作者的框架、客户端模块形态、媒体解析与 Range 流式传输、以及自带的那段默认视频，都是本仓库的地基。

| 项目 | 作者 / 来源 | 许可证 | 本仓库用到什么 |
| --- | --- | --- | --- |
| [KDDKBD/DeepSeek-splash-animation](https://github.com/KDDKBD/DeepSeek-splash-animation) | KDDKBD 及贡献者 | MIT | **上游本体**：本仓库是它的 fork，保留其全部版权声明 |
| [lxj5820/dsh-boot-animation](https://github.com/lxj5820/dsh-boot-animation) | lxj5820 及贡献者 | MIT | **参考**：另一套开屏/开机动画插件的实现，本仓库改造时对照过它的做法；本机素材文件夹里的三段演示片段也取自那里（见下） |

### 素材声明

- 仓库内 `assets/` 下的 `default.mp4`、`fit-compare.png`、`screenshot-splash.png` 是**上游自带**的文件，随上游的 MIT 许可一起分发。
- 三段演示片段（`开机动画*.mp4`）来自 `lxj5820/dsh-boot-animation`，**不包含在本仓库里**，仅在本地测试时使用。
- 任何用户自己放进素材文件夹的视频（例如游戏或影视片段）**都不属于本仓库**，也不应随本仓库分发——那类素材的著作权属于原权利人。

### 与上游的关系

本仓库是 fork，改动集中在：素材文件夹 + 打勾选择 + 随机播放、片尾交叉溶解、启动默认最大化（Windows）、跳过提示改为底部淡色条、设置页从「内置插件」标签页改为左侧栏独立入口。**上游的行为默认值没有被单方面改掉**（`tailDissolve`、`startMaximized` 默认仍是 `false`）。

如果这些改动对上游有价值，欢迎以 patch 形式回流。

## 许可

MIT，覆盖插件代码。

`assets/default.mp4` 是示例素材，不属于该授权的范围；二次分发或 fork 时请自行确认素材权利，替换该文件即可换成自己的素材。
