/**
 * dsh-xlock — 粘性懒加载锁标记。
 *
 * 标记：<session-dir>/.dsh-xlock.json
 *   { v:1, machineId, host, pid, sessionId, state:'held'|'released' }
 *
 * 状态机（终稿）：
 * - 无标记     → `fs.openSync(p,'wx')` 独占原子创建 held（创建即互斥原语）；
 * - held+本机  → 放行（崩溃残留自愈路径）；
 * - held+异机 / 标记损坏 / 标记出现 sync-conflict 副本 → 拦截
 *   （抛 name='SessionAlreadyOwnedError' 的 Error，控制器映射为
 *   session/writer-held，message 携带持有主机名与 reset 指引直达 UI）；
 * - released（任意机）→ 原子翻转 held 放行；
 * - 释放：close → 原子改写 released（不删除；分钟级同步延迟下
 *   released 态让对机立刻可接管，也不留"幽灵 held"）；
 * - 崩溃：无 close → held 残留 → 异机持续被拦（有意 fail-safe）。
 *
 * 无决策用时间戳：跨机时钟不可信，状态只由显式翻转推进。
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteText, readJsonSafe } from './util.mjs'

export const MARKER_NAME = '.dsh-xlock.json'

/**
 * marker 文件名 + 任意 sync-conflict 变体（Syncthing 冲突副本）。
 *
 * 必须排除 `.dsh-xlock-origin*` 与 `.dsh-xlock-archive*`：创建归属记录
 * （core/origin.mjs）和归档标记（core/archive.mjs）都住在同一目录，它们的
 * 冲突副本只是"两台机都写过"的痕迹，不是争抢，不该把会话挡住
 * （(?!-origin|-archive) 这一处就是防线）。
 */
const MARKER_CONFLICT_RE = /^\.dsh-xlock(?!-origin|-archive).*\.sync-conflict-\d{8}-\d{6}-[A-Za-z0-9]+\.\w+$/

/**
 * 跨机/异常拦截错误。name 固定为 SessionAlreadyOwnedError，
 * dsh-api-session-controller/src/agent.ts:199 按 name 捕获并映射
 * RemoteError('session/writer-held', message) —— message 直达 UI。
 */
export class XlockHeldError extends Error {
  /**
   * @param {string} sessionId
   * @param {string} message 完整提示（含持有方与逃生门指引）
   */
  constructor(sessionId, message) {
    super(message)
    this.name = 'SessionAlreadyOwnedError'
    this.sessionId = sessionId
  }
}

/**
 * 会话目录内的标记绝对路径。
 * @param {string} sessionDir
 */
export function markerPath(sessionDir) {
  return join(sessionDir, MARKER_NAME)
}

/**
 * 读取标记。
 * @returns {{state:'missing'}|{state:'corrupt'}|{state:'ok',data:any}}
 */
export function readMarker(sessionDir) {
  const path = markerPath(sessionDir)
  if (!existsSync(path)) return { state: 'missing' }
  const data = readJsonSafe(path, undefined)
  if (!data || typeof data !== 'object' || (data.state !== 'held' && data.state !== 'released')) {
    return { state: 'corrupt' }
  }
  return { state: 'ok', data }
}

/**
 * 扫描会话目录中的标记冲突副本（.dsh-xlock*.sync-conflict-*.json）。
 * 存在即视为"异机持锁痕迹"——fail-safe 拦截。
 * @param {string} sessionDir
 * @returns {string[]}
 */
export function listMarkerConflicts(sessionDir) {
  let names
  try {
    names = readdirSync(sessionDir)
  } catch {
    return []
  }
  return names.filter((name) => MARKER_CONFLICT_RE.test(name))
}

/**
 * 以 wx 独占创建 held 标记（无则创建；已存在返回 false）。
 * @returns {boolean} 是否由本次调用创建
 */
