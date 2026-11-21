/**
 * dsh-xlock — 会话文件系统视图（CLI 用）。
 *
 * ~/.dsh/sessions/<--normalized-cwd-->/<session-id>/session[.vN].jsonl.zstd
 * CLI 不经 DSH 运行时，直接按目录面扫描（只读 + 显式动作）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseLogFilename } from './frames.mjs'
import { MARKER_NAME } from './marker.mjs'
import { ORIGIN_NAME } from './origin.mjs'
import { ARCHIVE_MARKER_RE } from './archive.mjs'
import { parseSyncConflictName } from './util.mjs'

/**
 * 会话库根目录（~/.dsh/sessions，经 Junction 即同步面）。
 */
export function sessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * 列出全部会话目录。
 * @returns {Array<{bucket:string, dir:string, name:string}>}
 */
export function listSessionDirs() {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const out = []
  for (const bucket of readdirSync(root)) {
    const bucketDir = join(root, bucket)
    let sessionDirs
    try {
      sessionDirs = readdirSync(bucketDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of sessionDirs) {
      if (!ent.isDirectory()) continue
      out.push({ bucket, dir: join(bucketDir, ent.name), name: ent.name })
    }
  }
  return out
}

/**
 * 按会话 id（完整或前缀）定位目录。
 * @param {string} query 例如 "session-55d2ae62-…" 或 "55d2ae62"
 */
export function findSessionDirs(query) {
  const q = String(query).trim()
  if (q === '') return []
  const all = listSessionDirs()
  const exact = all.filter((s) => s.name === q)
  if (exact.length > 0) return exact
  return all.filter((s) => s.name.includes(q))
}

/**
 * 会话目录内容盘点。
 * @param {string} dir
 * @returns {{
 *   canonical: Array<{name:string,path:string,version:number}>,
 *   logConflicts: Array<{name:string,path:string,version:number,shortId?:string,date?:string,time?:string}>,
 *   markerConflicts: string[],
 *   archiveConflicts: string[],
 *   other: string[],
 * }}
 */
export function inventorySessionDir(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { canonical: [], logConflicts: [], markerConflicts: [], archiveConflicts: [], other: [] }
  }
  const canonical = []
  const logConflicts = []
  const markerConflicts = []
  const archiveConflicts = []
  const other = []
  for (const name of names) {
    const path = join(dir, name)
    const parsed = parseLogFilename(name)
    if (parsed.kind === 'canonical') {
      canonical.push({ name, path, version: parsed.version })
      continue
    }
    if (parsed.kind === 'conflict') {
      logConflicts.push({ name, path, version: parsed.version, shortId: parsed.shortId, date: parsed.date, time: parsed.time })
      continue
    }
    // 创建归属记录本体/冲突副本：纯元数据，不是争抢痕迹（core/marker.mjs 的
    // MARKER_CONFLICT_RE 同样排除了 origin），整段跳过，不做噪音。
    if (name === ORIGIN_NAME || /^\.dsh-xlock-origin\.json\.sync-conflict-/.test(name)) continue
    // 归档标记（core/archive.mjs，新旧两个文件名 + 冲突副本）：xlock 自己的
    // 标记，不再是"外来标记"。本体存在即正常，不计入摘要；只有 Syncthing 冲突
    // 副本（两台机并发改归档状态的痕迹）单列一桶，供 status/audit 提示看一眼。
    if (ARCHIVE_MARKER_RE.test(name)) {
      if (name.includes('.sync-conflict-')) archiveConflicts.push(name)
      continue
    }
    if (/^\.dsh-xlock/.test(name) && /\.sync-conflict-/.test(name)) {
      markerConflicts.push(name)
      continue
    }
    if (name === MARKER_NAME) continue
    other.push(name)
  }
  return { canonical, logConflicts, markerConflicts, archiveConflicts, other }
}

/**
 * 副本设备短 ID → 机器名（包内 machines.json 映射；未知原样返回）。
 * @param {string|undefined} shortId
 * @param {{devices?:Record<string,string>}} registry
 * @returns {{name:string, known:boolean}}
 */
export function machineName(shortId, registry) {
  if (!shortId) return { name: '(unknown)', known: false }
  const devices = registry?.devices || {}
  const name = devices[shortId]
  return name ? { name, known: true } : { name: shortId, known: false }
}

export { parseSyncConflictName }
