/**
 * dsh-xlock — 隔离区与 gc。
 *
 * 隔离目录：%LOCALAPPDATA%\dsh-xlock\quarantine\<UTC戳>-<sessionId短>-<kind>\
 *   内含：原文件（保留原名）+ meta.json（分类/归属/动作/UTC 时间）。
 *   选 LOCALAPPDATA：同步面之外（免二阶冲突）、不进 DSH 遍历视野。
 * 台账：%LOCALAPPDATA%\dsh-xlock\ledger.jsonl —— quarantine/export/delete 全留痕，
 *   删除动作先写台账再删。
 *
 * 导出（divergent 证据）也放同一目录：`<原名>.divergent.jsonl` + meta 记双边画像。
 */

import { copyFileSync, existsSync, readdirSync, rmSync, statSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { atomicWriteText, ensureDir, isoUtc, moveFile, readJsonSafe, utcStamp } from './util.mjs'

/**
 * 隔离区根目录。
 * @returns {string}
 */
export function quarantineRoot() {
  return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'dsh-xlock', 'quarantine')
}

function ledgerPath() {
  return join(quarantineRoot(), '..', 'ledger.jsonl')
}

/**
 * 追加一条台账。
 * @param {object} entry
 */
export function ledgerAppend(entry) {
  try {
    ensureDir(quarantineRoot())
    appendFileSync(ledgerPath(), `${JSON.stringify({ at: isoUtc(), ...entry })}\n`)
  } catch {
    // 台账失败不阻断主流程。
  }
}

function sanitizeSessionId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'unknown'
}

/**
 * 隔离一个文件：move 到新隔离目录 + meta.json + 台账。
 * @param {string} srcPath 源文件绝对路径
 * @param {{sessionId:string, kind:string, classifiedAs?:string, machines?:object, divergence?:object, action?:string, note?:string}} meta
 * @returns {string} 隔离目录
 */
export function quarantineFile(srcPath, meta) {
  const root = quarantineRoot()
  const dirName = `${utcStamp()}-${sanitizeSessionId(meta.sessionId)}-${meta.kind}`
  const dir = join(root, dirName)
  let n = 2
  let finalDir = dir
  while (existsSync(finalDir)) {
    finalDir = `${dir}-${n++}`
  }
  mkdirSync(finalDir, { recursive: true })
  const dst = join(finalDir, basename(srcPath))
  moveFile(srcPath, dst)
  const metaOut = {
    v: 1,
    at: isoUtc(),
    sessionId: meta.sessionId,
    kind: meta.kind,
    classifiedAs: meta.classifiedAs,
    machines: meta.machines,
    divergence: meta.divergence,
    action: meta.action || 'quarantine',
    note: meta.note,
    sourcePath: srcPath,
    file: basename(dst),
  }
  atomicWriteText(join(finalDir, 'meta.json'), `${JSON.stringify(metaOut, null, 2)}\n`)
  ledgerAppend({ action: 'quarantine', kind: meta.kind, from: srcPath, to: dst, sessionId: meta.sessionId, bytes: fileSize(dst) })
  return finalDir
}

/**
 * 备份留证：COPY 源文件进隔离目录（原文件留在原地不动）+ meta.json + 台账。
 * 用于修复前的原字节留证（tailRepairIfNeeded 的 quarantineCopy 依赖）——
 * 必须是复制语义：修复要在原路径上原位重写，不能先把原文件搬走。
 * @param {string} srcPath 源文件绝对路径
 * @param {{sessionId:string, kind:string, classifiedAs?:string, machines?:object, action?:string, note?:string, extra?:object}} meta
 * @returns {string} 隔离目录
 */
