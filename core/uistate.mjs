/**
 * dsh-xlock — 会话锁/归档状态的只读查询与显式解锁（core/uistate.mjs）
 *
 * 供宿主半的 webServer 路由（client UI）使用，也可单测。刻意只依赖 core 里
 * 已有的纯函数 + node:fs，不碰 Cordis 服务，方便在 test/run.mjs 里独立验证。
 *
 * 数据源全是本机磁盘上的会话目录标记：锁标记（core/marker.mjs）、归档标记
 * （core/archive.mjs）、创建归属（core/origin.mjs）。Syncthing  minute 级延迟
 * 依旧存在——这里读到的是"本机此刻看见的那一面"，不是跨机强一致状态。
 */

import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { markerStatus, listMarkerConflicts, MARKER_NAME } from './marker.mjs'
import { readArchiveMarker } from './archive.mjs'
import { inferOrigin } from './origin.mjs'
import { findSessionDirs } from './sessionfs.mjs'
import { describeActivity } from './live.mjs'

/** 标记损坏按 fail-safe 对待：和异机持有一样不许接管，只是多带一个 corrupt 字段。 */
function lockStateOf(status) {
  if (status.corrupt || status.foreign || status.conflicts.length > 0) return 'held-foreign'
  if (status.state === 'held') return 'held-self'
  if (status.state === 'released') return 'released'
  return 'unmarked'
}

/**
 * 查一个会话的锁 + 归档 + 活跃度状态。
 *
 * @param {string} sessionId
 * @param {{identity?:object, registry?:object, now?:number, activeMs?:number}} env
 * @returns {object|null} 找不到会话目录返回 null
 */
export function getSessionLockState(sessionId, env = {}) {
  const dirs = findSessionDirs(String(sessionId || '').trim())
  // 精确名优先；includes 兜底是为了兼容历史前缀查询，但绝不放宽解锁（见 reset）。
  const hit = dirs.find((d) => d.name === String(sessionId)) || dirs[0]
  if (!hit) return null

  const identity = env.identity || {}
  const status = markerStatus(hit.dir, identity)
  const origin = inferOrigin(hit.dir, {
    identity,
    registry: env.registry || {},
    bucket: hit.bucket,
  })
  const archive = readArchiveMarker(hit.dir)
  const lockState = lockStateOf(status)
  // 只有异机持有时才去读日志——本机会话的平台状态点已经足够，读日志是白花钱。
  const activity = lockState === 'held-foreign'
    ? describeActivity(hit.dir, { now: env.now, activeMs: env.activeMs })
    : null

  return {
    sessionId: hit.name,
    lockState,
    host: status.holder?.host || (origin.known ? origin.host : null),
    machineId: status.holder?.machineId || origin.machineId || null,
    pid: status.holder?.pid ?? null,
    corrupt: status.corrupt === true,
    markerConflicts: status.conflicts.length,
    createdRemote: origin.local === false && origin.source !== 'unknown',
    createdHost: origin.source === 'unknown' ? null : origin.host,
    originSource: origin.source,
    archived: typeof archive.archived === 'boolean' ? archive.archived : null,
    archiveSource: archive.source,
    /** 异机持有时才非 null：`{activity,lastWriteAt,freshMs,openTurn}`（core/live.mjs）。 */
    activity,
  }
}

/** 列出本机可见的全部会话状态。 */
export function listSessionLockStates(env = {}) {
  const dirs = findSessionDirs('session-')
  const out = []
  for (const dir of dirs) {
    const state = getSessionLockState(dir.name, env)
    if (state) out.push(state)
  }
  return out
}

/**
 * 磁盘上的全量会话 id（去重、排序）。
 *
 * 给浏览器半做**集合变化检测**：平台只在连接建立时拉一次列表，之后靠事件增量维护；
 * 异机删掉一条会话时本机不会产生 session/disposed，那行会一直挂着。宿主半扫盘能
 * 看见「少了一条」，客户端比对集合变了就让平台重拉权威基线。
 *
 * 用磁盘目录而不是 `sessionPersistence.list`：本模块刻意只依赖 core 纯函数，
 * 而目录面就是持久化的真身（list 也只是在读它）。
 *
 * @returns {string[]}
 */
export function listSessionIds() {
  const ids = new Set()
  for (const dir of findSessionDirs('session-')) {
    if (typeof dir.name === 'string' && dir.name.startsWith('session-')) ids.add(dir.name)
  }
  return [...ids].sort()
}

/**
 * 显式解锁：删除粘锁标记 + 它的 sync-conflict 副本（与 cli/xlock.mjs cmdReset 同语义）。
 *
 * 安全约束：
 *  - 只接受**精确会话名**，不接受前缀 / 路径 / 目录穿越——前缀命中多个目录时
 *    宁可拒绝，也不盲删一堆标记；
 *  - 只删会话目录内固定文件名的标记，绝不按请求里的任意路径删文件；
 *  - 归档标记（.dsh-xlock-archive.json / 旧名）一概不碰——解锁与归档无因果关系。
 *
 * @param {string} sessionId
 * @param {{sessionsDir?:string}} env
 * @returns {{ok:boolean, sessionId:string, removed:string[], error?:string}}
 */
export function resetSessionLock(sessionId, env = {}) {
  const raw = String(sessionId || '').trim()
  if (raw === '') return { ok: false, sessionId: raw, removed: [], error: 'sessionId required' }
  const dirs = findSessionDirs(raw)
  const hit = dirs.find((d) => d.name === raw)
  if (!hit) {
    return {
      ok: false,
      sessionId: raw,
      removed: [],
      error: dirs.length > 0 ? 'sessionId must be exact (prefix matched multiple sessions)' : 'session not found',
    }
  }
  const removed = []
  const marker = join(hit.dir, MARKER_NAME)
  if (existsSync(marker)) {
    unlinkSync(marker)
    removed.push(MARKER_NAME)
  }
  for (const name of listMarkerConflicts(hit.dir)) {
    unlinkSync(join(hit.dir, name))
    removed.push(name)
  }
  return { ok: true, sessionId: hit.name, removed }
}
