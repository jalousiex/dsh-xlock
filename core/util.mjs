/**
 * dsh-xlock — 基础工具：原子写、fsync、UTC 时间戳、JSON 读写。
 *
 * 零依赖（node: 内置 only）。所有落盘操作都假设同目录同卷：
 * 标记文件在会话目录内（temp+rename 原子），隔离区在 %LOCALAPPDATA%
 * （跨卷移动走 copy+unlink 兜底）。
 */

import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

/** 包根目录（core/ 的上一级）。CLI 与宿主半共用同一份 config.json / machines.json。 */
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 原子写一个 UTF-8 文件：同目录 temp + rename。
 * @param {string} path 目标路径
 * @param {string} text 内容
 * @returns {void}
 */
export function atomicWriteText(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text, 0, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

/**
 * 读取 JSON 文件；不存在或解析失败返回 fallback。
 * @param {string} path 文件路径
 * @param {any} fallback 解析失败时的兜底值
 * @returns {any}
 */
export function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** fsync 一个已写完的文件（按路径打开-同步-关闭）。 */
export function fsyncFile(path) {
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 跨卷安全移动：先 rename，失败（EXDEV/EPERM）退 copy+unlink。
 * @param {string} src 源文件
 * @param {string} dst 目标文件
 */
export function moveFile(src, dst) {
  try {
    renameSync(src, dst)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    copyFileSync(src, dst)
    unlinkSync(src)
  }
}

/**
 * UTC 时间戳，用于隔离区目录名：yyyyMMdd-HHmmss。
 * @param {Date} [date]
 * @returns {string}
 */
export function utcStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  )
}

/** ISO UTC 时间（meta/ledger 用）。 */
export function isoUtc(date = new Date()) {
  return date.toISOString()
}

/**
 * 从文件名提取 Syncthing 冲突副本信息。
 * 命名规律：`<base>.sync-conflict-<yyyyMMdd>-<HHmmss>-<设备短ID>.<ext>`
 * （Syncthing 在最后一个点前插入冲突标记）。
 * @param {string} name 文件名
 * @returns {{date:string,time:string,shortId:string}|undefined}
 */
export function parseSyncConflictName(name) {
  const match = /\.sync-conflict-(\d{8})-(\d{6})-([A-Za-z0-9]+)\./.exec(name)
  if (!match) return undefined
  return { date: match[1], time: match[2], shortId: match[3] }
}

/** 确保目录存在（recursive）。 */
export function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

/**
 * 会话短名（报告显示用）：session-55d2ae62-… → 55d2ae62。
 * @param {string} sessionId
 * @returns {string}
 */
export function shortSessionId(sessionId) {
  return String(sessionId).replace(/^session-/, '').slice(0, 8)
}

/**
 * 把任意文本压成单行摘要（报告里嵌 JSON 用）。
 * @param {string} text
 * @param {number} [max]
 */
export function oneLine(text, max = 160) {
  const flat = String(text).replace(/[\r\n]+/g, ' ⏎ ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export { writeFileSync, readFileSync, existsSync, join }

/**
 * 宿主半文件日志：%LOCALAPPDATA%\dsh-xlock\host.log。
 * cordis logger 在桌面端不可见（stdout 吞掉），文件日志是激活/门禁排障的
 * 唯一可靠观测面。>2MB 时轮转为 host.log.1。任何失败都静默（日志不许弄崩宿主）。
 * @param {string} line 单行内容
 */
export function fileLog(line) {
  try {
    const localApp = process.env.LOCALAPPDATA
      || (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local') : undefined)
    if (!localApp) return
    const root = join(localApp, 'dsh-xlock')
    ensureDir(root)
    const path = join(root, 'host.log')
    try {
      if (statSync(path).size > 2 * 1024 * 1024) renameSync(path, `${path}.1`)
    } catch {
      /* 不存在则不轮转 */
    }
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* 日志失败永不外溢 */
  }
}