export function quarantineCopyOf(srcPath, meta) {
  const root = quarantineRoot()
  const dirName = `${utcStamp()}-${sanitizeSessionId(meta.sessionId)}-${meta.kind}`
  const dir = join(root, dirName)
  let n = 2
  let finalDir = dir
  while (existsSync(finalDir)) {
    finalDir = `${dir}-${n++}`
  }
  mkdirSync(finalDir, { recursive: true })
  const dst = join(finalDir, basename(srcPath))
  copyFileSync(srcPath, dst)
  const metaOut = {
    v: 1,
    at: isoUtc(),
    sessionId: meta.sessionId,
    kind: meta.kind,
    classifiedAs: meta.classifiedAs,
    machines: meta.machines,
    action: meta.action || 'quarantine-copy',
    note: meta.note,
    ...meta.extra,
    sourcePath: srcPath,
    file: basename(dst),
  }
  atomicWriteText(join(finalDir, 'meta.json'), `${JSON.stringify(metaOut, null, 2)}\n`)
  ledgerAppend({ action: 'quarantine-copy', kind: meta.kind, from: srcPath, to: dst, sessionId: meta.sessionId, bytes: fileSize(dst) })
  return finalDir
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * 导出分叉证据：写 .divergent.jsonl + meta（不移动原文件）。
 * @param {string} dir 隔离目录（通常刚 quarantineFile 的返回值）
 * @param {string} originalName 原副本文件名
 * @param {{copyOnly:Array, differing:Array}} divergence
 * @param {object} extraMeta 额外 meta 字段
 * @returns {string} 导出文件路径
 */
export function writeDivergentExport(dir, originalName, divergence, extraMeta = {}) {
  const lines = []
  for (const rec of divergence.copyOnly) lines.push(JSON.stringify(rec.raw))
  for (const d of divergence.differing) {
    lines.push(JSON.stringify({ __xlock_note: 'differing record — COPY side', seq: d.seq }))
    lines.push(JSON.stringify(d.copy.raw))
    if (d.primary) {
      lines.push(JSON.stringify({ __xlock_note: 'differing record — PRIMARY side', seq: d.seq }))
      lines.push(JSON.stringify(d.primary.raw))
    }
  }
  const outPath = join(dir, `${originalName}.divergent.jsonl`)
  writeFileSync(outPath, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  ledgerAppend({ action: 'export', kind: 'divergent', to: outPath, bytes: fileSize(outPath), ...extraMeta })
  return outPath
}

/**
 * 列出隔离区条目。
 * @returns {Array<{dir:string, meta:object, bytes:number, mtimeMs:number}>}
 */
export function listQuarantine() {
  const root = quarantineRoot()
  if (!existsSync(root)) return []
  const out = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    let isDir
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    const meta = readJsonSafe(join(dir, 'meta.json'), {})
    let bytes = 0
    let mtimeMs = 0
    try {
      for (const f of readdirSync(dir)) {
        const st = statSync(join(dir, f))
        bytes += st.size
        if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs
      }
    } catch {
      continue
    }
    out.push({ dir, name, meta, bytes, mtimeMs })
  }
  return out
}

/** 分叉导出类条目（更长保留期）。 */
function isExportKind(entry) {
  return (
    entry.meta?.kind === 'divergent-export' ||
    (typeof entry.meta?.classifiedAs === 'string' && entry.meta.classifiedAs.includes('divergent'))
  )
}

/**
 * gc：按保留期与总量上限清理隔离区。
 * @param {{retentionDays:number, exportRetentionDays:number, maxQuarantineBytes:number}} cfg
 * @param {Date} [now]
 * @returns {{deleted:number, freedBytes:number, entries:number}}
 */
export function gcQuarantine(cfg, now = new Date()) {
  const entries = listQuarantine()
  const result = { deleted: 0, freedBytes: 0, entries: entries.length }
  const dayMs = 24 * 3600 * 1000
  const victims = []
  for (const entry of entries) {
    const ageDays = (now.getTime() - entry.mtimeMs) / dayMs
    const limit = isExportKind(entry) ? cfg.exportRetentionDays : cfg.retentionDays
    if (limit >= 0 && ageDays > limit) victims.push(entry)
  }
  // 总量上限：最旧优先删除直到不超限。
  const total = entries.reduce((sum, e) => sum + e.bytes, 0)
  if (cfg.maxQuarantineBytes > 0 && total > cfg.maxQuarantineBytes) {
    let over = total - cfg.maxQuarantineBytes
    const byAge = [...entries.filter((e) => !victims.includes(e))].sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of byAge) {
      if (over <= 0) break
      victims.push(entry)
      over -= entry.bytes
    }
  }
  for (const entry of victims) {
    ledgerAppend({
      action: 'delete',
      kind: entry.meta?.kind,
      sessionId: entry.meta?.sessionId,
      dir: entry.dir,
      bytes: entry.bytes,
      ageDays: Math.round(((now.getTime() - entry.mtimeMs) / dayMs) * 10) / 10,
    })
    try {
      rmSync(entry.dir, { recursive: true, force: true })
      result.deleted++
      result.freedBytes += entry.bytes
    } catch {
      // 删不掉（占用）→ 留待下次。
    }
  }
  return result
}
