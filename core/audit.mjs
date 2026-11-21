/**
 * dsh-xlock — 会话审计（CLI 与写打开顺手审计共用）。
 *
 * audit 对一个会话目录：
 * - 走查全部 canonical 日志（健康 + 记录画像）；
 * - 走查全部冲突副本并对照同版本主文件分类；
 * - 报告标记状态与标记冲突副本（异机持锁痕迹）；
 * - 默认不动任何文件（AC6），唯二例外：--gc 顺带清隔离区；
 *   divergent 副本在【写打开门禁】里隔离时才落盘。
 */

import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { walkLog } from './frames.mjs'
import { auditCopyFile, detectOpenTurn } from './classify.mjs'
import { inventorySessionDir, machineName } from './sessionfs.mjs'
import { markerStatus } from './marker.mjs'
import { inferOrigin, originSourceLabel } from './origin.mjs'
import { isoUtc } from './util.mjs'

/**
 * 审计一个会话目录。
 * @param {string} dir 会话目录绝对路径
 * @param {{identity:{uuid:string,host:string}, machines:object, sessionName?:string}} env
 * @returns {object} 报告（含 needsAttention 汇总）
 */
export function auditSessionDir(dir, { identity, machines, sessionName }) {
  const inv = inventorySessionDir(dir)
  const canonical = inv.canonical
    .slice()
    .sort((a, b) => b.version - a.version)
    .map((entry) => {
      let walk
      let error
      try {
        walk = walkLogRead(entry.path)
      } catch (e) {
        error = String(e?.message || e)
      }
      const summary = walk ? summarizeWalk(walk) : undefined
      return {
        name: entry.name,
        version: entry.version,
        bytes: fileSize(entry.path),
        error,
        ...summary,
      }
    })

  const primaryByVersion = new Map(canonical.filter((c) => c.error === undefined).map((c) => [c.version, c]))

  const copies = inv.logConflicts
    .slice()
    .sort((a, b) => (a.version - b.version) || String(a.name).localeCompare(b.name))
    .map((entry) => {
      const primaryEntry = primaryByVersion.get(entry.version)
      const primaryPath = primaryEntry ? canonicalPathOf(dir, primaryEntry.name) : joinGuess(dir, entry)
      const verdict = auditCopyFile(entry.path, primaryPath)
      const mn = machineName(entry.shortId, machines)
      return {
        name: entry.name,
        version: entry.version,
        shortId: entry.shortId,
        machine: mn,
        syncedAtUtc: entry.date && entry.time ? `${entry.date.slice(0, 4)}-${entry.date.slice(4, 6)}-${entry.date.slice(6, 8)}T${entry.time.slice(0, 2)}:${entry.time.slice(2, 4)}:${entry.time.slice(4, 6)}Z` : undefined,
        bytes: fileSize(entry.path),
        kind: verdict.kind,
        firstDivergenceSeq: verdict.firstDivergenceSeq,
        copyEventCount: verdict.copyEventCount,
        primaryEventCount: verdict.primaryEventCount,
        copyOnlyCount: verdict.copyOnly ? verdict.copyOnly.length : undefined,
        differingCount: verdict.differing ? verdict.differing.length : undefined,
        error: verdict.error,
        copy: verdict.copy,
      }
    })

  const marker = markerStatus(dir, identity)
  // 创建归属：三层证据（创建记录 → 目录桶推断 → 未知）。
  // 注意它和 marker 是两件事：marker 是"现在谁持有"，归属是"当初谁建的"。
  const origin = inferOrigin(dir, {
    identity,
    registry: machines,
    bucket: basename(dirname(dir)),
  })
  const needsAttention = []
  if (copies.some((c) => c.kind === 'divergent')) needsAttention.push('divergent-copy')
  if (copies.some((c) => c.kind === 'unreadable')) needsAttention.push('unreadable-copy')
  if (copies.some((c) => c.kind === 'orphan')) needsAttention.push('orphan-copy')
  if (inv.markerConflicts.length > 0) needsAttention.push('marker-conflict-copy')
  if (marker.foreign || marker.corrupt) needsAttention.push('marker-held')
  for (const c of canonical) {
    if (c.error !== undefined) needsAttention.push(`primary-unreadable:${c.name}`)
    else if (c.health?.tornJsonlLastLine) needsAttention.push(`torn-jsonl:${c.name}`)
    else if (c.health?.seqGaps?.length) needsAttention.push(`seq-gap:${c.name}`)
  }

  return {
    sessionId: sessionName || basename(dir),
    dir,
    at: isoUtc(),
    canonical,
    copies,
    markerConflicts: inv.markerConflicts,
    marker: {
      state: marker.state,
      corrupt: marker.corrupt,
      foreign: marker.foreign,
      holder: marker.holder,
      conflicts: marker.conflicts,
    },
    origin,
    needsAttention: [...new Set(needsAttention)],
  }
}

