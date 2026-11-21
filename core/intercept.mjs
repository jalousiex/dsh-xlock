/**
 * dsh-xlock — sessionPersistence 实例级拦截（锁层心脏）。
 *
 * 唯一宿主级拦截点 = JS 实例级方法赋值（cordis ctx.provide 不可重提供；
 * createTraceable 的 set 陷阱把赋值透传到原始实例，get 时自有属性优先）。
 * 拦截 open(id,'write') 与 create(header)：
 *
 *   open('write'):
 *     1) 标记门禁：异机 held / corrupt / 标记冲突副本 → XlockHeldError
 *        （name='SessionAlreadyOwnedError' → 控制器映射 writer-held 直达 UI）
 *     2) 冲突副本门禁：前缀/identical → 自动隔离；divergent → block|warn
 *     3) 尾部修复门禁：完整帧内 JSONL 末行截断 → 先修复再放行
 *     4) 原始 open → 包装 handle（close → released）
 *
 *   create(header): 原始 create → 包装 handle。初始写入走 jsonl 后端 tracker
 *   的 live routing（原始 handle），包装 append 的懒 ensure 可能永不触发 →
 *   create 后起有界后台轮询（25ms×80≈2s）等物化 → 标记门禁（异机/corrupt →
 *   close 句柄阻止写入）→ acquireMarker。之后包装 append 的 ensure 幂等兜底。
 *
 * 防御边界：门禁内部【非 Xlock*】的意外异常一律放行并记日志（插件的 bug
 * 不许弄哑用户的会话）；Xlock* 是有意 fail-safe。
 */

import { dirname } from 'node:path'
import {
  XlockHeldError,
  acquireMarker,
  markerStatus,
  releaseMarker,
} from './marker.mjs'
import { loadMachines } from './config.mjs'
import { inventorySessionDir, machineName } from './sessionfs.mjs'
import { writeOriginOnce } from './origin.mjs'
import { auditCopyFile } from './classify.mjs'
import { quarantineFile, quarantineCopyOf, ledgerAppend } from './quarantine.mjs'
import { tailRepairIfNeeded } from './repair.mjs'
import { isoUtc } from './util.mjs'

const WRAP_TAG = Symbol('dsh-xlock.wrapped')

