/**
 * dsh-xlock — 宿主半入口。
 *
 * apply(ctx, config)：
 *   1) loadIdentity()  → 本机指纹（%LOCALAPPDATA%\dsh-xlock\machineId.json）
 *   2) loadConfig(config) → 包内 config.json ← 注入配置（cordis.patch.yml）
 *   3) startupGc → 隔离区按保留期/限额清理（不改任何会话文件）
 *   4) ctx.inject(['sessionPersistence'], sp =>
 *        ctx.effect(wrapPersistence(sp, identity, cfg, log)))
 *
 * 拦截点唯一可行形态：实例级方法赋值（inst.open/inst.create）。
 * 原因：cordis ctx.provide 禁止重提供既有服务；Service 实例经 createTraceable
 * 代理，set 陷阱把赋值透传到原始实例、get 自有属性优先——对所有读者生效。
 */

import z from '@deepseek-ai/schemastery'
import { loadIdentity } from './core/identity.mjs'
import { loadConfig, loadMachines, learnRegistry } from './core/config.mjs'
import { wrapPersistence } from './core/intercept.mjs'
import { gcQuarantine } from './core/quarantine.mjs'
import { registerXlockTool } from './core/xlocktool.mjs'
import { createArchiveSync } from './core/archivesync.mjs'
import { getSessionLockState, listSessionLockStates, listSessionIds, resetSessionLock } from './core/uistate.mjs'
import { fileLog } from './core/util.mjs'

export const name = 'dsh-xlock'

// 说明（UI 不展示 description 就看这里）：
// divergentGate       分叉副本写打开时 'block'(默认,拦截) | 'warn'(放行+日志)
// acquireQuiesceMs    取得标记后的静默复检毫秒数（0=关，默认）
// startupGc           启动顺带清理过期隔离区（默认 true）
// archiveSyncRoute    归档状态跨机同步：写侧落标记 + 读侧收敛归档集（默认 true）
// sessionActiveMs     判定「对端真在写」的日志活跃窗口（毫秒，默认 180000）
// retentionDays / exportRetentionDays / maxQuarantineBytes  隔离区保留策略
export const Config = z.object({
  divergentGate: z.union([z.const('block'), z.const('warn')]).default('block'),
  acquireQuiesceMs: z.number().default(0),
  startupGc: z.boolean().default(true),
  archiveSyncRoute: z.boolean().default(true),
  sessionActiveMs: z.number().default(180000),
  retentionDays: z.number().default(30),
  exportRetentionDays: z.number().default(180),
  maxQuarantineBytes: z.number().default(536870912),
})