function canonicalPathOf(dir, name) {
  return join(dir, name)
}

/** 同版本 canonical 缺失时，退而求其次找任意更高版本主文件比较（供 orphan 判断）。 */
function joinGuess(dir, entry) {
  return canonicalPathOf(dir, `session.v${entry.version}.jsonl.zstd`)
}

function walkLogRead(path) {
  return walkLog(readFileSync(path))
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function summarizeWalk(walk) {
  const events = walk.records.filter((r) => typeof r.seq === 'number')
  // 真机事件用 time（header 用 createdAt）；两者都收，取真实跨度。
  const stamps = walk.records
    .map((r) => (typeof r.time === 'number' ? r.time : typeof r.createdAt === 'number' ? r.createdAt : undefined))
    .filter((n) => typeof n === 'number')
  const lastTurnEnd = [...walk.records].reverse().find((r) => r.type === 'turn/end')
  return {
    header: walk.header,
    eventCount: events.length,
    seqFirst: events.length ? events[0].seq : undefined,
    seqLast: events.length ? events[events.length - 1].seq : undefined,
    createdAtFirst: stamps.length ? Math.min(...stamps) : undefined,
    createdAtLast: stamps.length ? Math.max(...stamps) : undefined,
    lastTurn: lastTurnEnd ? { turn: lastTurnEnd.turn, reason: lastTurnEnd.raw?.reason } : undefined,
    openTurn: detectOpenTurn(walk.records),
    health: walk.health,
  }
}

/**
 * 把审计报告渲染成人读文本。
 * @param {object} report auditSessionDir 的返回值
 * @returns {string}
 */
export function renderReport(report) {
  const L = []
  L.push(`会话 ${report.sessionId}`)
  L.push(`  目录: ${report.dir}`)
  for (const c of report.canonical) {
    if (c.error !== undefined) {
      L.push(`  主文件 ${c.name}: 不可读 (${c.error})`)
      continue
    }
    const range =
      c.createdAtFirst && c.createdAtLast
        ? `${new Date(c.createdAtFirst).toISOString()} → ${new Date(c.createdAtLast).toISOString()}`
        : '(no timestamps)'
    const flags = []
    if (c.health.tornTailFrame) flags.push('torn-tail-frame(写打开自愈)')
    if (c.health.tornJsonlLastLine) flags.push('torn-JSONL-末行(需修复)')
    if (c.health.seqGaps.length) flags.push(`seq-gap×${c.health.seqGaps.length}`)
    if (c.openTurn !== undefined) flags.push(`turn#${c.openTurn}未闭合`)
    L.push(
      `  主文件 ${c.name}: ${c.eventCount} events, frames=${c.health.frameCount}, ${range}` +
        (flags.length ? ` ⚠ ${flags.join(', ')}` : ' ✓'),
    )
  }
  if (report.copies.length === 0) {
    L.push('  冲突副本: 无')
  }
  for (const c of report.copies) {
    const known = c.machine.known ? c.machine.name : `${c.machine.name}(未补录 → machines.json)`
    L.push(
      `  副本 ${c.name}: [${c.kind}] 来自 ${known}` +
        (c.syncedAtUtc ? ` 冲突于 ${c.syncedAtUtc}` : '') +
        (c.firstDivergenceSeq !== undefined ? ` 首个分叉 seq=${c.firstDivergenceSeq}` : '') +
        ` (copy=${c.copyEventCount ?? '?'} vs primary=${c.primaryEventCount ?? '?'})`,
    )
  }
  if (report.markerConflicts.length > 0) {
    L.push(`  ⚠ 标记冲突副本×${report.markerConflicts.length}: ${report.markerConflicts.join(', ')}`)
  }
  const o = report.origin
  if (o) {
    const label = o.known ? o.host : `${o.host}(未登记 → machines.json)`
    L.push(
      `  创建归属: ${label}${o.local ? '（本机）' : '（异机）'} · 依据 ${originSourceLabel(o.source)}` +
        (o.conflicts > 0 ? ` · ⚠ 创建记录冲突副本×${o.conflicts}` : ''),
    )
  }
  const m = report.marker
  if (m.state === 'held') {
    L.push(`  锁标记: held by ${m.holder?.host || '?'}${m.foreign ? '（异机）' : '（本机）'}`)
  } else if (m.state === 'released') {
    L.push('  锁标记: released（可接管）')
  } else if (m.corrupt) {
    L.push('  锁标记: 损坏（fail-safe 视为持有）→ xlock 工具 reset（或 dsh-xlock.ps1 reset）')
  } else {
    L.push('  锁标记: 无')
  }
  if (report.needsAttention.length > 0) {
    L.push(`  需要处理: ${report.needsAttention.join(', ')}`)
    L.push('  裁决入口: xlock 工具 resolve（或 dsh-xlock.ps1 resolve）<session> --keep primary|copy')
  } else {
    L.push('  状态: 健康')
  }
  return L.join('\n')
}