export function createHeldMarker(sessionDir, identity, sessionId) {
  const path = markerPath(sessionDir)
  const payload = JSON.stringify({
    v: 1,
    machineId: identity.uuid,
    host: identity.host,
    pid: process.pid,
    sessionId,
    state: 'held',
  })
  let fd
  try {
    fd = openSync(path, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    if (error?.code === 'ENOENT') {
      mkdirSync(sessionDir, { recursive: true })
      fd = openSync(path, 'wx')
    } else {
      throw error
    }
  }
  try {
    writeSync(fd, `${payload}\n`, 0, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return true
}

/**
 * 原子写完整标记内容（temp+rename）。
 */
function writeMarker(sessionDir, data) {
  atomicWriteText(markerPath(sessionDir), `${JSON.stringify(data)}\n`)
}

/**
 * 取得本机持锁（幂等）：
 * - missing → wx 创建；
 * - released → 翻转 held（机器字段换成自己）；
 * - held+本机 → 保持；
 * - held+异机 / corrupt / 存在标记冲突副本 → 抛 XlockHeldError。
 * @param {string} sessionDir
 * @param {{uuid:string,host:string}} identity
 * @param {string} sessionId
 */
export function acquireMarker(sessionDir, identity, sessionId) {
  const conflicts = listMarkerConflicts(sessionDir)
  if (conflicts.length > 0) {
    throw new XlockHeldError(
      sessionId,
      `session "${sessionId}" lock marker has sync-conflict copies (${conflicts.join(', ')}) — ` +
        `two machines contested this session; use the xlock tool: reset then audit before resuming`,
    )
  }
  const marker = readMarker(sessionDir)
  if (marker.state === 'corrupt') {
    throw new XlockHeldError(
      sessionId,
      `session "${sessionId}" lock marker is corrupt (fail-safe) — use the xlock tool (action "reset") to clear it`,
    )
  }
  if (marker.state === 'ok' && marker.data.state === 'held' && marker.data.machineId !== identity.uuid) {
    throw new XlockHeldError(
      sessionId,
      `session "${sessionId}" is locked on host "${marker.data.host || 'unknown'}" ` +
        `(sticky lock marker; the owning machine crashed or still runs). ` +
        `To take over: confirm the owning machine has stopped writing, then run the xlock tool ` +
          `(action "reset", session "${sessionId}") — or delete the marker file directly`,
    )
  }
  if (marker.state === 'ok' && marker.data.state === 'held') return // 本机已持
  if (marker.state === 'missing') {
    if (createHeldMarker(sessionDir, identity, sessionId)) return
    // wx 输了：另一进程/同步刚创建 → 重读再判（绝不盲写覆盖）。
    return acquireMarker(sessionDir, identity, sessionId)
  }
  // released（任意机）→ 原子翻转 held。
  writeMarker(sessionDir, {
    v: 1,
    machineId: identity.uuid,
    host: identity.host,
    pid: process.pid,
    sessionId,
    state: 'held',
  })
}

/**
 * 释放锁：held → released（原子改写，不删除）。
 * 任何失败都吞掉（close 语义优先：绝不因标记写失败破坏 close）。
 * @returns {boolean} 是否成功落为 released
 */
export function releaseMarker(sessionDir, identity) {
  try {
    const marker = readMarker(sessionDir)
    if (marker.state !== 'ok') return marker.state === 'missing'
    if (marker.data.state === 'released') return true
    // 异机持有 → 不翻转：本进程从未持有该标记，盲翻会让异机的锁失明
    // （跨机陈旧 close 的防护——identity 缺省时保持旧行为，供测试夹具使用）。
    if (identity && marker.data.machineId && marker.data.machineId !== identity.uuid) return false
    writeMarker(sessionDir, { ...marker.data, state: 'released', pid: 0 })
    return true
  } catch {
    return false
  }
}

/**
 * 便捷判断（供 status/audit）：标记是否正被异机持有。
 * @returns {{foreign:boolean, holder?:{host?:string,machineId?:string}, conflicts:string[], corrupt:boolean}}
 */
export function markerStatus(sessionDir, identity) {
  const conflicts = listMarkerConflicts(sessionDir)
  const marker = readMarker(sessionDir)
  if (marker.state === 'missing') {
    return { foreign: conflicts.length > 0, conflicts, corrupt: false }
  }
  if (marker.state === 'corrupt') {
    return { foreign: true, conflicts, corrupt: true }
  }
  const held = marker.data.state === 'held'
  const foreign = held && marker.data.machineId !== identity.uuid
  return {
    foreign,
    conflicts,
    corrupt: false,
    state: marker.data.state,
    holder: { host: marker.data.host, machineId: marker.data.machineId, pid: marker.data.pid },
    heldByLocal: held && !foreign,
  }
}

/** 测试/CLI 用：标记文件是否存在。 */
export function markerExists(sessionDir) {
  return existsSync(markerPath(sessionDir))
}
