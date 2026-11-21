/**
 * dsh-xlock — 配置加载。
 *
 * 真身：包内 config.json（随 dsh-plugins 同步面跨机共享）；
 * cordis.patch.yml 的 insert config 可作本机覆盖（apply 第二参）。
 * CLI 只读 config.json（+ --flag 覆盖）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { PKG_ROOT, atomicWriteText, existsSync, readJsonSafe } from './util.mjs'

export const DEFAULTS = Object.freeze({
  /** 非"分叉导出"类隔离条目的保留天数（-1 = 永久）。 */
  retentionDays: 30,
  /** 分叉导出证据的保留天数（更长，作为人裁决的凭据）。 */
  exportRetentionDays: 180,
  /** 隔离区总字节上限（超出最旧优先删）。 */
  maxQuarantineBytes: 536870912, // 512 MiB
  /** 写打开通过门禁后的静默复检等待（毫秒）。0 = 关闭。 */
  acquireQuiesceMs: 0,
  /** 分叉副本遇写打开：'block'（拦截，默认）| 'warn'（放行+报告）。 */
  divergentGate: 'block',
  /** 宿主启动时顺带跑一次隔离区 gc。 */
  startupGc: true,
  /** 是否开启「归档状态跨机同步」（写侧落标记 + 读侧收敛归档集）。默认开。 */
  archiveSyncRoute: true,
  /** 判定「对端此刻还在写」的日志活跃窗口（毫秒）。超过它且 turn 未闭合 → 视为残锁。 */
  sessionActiveMs: 180000,
})

/**
 * 合并配置（默认值 ← config.json ← 覆盖）。
 * @param {object} [overrides]
 * @returns {object}
 */
export function loadConfig(overrides = {}) {
  const file = readJsonSafe(join(PKG_ROOT, 'config.json'), {})
  const merged = { ...DEFAULTS, ...(file || {}), ...(overrides || {}) }
  for (const key of ['retentionDays', 'exportRetentionDays', 'acquireQuiesceMs']) {
    const n = Number(merged[key])
    merged[key] = Number.isFinite(n) ? Math.max(-1, Math.floor(n)) : DEFAULTS[key]
  }
  const bytes = Number(merged.maxQuarantineBytes)
  merged.maxQuarantineBytes = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : DEFAULTS.maxQuarantineBytes
  merged.divergentGate = merged.divergentGate === 'warn' ? 'warn' : 'block'
  merged.startupGc = merged.startupGc !== false
  merged.archiveSyncRoute = merged.archiveSyncRoute !== false
  const activeMs = Number(merged.sessionActiveMs)
  merged.sessionActiveMs = Number.isFinite(activeMs) && activeMs >= 0 ? Math.floor(activeMs) : DEFAULTS.sessionActiveMs
  return merged
}

/**
 * machines.json 的权威路径。
 *
 * 宿主半跑的是 profile 里的**安装副本**（node_modules\dsh-xlock），而 node_modules
 * 不在同步面上：往那里写 machines.json 只有本机看得到，跨机学习就失效了。
 * 所以优先用同步面上的源码包（~/.dsh/dsh-plugins/dsh-xlock）——
 * 两台机器的这个位置都指向同一份 Syncthing 共享目录。找不到才退回包内。
 *
 * @returns {string}
 */
export function registryPath() {
  // 显式覆盖优先（测试与排查用），避免任何情况下误写真实 registry。
  const override = process.env.DSH_XLOCK_REGISTRY
  if (typeof override === 'string' && override !== '') return override
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const synced = join(home, 'dsh-plugins', 'dsh-xlock', 'machines.json')
  if (existsSync(synced)) return synced
  return join(PKG_ROOT, 'machines.json')
}

/**
 * 读 machines.json。
 *
 * 两个区并存（老文件只有 devices，照样能用）：
 * - `machines`: machineId → { host, syncthing, cwds[] }。cwds 是各机 apply 时
 *   自动登记的本地工作区路径，用于「桶名 → 机器」的历史归属推断；
 * - `devices`: Syncthing 设备短 ID → 机器名（冲突副本文件名里的最后一段）。
 *
 * @returns {{machines:Record<string,{host?:string,syncthing?:string,cwds:string[]}>, devices:Record<string,string>}}
 */
export function loadMachines() {
  const data = readJsonSafe(registryPath(), {})
  if (!data || typeof data !== 'object') return { machines: {}, devices: {} }
  const machines = {}
  for (const [machineId, entry] of Object.entries(data.machines || {})) {
    if (!entry || typeof entry !== 'object') continue
    machines[machineId] = {
      host: typeof entry.host === 'string' ? entry.host : undefined,
      syncthing: typeof entry.syncthing === 'string' ? entry.syncthing : undefined,
      cwds: Array.isArray(entry.cwds) ? entry.cwds.filter((c) => typeof c === 'string' && c !== '') : [],
    }
  }
  return { machines, devices: data.devices || {} }
}

/**
 * 把本机的 host / cwds 登记进 registry（apply 时自动学习）。
 * 只增不改：已有条目只补空缺，不覆盖别的机器写下的内容；文件内容不变则不写盘
 * （否则每次启动都会触发一次跨机同步）。
 *
 * @param {{uuid:string,host:string}} identity
 * @param {string[]} cwds 本机近期工作区路径
 * @param {(line:string)=>void} [log]
 * @param {string} [registryFile] 覆盖 registry 路径（测试用；默认同步面上的 machines.json）
 * @returns {boolean} 是否真的写了盘
 */
export function learnRegistry(identity, cwds, log = () => {}, registryFile = registryPath()) {
  const path = registryFile
  const data = readJsonSafe(path, {})
  const base = data && typeof data === 'object' ? data : {}
  const machines = base.machines && typeof base.machines === 'object' ? { ...base.machines } : {}
  const current = machines[identity.uuid] && typeof machines[identity.uuid] === 'object' ? machines[identity.uuid] : {}
  const known = Array.isArray(current.cwds) ? current.cwds.slice() : []
  const merged = known.slice()
  for (const cwd of cwds) {
    if (typeof cwd === 'string' && cwd !== '' && !merged.includes(cwd)) merged.push(cwd)
  }
  const next = {
    host: identity.host,
    ...(typeof current.syncthing === 'string' ? { syncthing: current.syncthing } : {}),
    cwds: merged,
  }
  const before = JSON.stringify(current)
  const after = JSON.stringify(next)
  if (before === after) return false
  machines[identity.uuid] = next
  const out = { ...base, machines }
  try {
    atomicWriteText(path, `${JSON.stringify(out, null, 2)}\n`)
    log(`registry learned: machine=${identity.host} cwds=${merged.join(',') || '(none)'}`)
    return true
  } catch (error) {
    log(`registry learn failed (ignored): ${error?.message || error}`)
    return false
  }
}
