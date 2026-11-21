/**
 * dsh-xlock — 冲突副本分类（对照主文件）。
 *
 * 三分类（人裁决，绝不机械合并）：
 * - identical：与主文件记录完全一致（冗余，可隔离删除）；
 * - prefix   ：副本是主文件的严格前缀（旧状态，可隔离删除）；
 * - divergent：同 seq 内容不同，或副本含主文件没有的 seq（真分叉 → 导出+人裁决）；
 * - unreadable：副本无法完整解码（fail-safe：按 divergent 通道拦截，不自动删）；
 * - orphan   ：同版本主文件不存在（归属不明 → 报告，不自动动）。
 *
 * 比较按「记录序列」不按帧：两机的提交批（frame 边界）天然不同。
 */

import { readFileSync } from 'node:fs'
import { walkLog } from './frames.mjs'

/**
 * 比较副本记录与主文件记录。
 * @param {{records:Array, health:object}} primary walkLog(主文件)
 * @param {{records:Array, health:object}} copy walkLog(副本)
 * @returns {{
 *   kind: 'identical'|'prefix'|'divergent'|'unreadable',
 *   firstDivergenceSeq?: number,
 *   copyOnly: Array<object>,            // 副本独有记录（seq 超出主文件范围）
 *   differing: Array<{seq:number, primary:object, copy:object}>,  // 同 seq 内容不同
 *   copyEventCount: number,
 *   primaryEventCount: number,
 * }}
 */
export function classifyCopy(primary, copy) {
  const p = primary.records.filter((r) => typeof r.seq === 'number')
  const c = copy.records.filter((r) => typeof r.seq === 'number')
  const result = {
    kind: 'identical',
    copyOnly: [],
    differing: [],
    copyEventCount: c.length,
    primaryEventCount: p.length,
  }
  if (copy.health.corruptMiddle || copy.health.frameCount === 0 || (copy.health.tornTailFrame && c.length === 0)) {
    // 零帧 = 完全解不开（垃圾字节或全损坏）→ fail-safe unreadable。
    result.kind = 'unreadable'
    return result
  }
  const pBySeq = new Map(p.map((r) => [r.seq, r]))
  const maxPrimarySeq = p.length > 0 ? p[p.length - 1].seq : undefined
  for (let i = 0; i < c.length; i++) {
    const rec = c[i]
    const twin = pBySeq.get(rec.seq)
    if (twin === undefined) {
      result.kind = 'divergent'
      if (result.firstDivergenceSeq === undefined) result.firstDivergenceSeq = rec.seq
      if (maxPrimarySeq === undefined || rec.seq > maxPrimarySeq) result.copyOnly.push(rec)
      else result.differing.push({ seq: rec.seq, primary: undefined, copy: rec })
      continue
    }
    if (JSON.stringify(twin.raw) !== JSON.stringify(rec.raw)) {
      result.kind = 'divergent'
      if (result.firstDivergenceSeq === undefined) result.firstDivergenceSeq = rec.seq
      result.differing.push({ seq: rec.seq, primary: twin, copy: rec })
    }
  }
  if (result.kind === 'identical' && c.length < p.length) result.kind = 'prefix'
  return result
}

/**
 * 走查并分类一个副本文件。
 * @param {string} copyPath 副本绝对路径
 * @param {string} primaryPath 同版本主文件路径（可不存在）
 * @param {{readFileSync?: Function}} [deps] 测试注入
 */
export function auditCopyFile(copyPath, primaryPath, deps = {}) {
  const read = deps.readFileSync ?? readFileSync
  let copyWalk
  try {
    copyWalk = walkLog(read(copyPath))
  } catch (error) {
    return { path: copyPath, kind: 'unreadable', error: String(error?.message || error) }
  }
  let primaryWalk
  let primaryMissing = false
  try {
    primaryWalk = walkLog(read(primaryPath))
  } catch {
    primaryMissing = true
  }
  if (primaryMissing) {
    return { path: copyPath, kind: 'orphan', copy: summarize(copyWalk) }
  }
  const verdict = classifyCopy(primaryWalk, copyWalk)
  return { path: copyPath, ...verdict, copy: summarize(copyWalk), primary: summarize(primaryWalk) }
}

function summarize(walk) {
  const events = walk.records.filter((r) => typeof r.seq === 'number')
  // 真机事件用 time（header 用 createdAt）；两者都收，取真实跨度。
  const stamps = walk.records
    .map((r) => (typeof r.time === 'number' ? r.time : typeof r.createdAt === 'number' ? r.createdAt : undefined))
    .filter((n) => typeof n === 'number')
  const lastTurn = [...walk.records].reverse().find((r) => r.type === 'turn/end')
  return {
    eventCount: events.length,
    seqFirst: events.length ? events[0].seq : undefined,
    seqLast: events.length ? events[events.length - 1].seq : undefined,
    createdAtFirst: stamps.length ? Math.min(...stamps) : walk.header?.createdAt,
    createdAtLast: stamps.length ? Math.max(...stamps) : undefined,
    lastTurn: lastTurn ? { turn: lastTurn.turn, reason: lastTurn.raw?.reason } : undefined,
    openTurn: detectOpenTurn(walk.records),
    health: walk.health,
    header: walk.header,
  }
}

/** 末尾未闭合 turn（turn/start 后无对应 turn/end）。 */
export function detectOpenTurn(records) {
  let open
  for (const r of records) {
    if (r.type === 'turn/start') open = r.turn
    else if (r.type === 'turn/end' && r.turn === open) open = undefined
  }
  return open
}
