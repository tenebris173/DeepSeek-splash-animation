/**
 * The optional third-party clips: tell the user they exist, and fetch them on
 * request.
 *
 * These three boot animations are NOT this project's work, so they are not
 * installed by default. Shipping someone else's 25 MB into every install would be
 * rude to the user and to the author; leaving them out and pointing at the source
 * credits the author properly and lets the download happen from the place that
 * author actually published.
 *
 *   node tools/optional-media.mjs           # print the notice (this is what install runs)
 *   node tools/optional-media.mjs --fetch   # download them into the media folder
 *
 * @module
 */

import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Who made the optional clips, and where they published them. */
const SOURCE = {
  author: 'lxj5820',
  project: 'dsh-boot-animation',
  repository: 'https://github.com/lxj5820/dsh-boot-animation',
  license: 'MIT',
  branch: 'main',
}

/**
 * The optional clips: source file name → the name it is saved as here.
 *
 * The local names describe the clip rather than repeating `1`, `2`, `3`, because
 * they appear in the settings list where a bare number says nothing.
 */
const CLIPS = [
  { source: 'assets/videos/1.mp4', name: '开机动画1-8秒.mp4', bytes: 8391471 },
  { source: 'assets/videos/2.mp4', name: '开机动画2-15秒.mp4', bytes: 11065265 },
  { source: 'assets/videos/3.mp4', name: '开机动画3-12秒.mp4', bytes: 5195581 },
]

/**
 * Is the file already downloaded, as opposed to merely present?
 *
 * Existence alone is not enough, and treating it as enough was a real trap: an
 * interrupted download, a Ctrl-C, or a text file that happens to carry the right
 * name all counted as "already there" and were never fetched again. A media file
 * with no bytes is also exactly what makes the player refuse to serve it.
 *
 * @param path - the destination.
 * @returns the size when the file is usable, else 0.
 */
function usableSize(path) {
  try {
    const stats = statSync(path)
    return stats.isFile() && stats.size > 0 ? stats.size : 0
  } catch {
    return 0
  }
}

/** Where the plugin keeps media: the same folder its own settings page points at. */
function mediaDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-splash-animation', 'media')
}

/** Format bytes for a human. */
function size(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Print what the optional clips are, who made them, and how to get them.
 */
function notice() {
  const total = CLIPS.reduce((sum, clip) => sum + (typeof clip.bytes === 'number' ? clip.bytes : 0), 0)
  const lines = [
    '',
    `  可选的第三方素材（未随插件安装，共 ${CLIPS.length} 段${total > 0 ? `，约 ${size(total)}` : ''}）`,
    '',
    `    作者  ${SOURCE.author}`,
    `    项目  ${SOURCE.project}`,
    `    许可  ${SOURCE.license}`,
    `    来源  ${SOURCE.repository}`,
    '',
    '  这几段开机动画不是本插件的作品，所以默认不下载——把别人的 25 MB 塞进',
    '  每一次安装，对使用者不礼貌，对原作者也不合适。想要的话：',
    '',
    '    node tools/optional-media.mjs --fetch',
    '',
    '  下载直接来自上面那个仓库。安装版里若没有 tools/，也可以在插件设置页',
    '  「可选素材」一栏看到同样的说明。',
    '',
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
}

/**
 * Download the optional clips into the media folder, skipping ones already there.
 *
 * @returns the process exit code.
 */
async function fetchClips() {
  const target = mediaDir()
  mkdirSync(target, { recursive: true })
  notice()
  process.stdout.write(`  下载到 ${target}\n\n`)
  let failed = 0
  for (const clip of CLIPS) {
    const destination = join(target, clip.name)
    const already = usableSize(destination)
    if (already > 0) {
      process.stdout.write(`  已有，跳过  ${clip.name}  (${size(already)})\n`)
      continue
    }
    const url = `https://raw.githubusercontent.com/${SOURCE.author}/${SOURCE.project}/${SOURCE.branch}/${clip.source}`
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0) throw new Error('empty response')
      // Write to a scratch name and rename, so an interrupted run cannot leave a
      // half file that the next run would then skip as "already there".
      const partial = `${destination}.part`
      writeFileSync(partial, bytes)
      renameSync(partial, destination)
      process.stdout.write(`  已下载      ${clip.name}  (${size(bytes.length)})\n`)
    } catch (error) {
      failed += 1
      process.stdout.write(`  下载失败    ${clip.name}  (${error.message})\n`)
      process.stdout.write(`              可手动从 ${SOURCE.repository} 获取\n`)
    }
  }
  process.stdout.write('\n')
  return failed === 0 ? 0 : 1
}

const code = process.argv.includes('--fetch') ? await fetchClips() : (notice(), 0)
process.exit(code)