/** 门禁专用错误：分叉副本拦截（controller 走 gateway/internal，消息直达 UI）。 */
export class XlockDivergentError extends Error {
  constructor(sessionId, message) {
    super(message)
    this.name = 'XlockDivergentError'
    this.sessionId = sessionId
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 包装 sessionPersistence 服务实例。
 * @param {object} inst SessionPersistence 实例（可能是 cordis 代理）
 * @param {{uuid:string,host:string}} identity
 * @param {object} cfg loadConfig() 结果
 * @param {(line:string, extra?:object) => void} log 日志函数
 * @returns {() => void} 还原函数（effect 清理用）
 */
export function wrapPersistence(inst, identity, cfg, log) {
  // 幂等守卫：WRAP_TAG（defineProperty 可能被代理拒绝）+ 函数名双保险，
  // 防止对已包装实例二次包装导致 origOpen=wrappedOpen 递归。
  const alreadyWrapped = Boolean(inst) && (
    inst[WRAP_TAG]
    || inst.open?.name === 'wrappedOpen'
    || inst.create?.name === 'wrappedCreate'
  )
  if (!inst || typeof inst.open !== 'function' || alreadyWrapped) {
    return () => {}
  }
  const origOpen = inst.open.bind(inst)
  const origCreate = inst.create.bind(inst)
  const origStat = inst.stat.bind(inst)

  // 同目录串行化（进程内并发 open 的标记操作互斥）。
  const queues = new Map()
  function serialized(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    queues.set(key, next.catch(() => {}))
    return next
  }

  function throwHeld(sessionId, message) {
    throw new XlockHeldError(sessionId, message)
  }

  /**
   * 冲突副本门禁。返回处理动作列表（供日志）。
   */
  function conflictCopyGate(sessionDir, sessionId) {
    const inv = inventorySessionDir(sessionDir)
    if (inv.logConflicts.length === 0 && inv.markerConflicts.length === 0) return []
    const machines = loadMachines()
    const actions = []
    // 标记冲突副本：异机持锁痕迹 → 拦（AC10）。
    if (inv.markerConflicts.length > 0) {
      throwHeld(
        sessionId,
        `session "${sessionId}" lock marker has sync-conflict copies — two machines contested it. ` +
          `Use the xlock tool: reset then audit this session`,
      )
    }
    // 日志冲突副本：同版本 canonical 为参照。
    const canonicalByVer = new Map(inv.canonical.map((c) => [c.version, c]))
    for (const copy of inv.logConflicts) {
      const primary = canonicalByVer.get(copy.version)
      let verdict
      try {
        verdict = auditCopyFile(copy.path, primary ? primary.path : copy.path.replace(copy.name, `session.v${copy.version}.jsonl.zstd`))
      } catch (error) {
        verdict = { kind: 'unreadable', error: String(error?.message || error) }
      }
      const mn = machineName(copy.shortId, machines)
      const from = `from ${mn.known ? mn.name : `device ${copy.shortId}(未补录)`}`
      if (verdict.kind === 'identical' || verdict.kind === 'prefix') {
        const dir = quarantineFile(copy.path, {
          sessionId,
          kind: 'conflict-copy',
          classifiedAs: verdict.kind,
          machines: { copy: mn.name, shortId: copy.shortId },
          action: 'auto-quarantine',
          note: `write-open gate: ${verdict.kind} copy (${from})`,
        })
        actions.push(`auto-quarantined ${verdict.kind} copy ${copy.name} → ${dir}`)
        continue
      }
      if (verdict.kind === 'divergent') {
        if (cfg.divergentGate === 'warn') {
          log(`divergent copy on write-open (warn mode): ${copy.name} ${from} firstDivergenceSeq=${verdict.firstDivergenceSeq}`)
          actions.push(`warn: divergent copy ${copy.name} left in place`)
          continue
        }
        ledgerAppend({ action: 'gate-block', kind: 'divergent', sessionId, file: copy.name, firstDivergenceSeq: verdict.firstDivergenceSeq })
        throw new XlockDivergentError(
          sessionId,
          `session "${sessionId}" has an unresolved DIVERGENT sync-conflict copy (${copy.name}, ${from}, ` +
            `first divergence seq=${verdict.firstDivergenceSeq}). ` +
            `Use the xlock tool audit to compare both sides, then the xlock tool resolve ` +
            `${sessionId} --keep primary|copy`,
        )
      }
      if (verdict.kind === 'orphan') {
        // 同版本主文件缺失（副本比现存文件还新？）→ 保守拦截，交人判断。
        throw new XlockDivergentError(
          sessionId,
          `session "${sessionId}" has a sync-conflict copy (${copy.name}, ${from}) whose version has no ` +
            `canonical file — resolve manually: use the xlock tool audit ${sessionId}`,
        )
      }
      // unreadable：fail-safe 拦截。
      throwHeld(
        sessionId,
        `session "${sessionId}" has an unreadable sync-conflict copy (${copy.name}) — ` +
          `fail-safe block; use the xlock tool audit ${sessionId}`,
      )
    }
    return actions
  }

  async function wrappedOpen(id, access, options) {
    if (access !== 'write') return origOpen(id, access, options)
    log(`write-open gate: id=${id}`)
    let snap
    try {
      snap = await origStat(id)
    } catch (error) {
      log(`write-open stat failed (treat as unmaterialized): id=${id} err=${error?.message || error}`)
      snap = undefined
    }
    const location = snap && snap.location
    if (!location || !location.path) {
      // 未物化（尚无文件）→ 无锁面，直接走原始 open（NotFound 原样抛）。
      log(`write-open passthrough (unmaterialized): id=${id}`)
      return origOpen(id, 'write', options)
    }
    const sessionDir = dirname(location.path)
    await serialized(sessionDir, async () => {
      // 0) 标记门禁（最先：异机持有时不动目录里任何文件，AC1 文件 hash 不变）。
      const marker = markerStatus(sessionDir, identity)
      if (marker.corrupt) {
        throwHeld(id, `session "${id}" lock marker is corrupt (fail-safe) — use the xlock tool (action "reset") to clear it`)
      }
      if (marker.foreign) {
        const holder = marker.holder?.host || marker.conflicts?.join(', ') || 'another machine'
        throwHeld(
          id,
          `session "${id}" is locked on host "${holder}" (sticky lock marker; the owning machine crashed ` +
            `or still runs). To take over: confirm the owning machine has stopped writing, then run the ` +
            `xlock tool (action "reset", session "${id}") — or delete the marker file directly`,
        )
      }
      try {
        // 1) 冲突副本门禁（可能自动隔离/抛 XlockDivergentError）。
        const actions = conflictCopyGate(sessionDir, id)
        for (const line of actions) log(line)
        // 2) 尾部修复门禁（可能重写文件）。
        const repair = tailRepairIfNeeded(location.path, {
          sessionId: id,
          quarantineCopy: (src, meta) =>
            // 复制语义留证：修复要原位重写原路径，不能先搬走原文件。
            quarantineCopyOf(src, { sessionId: id, kind: meta.kind, action: 'pre-repair-backup', note: 'torn JSONL last line in complete frame', extra: { droppedBytes: meta.droppedBytes } }),
          log,
        })
        if (repair.repaired) {
          log(`tail repair applied for session "${id}": droppedBytes=${repair.droppedBytes}${repair.quarantineDir ? ` pre-repair copy at ${repair.quarantineDir}` : ''}`)
        }
        // 3) 取得本机持锁（missing→wx / released→翻转 / held+本机→保持）。
        acquireMarker(sessionDir, identity, id)
        log(`marker held: id=${id} host=${identity.host}`)
        // 4) 可选静默复检：等同步窗口过去后确认标记仍归我们。
        if (cfg.acquireQuiesceMs > 0) {
          await sleep(cfg.acquireQuiesceMs)
          const re = markerStatus(sessionDir, identity)
          if (re.foreign || re.corrupt) {
            throwHeld(
              id,
              `session "${id}" lock marker changed during acquire quiesce (${re.corrupt ? 'corrupt' : re.holder?.host || 'foreign'}) — blocking`,
            )
          }
          acquireMarker(sessionDir, identity, id)
        }
      } catch (error) {
        // 有意拦截 → 原样抛；插件自身 bug → 放行（不许弄哑用户会话）。
        if (error instanceof XlockHeldError || error instanceof XlockDivergentError) throw error
        log(`dsh-xlock gate unexpected error (fail-open): ${error?.stack || error}`)
        return
      }
    })
    const handle = await origOpen(id, 'write', options)
    return wrapWriteHandle(handle, { dir: sessionDir, id, ensured: true, origStat })
  }

  async function wrappedCreate(header, options) {
    log(`create gate: pid=${process.pid} id=${header.id}`)
    const handle = await origCreate(header, options)
    const state = { dir: undefined, id: header.id, ensured: false, origStat, cwd: header?.cwd, fromCreate: true }
    wrapWriteHandle(handle, state)
    scheduleCreateEnsure(handle, state)
    return handle
  }

  /**
   * create 后的有界后台 ensure：等目录物化 → 补挂粘性标记。
   * 子代理/GUI 新会话的初始写入走 live routing（原始 handle），包装 append
   * 可能永不触发，标记必须在这里补挂。异机/corrupt → close 句柄阻止写入。
   */
  function scheduleCreateEnsure(handle, state) {
    void (async () => {
      for (let attempt = 0; attempt < 80; attempt++) {
        await sleep(25)
        try {
          const snap = await state.origStat(state.id)
          const dir = snap?.location?.path ? dirname(snap.location.path) : undefined
          if (!dir) continue
          let blocked = false
          await serialized(dir, async () => {
            if (state.ensured) return
            const marker = markerStatus(dir, identity)
            if (marker.corrupt || marker.foreign) {
              blocked = true
              log(`create blocked (${marker.corrupt ? 'corrupt' : `foreign ${marker.holder?.host || 'machine'}`}): id=${state.id} — closing handle`)
              return
            }
            acquireMarker(dir, identity, state.id)
            state.dir = dir
            state.ensured = true
            log(`marker ensured on create: id=${state.id} host=${identity.host}`)
            // 创建归属记录：wx 独占、只写一次。写失败不影响会话（纯元数据）。
            if (writeOriginOnce(dir, identity, state.id, state.cwd)) {
              log(`origin recorded: id=${state.id} host=${identity.host} cwd=${state.cwd || '(none)'}`)
            }
          })
          if (blocked) {
            try { await handle.close() } catch { /* wrapped close 吞错 */ }
            return
          }
          if (state.ensured) return
        } catch (error) {
          // 门禁内部意外错误 → 放弃 ensure（fail-open），后续包装 append 仍可补挂。
          log(`create ensure unexpected error (give up): id=${state.id} err=${error?.stack || error}`)
          return
        }
      }
      log(`create ensure gave up (never materialized within 2s): id=${state.id}`)
    })()
  }

  function wrapWriteHandle(handle, state) {
    const origAppend = handle.append.bind(handle)
    const origClose = handle.close.bind(handle)
    handle.append = async (events, options) => {
      if (!state.ensured && Array.isArray(events) && events.length > 0) {
        state.ensured = true
        try {
          let dir = state.dir
          if (!dir) {
            const snap = await state.origStat(state.id)
            dir = snap?.location?.path ? dirname(snap.location.path) : undefined
            log(`ensure stat: pid=${process.pid} id=${state.id} dir=${dir || 'none'}`)
            if (!dir) {
              // 仍未物化（append 失败？）→ 下一次 append 再补。
              state.ensured = false
              return origAppend(events, options)
            }
            state.dir = dir
          }
          const marker = markerStatus(dir, identity)
          if (marker.corrupt || marker.foreign) {
            throwHeld(
              state.id,
              `session "${state.id}" is locked on host "${marker.holder?.host || 'another machine'}" ` +
                `(marker appeared before first append). To take over: run the xlock tool ` +
                `(action "reset", session "${state.id}") or delete the marker file`,
            )
          }
          acquireMarker(dir, identity, state.id)
          log(`marker ensured on first append: id=${state.id} host=${identity.host}`)
          if (state.fromCreate) {
            // 兜底路径：create 的 ensure 没在 2s 内物化时，首次 append 补写归属。
            if (writeOriginOnce(dir, identity, state.id, state.cwd)) {
              log(`origin recorded on first append: id=${state.id} host=${identity.host} cwd=${state.cwd || '(none)'}`)
            }
          }
        } catch (error) {
          try {
            await origClose()
          } catch {
            /* close 失败不掩盖原始错误 */
          }
          throw error
        }
      }
      return origAppend(events, options)
    }
    handle.close = async () => {
      try {
        return await origClose()
      } finally {
        if (state.dir) releaseMarker(state.dir, identity) // 吞错：close 语义优先
      }
    }
    return handle
  }

  inst.open = wrappedOpen
  inst.create = wrappedCreate
  try {
    Object.defineProperty(inst, WRAP_TAG, { value: { at: isoUtc() }, enumerable: false, configurable: true })
  } catch {
    /* 代理拒绝定义符号 → 无法标记，靠还原函数兜底 */
  }

  return function restore() {
    try {
      inst.open = origOpen
      inst.create = origCreate
    } catch {
      /* 实例已被替换 */
    }
  }
}
