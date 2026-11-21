/**
 * dsh-xlock — 归档状态跨机同步器（core/archivesync.mjs）
 *
 * 把宿主 `~/.dsh/storages/workspace.json`（不在同步面）里 `global.archivedSessionIds`
 * 这份**本机归档集**，和会话目录（在同步面，经 Syncthing 跨机同步）里每个会话的
 * 归档标记文件（core/archive.mjs，`.dsh-xlock-archive.json`）做成双向对账：
 *
 *   写侧：宿主归档集变化（domain/changed 事件）→ 差异落成标记文件，随会话目录
 *          走文件级同步推给对端机器。
 *   读侧：对端写的标记文件 → 收敛到本机宿主归档集（workspaceRegistry.archiveSession /
 *          unarchiveSession），让对端的归档决定在本机也生效。
 *
 * 这套机制原先住在 dsh-tweaks（`createArchiveSync`，index.js:1326-1450），现在按
 * 用户要求整体搬来 xlock（tweaks 不参与 xlock 会话相关的任何功能）。原实现的三条
 * 纪律（只处理真变化、目录索引一次建全、盘上已是目标值不重写防回声）原样保留，
 * 只是标记文件名和存放位置换成了 xlock 自己的命名空间（core/archive.mjs，双读单写
 * 兼容存量 `.dsh-tweaks-archive.json`）。
 *
 * 非目标：不做归档与锁（core/marker.mjs）的因果绑定——归档与否不影响粘锁状态，
 * 两者是同一目录里的两套独立标记，只是共享"贴身跟着会话目录走同步面"这条路。
 */

import { scanArchiveMarkers, writeArchiveMarker } from './archive.mjs'
import { sessionsRoot } from './sessionfs.mjs'

function nonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * 启动（或按需）对账一次归档集 ↔ 归档标记。
 *
 * ctx 需要暴露 `workspaceRegistry`（`archiveSession`/`unarchiveSession` 两个函数 +
 * `archivedSessionIds` 数组）；三者任一缺失即整体退化成空函数（no-op），不报错——
 * 单元测试里可以只给 `{ logger: {}, on: () => () => {} }` 这种最小上下文验证不崩。
 *
 * 返回 disposer（清理定时器 + 注销 domain/changed 订阅）；额外暴露 `dispose.scan`
 * （单次读侧对账）和 `dispose.writeDiff`（单次写侧对账），仅供独立测试 harness 直接
 * 调用——Cordis 只把返回值当 disposer 用，这两个属性是测试钩子，不是公开 API。
 *
 * @param {{ workspaceRegistry?: object, on?: Function, logger?: object }} ctx
 * @param {number} [intervalMs=15000] 读侧对账轮询间隔；0 = 关闭定时器（只跑一次/手动触发）。
 * @returns {(() => void) & { scan?: Function, writeDiff?: Function }}
 */
export function createArchiveSync(ctx, intervalMs = 15000) {
  const delay = nonNegativeInt(intervalMs, 15000)
  const registry = ctx?.workspaceRegistry
  if (
    delay === 0 || !registry || typeof registry.archiveSession !== 'function' ||
    typeof registry.unarchiveSession !== 'function' || !Array.isArray(registry.archivedSessionIds)
  ) return () => {}

  let stopped = false
  let activeScan
  let knownArchived = new Set(registry.archivedSessionIds.map(String))

  function warn(key, error) {
    try { ctx.logger?.warn?.(`dsh-xlock archive sync: ${key}: ${String(error?.message ?? error)}`) } catch {}
  }

  /**
   * 写侧：把归档集的差异落成标记。`next` 是本机此刻的归档集（权威）。
   *
   * 三条纪律：
   *   ① 只处理「相对上一轮真的变了」的 id —— 否则任何一次无关的 workspace 写
   *      （改标题、加成员）都会重写全部会话目录，把同步面搅成噪音；
   *   ② 目录索引一次建全 —— 批量归档几十条时不能每条都重扫一遍目录树；
   *   ③ 盘上那份已经写着目标值时**不重写** —— 读侧把对端的标记应用到本机归档集
   *      之后会经由 `domain/changed` 回到这里，重写会把「是谁归档的」抹成本机。
   *      值一致就没有什么要传播的，跳过即可（这也顺带掐断了回声）。
   */
  function writeDiff(next) {
    const added = [...next].filter((id) => !knownArchived.has(id))
    const removed = [...knownArchived].filter((id) => !next.has(id))
    if (added.length === 0 && removed.length === 0) return
    const index = new Map(
      scanArchiveMarkers({ sessionsDir: sessionsRoot() }).map((row) => [row.sessionId, row]),
    )
    for (const id of [...added, ...removed]) {
      const archived = added.includes(id)
      const row = index.get(id)
      if (row === undefined) continue
      const remember = () => {
        knownArchived = archived
          ? new Set([...knownArchived, id])
          : new Set([...knownArchived].filter((x) => x !== id))
      }
      // 盘上已经是目标值：那是读侧刚应用的对端标记，重写会把作者抹成本机。
      if (row.source === 'marker' && row.archived === archived) {
        remember()
        continue
      }
      const result = writeArchiveMarker(row.dir, archived)
      if (result.ok) remember()
      else warn(`write ${id}`, result.error)
    }
  }

  /**
   * 读侧：对端写的标记 → 本机归档集。
   *
   * 只动「与宿主归档集不一致」的会话。异常一律只记日志：一条会话收敛失败不该
   * 拖住其余会话，更不该让插件崩掉。
   */
  async function applyMarkers() {
    const markers = scanArchiveMarkers({ sessionsDir: sessionsRoot() })
    const current = new Set(registry.archivedSessionIds.map(String))
    for (const row of markers) {
      if (stopped) return
      if (row.source !== 'marker' || typeof row.archived !== 'boolean') continue
      const wanted = row.archived
      if (current.has(row.sessionId) === wanted) continue
      try {
        if (wanted) await registry.archiveSession(row.sessionId, { stopActivity: true })
        else await registry.unarchiveSession(row.sessionId)
        if (wanted) current.add(row.sessionId)
        else current.delete(row.sessionId)
      } catch (error) {
        warn(`apply ${row.sessionId}`, error)
      }
    }
  }

  async function scanOnce() {
    try {
      await applyMarkers()
    } catch (error) {
      warn('marks', error)
    }
  }

  function scan() {
    if (stopped) return Promise.resolve()
    if (activeScan) return activeScan
    activeScan = scanOnce()
      .catch((error) => warn('list', error))
      .finally(() => { activeScan = undefined })
    return activeScan
  }

  // 写侧：只在归档集真的变化时落标记（`domain/changed` 的 global put）。
  const offChanged = typeof ctx.on === 'function'
    ? ctx.on('domain/changed', (change) => {
      if (!change || change.domain !== 'workspace') return
      if (change.table !== '' || change.operation !== 'put') return
      const next = new Set(
        Array.isArray(change.value?.archivedSessionIds) ? change.value.archivedSessionIds.map(String) : [],
      )
      try {
        writeDiff(next)
      } catch (error) {
        warn('write', error)
      }
    })
    : null

  const timer = setInterval(() => { void scan() }, delay)
  void scan()

  function dispose() {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (typeof offChanged === 'function') { try { offChanged() } catch {} }
  }
  // Exposed only to the standalone test harness; Cordis uses the disposer itself.
  dispose.scan = scan
  dispose.writeDiff = writeDiff
  return dispose
}
