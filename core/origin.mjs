/**
 * dsh-xlock — 会话创建归属判定。
 *
 * 为什么不能复用 `.dsh-xlock.json`（粘锁标记）：
 * 标记记的是【当前/最后持有者】—— acquireMarker 在 released 态会把
 * machineId/host/pid 整组改写成自己（core/marker.mjs）。一台机器打开
 * 别人创建的会话，标记就变成它，归属从此不可考。
 *
 * 三层证据（强 → 弱）：
 *   L1 创建记录（权威）：`<session-dir>/.dsh-xlock-origin.json`，只在
 *      sessionPersistence.create() 那一刻由创建方写入，wx 独占、只写一次，
 *      此后任何机器都不改写。文件名不以 `.jsonl`/`.jsonl.zstd` 结尾，
 *      不会被 dsh-session-persistence-jsonl 的 legacy-layout 检测误判。
 *   L2 目录桶推断（历史回填）：DSH 的会话桶名 = 创建时 cwd 的 projectKey()。
 *     桶名不可逆，但可正向算：拿 registry 里登记过的 cwd 逐个算 projectKey()
 *      比对桶名，命中即得机器。这样 feature 上线前的历史会话也能判。
 *   L3 未知：都没有就报 unknown，绝不猜。
 *
 * 同步面注意：origin 记录在会话目录内（跨机同步），registry 在包目录内
 * （同样跨机共享），两边都可能出现 Syncthing 冲突副本 —— 都要处理。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readJsonSafe } from './util.mjs'

/** 创建记录的固定文件名（只写一次，永不改写）。 */
export const ORIGIN_NAME = '.dsh-xlock-origin.json'

/** 创建记录可能出现的 Syncthing 冲突副本。 */
const ORIGIN_CONFLICT_RE = /^\.dsh-xlock-origin\.json\.sync-conflict-\d{8}-\d{6}-[A-Za-z0-9]+\.\w+$/

/**
 * 复刻 dsh-session-persistence-jsonl 的 projectKey()：
 * `/`、`\`、`:` 折叠成一个 `-`，保留 `[A-Za-z0-9._-]`，其余转 `~XXXX`，
 * 结果 `--${readable.slice(0,251)}--`。桶名由它生成，所以正向比对必须逐字一致。
 * @param {string} cwd
 * @returns {string}
 */