export function apply(ctx, config) {
  const cfg = loadConfig(config)
  const identity = loadIdentity()
  // 双通道日志：cordis logger（桌面端吞 stdout，聊胜于无）+ 文件
  // （%LOCALAPPDATA%\dsh-xlock\host.log，排障真凭据）。
  const log = (line, extra) => {
    const text = extra === undefined ? line : `${line} ${JSON.stringify(extra)}`
    fileLog(text)
    if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(`[dsh-xlock] ${text}`)
    else console.error(`[dsh-xlock] ${text}`)
  }

  fileLog(`apply entered: pid=${process.pid} host=${identity.host} gate=${cfg.divergentGate} quiesce=${cfg.acquireQuiesceMs}ms`)
  log(`active: host=${identity.host} machineId=${identity.uuid.slice(0, 8)}… gate=${cfg.divergentGate} quiesce=${cfg.acquireQuiesceMs}ms`)

  if (cfg.startupGc) {
    try {
      const gc = gcQuarantine(cfg)
      if (gc.deleted > 0) {
        log(`startup gc: deleted=${gc.deleted} bytesFreed=${gc.freedBytes} entries=${gc.entries}`)
      }
    } catch (error) {
      log(`startup gc failed (ignored): ${error?.message || error}`)
    }
  }

  // registry 自动学习：把本机 host 与本地工作区路径登记进 machines.json，
  // 让「桶名 → 机器」的历史归属推断在别的机器上也成立。
  // 只增不改、内容不变则不写盘（免得每次启动都触发一次跨机同步）。
  // 一次性副作用，无需 effect 清理。
  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    try {
      const registry = wsCtx?.workspaceRegistry
      if (!registry || typeof registry.list !== 'function') {
        fileLog('registry learn: workspaceRegistry unavailable — skipped')
        return
      }
      const cwds = []
      for (const ws of registry.list()) {
        if (ws && typeof ws.path === 'string' && ws.path !== '') cwds.push(ws.path)
      }
      learnRegistry(identity, cwds, log)
    } catch (error) {
      log(`registry learn skipped (ignored): ${error?.message || error}`)
    }
  })

  // 归档状态跨机同步（从 dsh-tweaks 迁入）：本机归档集变化 → 落标记随会话目录
  // 同步给对端；对端标记 → 收敛到本机归档集。archiveCtx 就是 childCtx，
  // workspaceRegistry 从其属性取（同 registry learn 的注入形态）。
  if (cfg.archiveSyncRoute) {
    try {
      ctx.inject(['sessionPersistence', 'workspaceRegistry'], (archiveCtx) => {
        const wsCtx = archiveCtx?.workspaceRegistry
        if (!wsCtx || typeof wsCtx.archiveSession !== 'function') {
          fileLog('archive sync: workspaceRegistry unavailable — skipped')
          return
        }
        archiveCtx.effect(() => {
          log('archive sync: starting (write markers + read converge)')
          const dispose = createArchiveSync(archiveCtx)
          return () => {
            try { dispose() } catch { /* 服务已卸载 */ }
          }
        }, 'dsh-xlock:archive-sync')
      })
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-xlock archive sync could not start: ${String(error?.message ?? error)}`) } catch {}
    }
  }

  // cordis inject 语义（dsh-agent-loop/src/index.ts:358 同款实证）：回调参数是
  // **Context（childCtx）**，服务要 childCtx.sessionPersistence 属性取——不是
  // 直接把回调参数当服务。effect 也挂在 childCtx 上（dsh-tweaks 同款），
  // 插件卸载时随该 fiber 一起清理。
  ctx.inject(['sessionPersistence'], (childCtx) => {
    const sp = childCtx?.sessionPersistence
    fileLog(`inject fired: childCtx=${typeof childCtx} sp=${typeof sp} open=${typeof sp?.open} create=${typeof sp?.create}`)
    if (!sp || typeof sp.open !== 'function' || typeof sp.create !== 'function') {
      log(`ERROR: inject delivered ${typeof childCtx} without usable sessionPersistence — NOT wrapping (sessions unprotected)`)
      return
    }
    childCtx.effect(() => {
      log('wrapping sessionPersistence (sticky cross-machine lock + repair gates)')
      const restore = wrapPersistence(sp, identity, cfg, log)
      // 诊断+双保险：ctx.get 直读路径（agent-loop createStoredSession 走的就是
      // runtime.ctx.get，不是 inject）若解析到另一实例（服务替换/多 provide），
      // 一并包装；wrapPersistence 幂等守卫（WRAP_TAG+函数名）保证同实例不重入。
      try {
        const got = ctx.get?.('sessionPersistence')
        if (got && typeof got.open === 'function' && typeof got.create === 'function' && got !== sp) {
          const before = got.create?.name
          wrapPersistence(got, identity, cfg, log)
          log(`post-wrap probe: ctx.get resolved a different object (create was ${before}) — wrapped it too`)
        } else {
          log(`post-wrap probe: ctx.get same=${got === sp} type=${typeof got} create=${typeof got?.create}`)
        }
      } catch (error) {
        log(`post-wrap probe failed (ignored): ${error?.message || error}`)
      }
      // cordis effect 回调返回裸函数 = 卸载/禁用时的清理回调（dsh-tweaks 同款）。
      return () => {
        try {
          restore()
        } catch {
          /* 实例已被替换 */
        }
      }
    }, 'dsh-xlock:wrap')
  })

  // 会话锁/归档状态查询 + 显式解锁：给 client 半的徽标/解锁按钮用（PLAN 步骤5）。
  // 纯读本机磁盘标记 + 显式删锁标记，与 xlock 工具的 reset 同语义；归档标记一概不碰。
  ctx.inject(['webServer'], (wsCtx) => {
    const web = wsCtx?.webServer
    if (!web || typeof web.register !== 'function') {
      fileLog('inject webServer: no usable webServer — session-state routes NOT registered')
      return
    }
    const sendJson = (response, status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(payload))
    }
    const readBody = async (request) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? JSON.parse(text) : {}
    }
    wsCtx.effect(() => {
      const offs = []
      offs.push(web.register({
        kind: 'exact',
        path: '/dsh-xlock/session-state',
        handler: async (_request, response) => {
          try {
            sendJson(response, 200, {
              sessions: listSessionLockStates({
                identity,
                registry: loadMachines(),
                activeMs: cfg.sessionActiveMs,
              }),
              refreshedAt: Date.now(),
            })
          } catch (error) {
            log(`session-state route failed: ${error?.message || error}`)
            sendJson(response, 500, { error: String(error?.message ?? error) })
          }
        },
      }))
      offs.push(web.register({
        kind: 'exact',
        path: '/dsh-xlock/session-state/reset',
        handler: async (request, response) => {
          let body = {}
          try { body = await readBody(request) } catch { }
          const result = resetSessionLock(body?.sessionId)
          sendJson(response, result.ok ? 200 : 400, result)
          if (result.ok) log(`session-state reset: ${result.sessionId} removed=${result.removed.join(',')}`)
        },
      }))
      // 全量会话 id 集合：客户端比对集合变化 → 让平台重拉权威基线（异机删会话后
      // 本机不会产生 session/disposed，列表不会自己变）。纯读取。
      offs.push(web.register({
        kind: 'exact',
        path: '/dsh-xlock/session-ids',
        handler: async (_request, response) => {
          try {
            sendJson(response, 200, { ids: listSessionIds(), refreshedAt: Date.now() })
          } catch (error) {
            log(`session-ids route failed: ${error?.message || error}`)
            sendJson(response, 500, { error: String(error?.message ?? error) })
          }
        },
      }))
      log('session-state routes registered: /dsh-xlock/session-state[/reset] + /dsh-xlock/session-ids')
      return () => { for (const off of offs) { try { off() } catch { /* 服务已卸载 */ } } }
    }, 'dsh-xlock:session-state-routes')
  })

  // DSH 原生工具（用户要求 m01580：reset 逃生门必须 GUI/mobile 可达，不依赖 ps1）。
  // 注册形态 = dsh-plugin-market/src/tools.ts:66-71 同款（普通 bundle 直接注册）。
  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx?.tools
    if (!tools || typeof tools.register !== 'function') {
      fileLog('inject tools: no usable tools service — xlock tool NOT registered')
      return
    }
    toolCtx.effect(() => {
      try {
        const unregister = registerXlockTool(tools)
        if (!unregister) {
          fileLog('xlock tool register returned no disposer (tools service unavailable?)')
          return undefined
        }
        log('xlock tool registered: status/audit/reset/resolve/gc')
        return () => {
          try {
            unregister()
          } catch {
            /* 服务已卸载 */
          }
        }
      } catch (error) {
        log(`xlock tool register failed: ${error?.message || error}`)
        return undefined
      }
    }, 'dsh-xlock:tool')
  })
}