export function projectKey(cwd) {
  const text = String(cwd)
  if (text.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 创建记录文件路径。
 * @param {string} sessionDir
 * @returns {string}
 */
export function originPath(sessionDir) {
  return join(sessionDir, ORIGIN_NAME)
}

/**
 * 读取创建记录。
 * @param {string} sessionDir
 * @returns {{state:'missing'}|{state:'corrupt'}|{state:'ok',data:any}}
 */
export function readOrigin(sessionDir) {
  const path = originPath(sessionDir)
  if (!existsSync(path)) return { state: 'missing' }
  const data = readJsonSafe(path, undefined)
  if (!data || typeof data !== 'object' || typeof data.machineId !== 'string' || data.machineId.length < 8) {
    return { state: 'corrupt' }
  }
  return { state: 'ok', data }
}

/**
 * 列出创建记录的冲突副本（有副本说明两台机器都写过，仍然只是"痕迹"不算争抢）。
 * @param {string} sessionDir
 * @returns {string[]}
 */
export function listOriginConflicts(sessionDir) {
  let names
  try {
    names = readdirSync(sessionDir)
  } catch {
    return []
  }
  return names.filter((name) => ORIGIN_CONFLICT_RE.test(name))
}

/**
 * 写创建记录（wx 独占，只写一次）。已存在 / 目录未物化 → 返回 false。
 * @param {string} sessionDir
 * @param {{uuid:string,host:string}} identity
 * @param {string} sessionId
 * @param {string|undefined} cwd
 * @returns {boolean} 是否由本次调用写入
 */
export function writeOriginOnce(sessionDir, identity, sessionId, cwd) {
  const path = originPath(sessionDir)
  const payload = JSON.stringify(
    {
      v: 1,
      machineId: identity.uuid,
      host: identity.host,
      sessionId,
      cwd: typeof cwd === 'string' ? cwd : null,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  )
  let fd
  try {
    fd = openSync(path, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    if (error?.code === 'ENOENT') {
      try {
        mkdirSync(sessionDir, { recursive: true })
        fd = openSync(path, 'wx')
      } catch {
        return false
      }
    } else {
      return false
    }
  }
  try {
    writeSync(fd, `${payload}\n`)
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 由桶名反查机器：拿 registry 里每个已知机器的 cwds 逐个算 projectKey 比对。
 * @param {string} bucket 例如 "--D-work-demo--"
 * @param {object} registry loadMachines() 结果
 * @returns {{machineId:string, host:string}|undefined}
 */
export function machineByBucket(bucket, registry) {
  const machines = registry?.machines || {}
  for (const [machineId, entry] of Object.entries(machines)) {
    const cwds = Array.isArray(entry?.cwds) ? entry.cwds : []
    for (const cwd of cwds) {
      if (typeof cwd !== 'string' || cwd === '') continue
      let key
      try {
        key = projectKey(cwd)
      } catch {
        continue
      }
      if (key === bucket) return { machineId, host: typeof entry.host === 'string' ? entry.host : machineId }
    }
  }
  return undefined
}

/**
 * registry 里查机器显示名。
 * @param {string|undefined} machineId
 * @param {object} registry
 * @returns {{host:string, known:boolean}}
 */
export function machineLabel(machineId, registry) {
  if (!machineId) return { host: '(unknown)', known: false }
  const entry = registry?.machines?.[machineId]
  if (entry && typeof entry.host === 'string' && entry.host !== '') return { host: entry.host, known: true }
  return { host: machineId, known: false }
}

/**
 * 判一个会话目录的创建归属（三层证据）。
 * @param {string} sessionDir 会话目录
 * @param {{identity:{uuid:string,host:string}, registry?:object, bucket?:string}} env
 *        bucket = 会话桶目录名；不给则从 sessionDir 的父目录名取
 * @returns {{
 *   machineId: string|undefined,
 *   host: string,
 *   known: boolean,
 *   source: 'record'|'bucket'|'unknown',
 *   local: boolean,
 *   conflicts: number,
 *   cwd: string|undefined,
 * }}
 */
export function inferOrigin(sessionDir, env = {}) {
  const registry = env.registry || {}
  const identity = env.identity
  const conflicts = listOriginConflicts(sessionDir).length

  const record = readOrigin(sessionDir)
  if (record.state === 'ok') {
    const machineId = record.data.machineId
    const label = machineLabel(machineId, registry)
    // 记录自带 host 作为兜底（另一台机器还没把 registry 同步过来时也能显示名字）
    const host = label.known ? label.host : typeof record.data.host === 'string' ? record.data.host : machineId
    return {
      machineId,
      host,
      known: label.known || typeof record.data.host === 'string',
      source: 'record',
      local: Boolean(identity && identity.uuid === machineId),
      conflicts,
      cwd: typeof record.data.cwd === 'string' ? record.data.cwd : undefined,
    }
  }

  const bucket =
    typeof env.bucket === 'string' && env.bucket !== ''
      ? env.bucket
      : basename(dirname(sessionDir)) // 会话目录的父目录就是桶名
  if (bucket && bucket !== '.' && bucket !== '') {
    const hit = machineByBucket(bucket, registry)
    if (hit) {
      const label = machineLabel(hit.machineId, registry)
      return {
        machineId: hit.machineId,
        host: label.host,
        known: label.known,
        source: 'bucket',
        local: Boolean(identity && identity.uuid === hit.machineId),
        conflicts,
        cwd: undefined,
      }
    }
  }

  return {
    machineId: undefined,
    host: '(unknown)',
    known: false,
    source: 'unknown',
    local: false,
    conflicts,
    cwd: undefined,
  }
}

/**
 * 归属来源的中文标签（报告用）。
 * @param {'record'|'bucket'|'unknown'} source
 */
export function originSourceLabel(source) {
  if (source === 'record') return '创建记录'
  if (source === 'bucket') return '目录桶推断'
  return '未知'
}
