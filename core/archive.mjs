/**
 * dsh-xlock — 归档标记：把「归档」这个跨机传不过来的状态，落到会话目录里。
 *
 * 平台把归档集存在 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`，
 * 而 `storages` **不在同步面上**，于是对端归档一条会话，本机永远不知道 ——
 * 侧栏照旧挂着那一行。会话目录本身是同步的（锁标记就是这么过来的），所以把
 * 归档状态也写进会话目录：谁写都同步得到，且不依赖任何平台私有存储。
 *
 * 本模块（含 core/archivesync.mjs 的双向同步器）整体从 dsh-tweaks 迁入：
 * 「会话相关的跨机同步」从此全部由 dsh-xlock 负责，tweaks 不再参与这件事。
 *
 * 标记文件：`<session-dir>/.dsh-xlock-archive.json`
 *   { v:1, archived:boolean, host, machineId, at }   // at = epoch ms，仅供排障
 *
 * 命名三点约束（决定这个名字的形状，改动前先看清楚）：
 *   ① **必须让 core/marker.mjs 的 MARKER_CONFLICT_RE 负向先行放行 `-archive`**，
 *      否则它的 Syncthing 冲突副本会被当成「粘锁争抢痕迹」抛 XlockHeldError，
 *      把该会话的每一次打开都挡死（这正是迁移前 tweaks 取名要避开 `.dsh-xlock`
 *      前缀的原因，迁移成自己人后必须同步改那条正则）；
 *   ② 与 `.dsh-xlock-origin.json` 同形（单个点开头文件）—— 会话目录是 Syncthing
 *      双向同步面，冲突处理只在**文件**粒度成熟（`<名字>.sync-conflict-…` 副本
 *      能被 xlock 的 core/sessionfs.mjs 盘点、清理）。若写成子目录，冲突会产出
 *      目录副本，既不在任何现有清理路径里，也会一直挂在会话目录里；
 *   ③ 后缀 `.json` 让同步冲突名落在 `…archive.json.sync-conflict-…`，同样是文件。
 *
 * 迁移兼容（双读单写）：旧名 `.dsh-tweaks-archive.json`（dsh-tweaks 时代写下的
 * 存量）仍可读，写只写新文件名。两台机器都升级到本版本后，旧名自然不再新增。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readJsonSafe, ensureDir, atomicWriteText } from './util.mjs'
import { loadIdentity } from './identity.mjs'

/** 归档标记的新文件名（xlock 自己的标记，与锁标记 `.dsh-xlock.json` 同级）。 */
export const ARCHIVE_MARKER_NAME = '.dsh-xlock-archive.json'

/** 旧文件名（dsh-tweaks 时代写下的存量，只读兼容，不再新增）。 */
export const LEGACY_ARCHIVE_MARKER_NAME = '.dsh-tweaks-archive.json'

/**
 * 归档标记（新旧两个名字）+ 任意 Syncthing 冲突副本后缀。
 * 供 core/sessionfs.mjs 分类时复用，避免别处再硬编码一次文件名（耦合病根）。
 */
export const ARCHIVE_MARKER_RE =
  /^\.dsh-(?:xlock|tweaks)-archive\.json(\.sync-conflict-\d{8}-\d{6}-[A-Za-z0-9]+\.\w+)?$/

/**
 * 会话目录里的归档标记完整路径（新名）。
 * @param {string} sessionDir
 * @returns {string}
 */
export function archiveMarkerPath(sessionDir) {
  return join(sessionDir, ARCHIVE_MARKER_NAME)
}

/**
 * 会话目录里的归档标记旧名完整路径（迁移期读兼容用）。
 * @param {string} sessionDir
 * @returns {string}
 */
export function legacyArchiveMarkerPath(sessionDir) {
  return join(sessionDir, LEGACY_ARCHIVE_MARKER_NAME)
}

/**
 * 本机身份（host + machineId）—— 写标记时盖个「谁改的」，仅供排障。
 * 复用 xlock 自己的 loadIdentity()（会按需生成 machineId.json），失败退化成
 * 空身份，绝不因为缺身份文件就让归档标记写不下去。
 */
function archiveIdentity() {
  try {
    const id = loadIdentity()
    return { host: id.host || '', machineId: id.uuid || null }
  } catch {
    return { host: '', machineId: null }
  }
}

/** 会话目录名 → sessionId（目录名以 `session-<uuid>` 结尾时直接用，否则取最后一段）。 */
export function sessionIdFromDirName(name) {
  if (typeof name !== 'string' || !name) return null
  const dash = name.lastIndexOf('-session-')
  if (dash >= 0) return 'session-' + name.slice(dash + '-session-'.length)
  return name.startsWith('session-') ? name : null
}

/**
 * 读一个会话目录里的归档标记（双读：新文件名优先，不存在才读旧文件名）。
 *
 * 返回 `{ archived, by, at, source }`：
 *   · `archived`  —— 这份标记说的是「已归档」还是「已取消归档」（显式 false 也是
 *                    事实，它能让「对端取消归档」同样跨机传播，而不是只能单向归档）；
 *   · `by`/`at`   —— 谁在什么时候写的（host + machineId + epoch ms），供排障；
 *   · `source`    —— `marker`（本机读到标记）/ `none`（没有标记）。
 *
 * 缺失或损坏一律当 `none`：归档状态拿不准时**保持平台原状**，绝不因为读不懂
 * 一个文件就把别人的会话从列表里抹掉。新文件存在但损坏时**不**回退读旧文件，
 * 以免拿一份更早世代的旧数据盖掉真实状态。
 */
export function readArchiveMarker(sessionDir) {
  const primary = archiveMarkerPath(sessionDir)
  const fallback = legacyArchiveMarkerPath(sessionDir)
  const file = existsSync(primary) ? primary : existsSync(fallback) ? fallback : null
  if (!file) return { archived: null, by: null, at: null, source: 'none' }
  const doc = readJsonSafe(file, undefined)
  if (!doc || typeof doc !== 'object' || typeof doc.archived !== 'boolean') {
    return { archived: null, by: null, at: null, source: 'none' }
  }
  return {
    archived: doc.archived,
    by: {
      host: typeof doc.host === 'string' ? doc.host : '',
      machineId: typeof doc.machineId === 'string' ? doc.machineId : '',
    },
    at: Number.isFinite(doc.at) ? doc.at : null,
    source: 'marker',
  }
}

/**
 * 写一个会话目录的归档标记（原子写：temp+rename，复用 core/util.mjs 的
 * atomicWriteText——同目录临时文件 + fsync + rename，比 tweaks 原实现多一层
 * fsync 保障）。
 *
 * **单写**：只写新文件名 `.dsh-xlock-archive.json`，不碰旧文件名（存量那份留着
 * 让还没升级的对端继续读到旧值，双读顺序保证新值优先，不会被旧文件盖回去）。
 *
 * 返回值如实：写成功 `{ ok: true }`，目录不存在/不可写返回 `{ ok: false, error }`，
 * 调用方（同步器）据此决定要不要告警 —— 不假装成功。
 */
export function writeArchiveMarker(sessionDir, archived, identity = archiveIdentity(), now = Date.now()) {
  const me = identity || archiveIdentity()
  const file = archiveMarkerPath(sessionDir)
  try {
    ensureDir(dirname(file))
    atomicWriteText(
      file,
      JSON.stringify({
        v: 1,
        archived: archived === true,
        host: me.host || '',
        machineId: me.machineId || null,
        at: now,
      }) + '\n',
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * 扫全部会话，返回**每条会话目录里归档标记说了什么**：
 * `{ sessionId, dir, archived, by, at, source }`（没有标记的也在结果里，archived 为 null）。
 *
 * 纯读取：只读自己那个小 json，不 stat 日志、不碰任何会话文件。
 * @param {{ sessionsDir?: string }} [options]
 */
export function scanArchiveMarkers({ sessionsDir } = {}) {
  const out = []
  if (!sessionsDir) return out
  let buckets
  try {
    buckets = readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    const bucketDir = join(sessionsDir, bucket.name)
    let dirs
    try {
      dirs = readdirSync(bucketDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const sessionId = sessionIdFromDirName(dir.name)
      if (!sessionId) continue
      const sessionDir = join(bucketDir, dir.name)
      const marker = readArchiveMarker(sessionDir)
      out.push({
        sessionId,
        dir: sessionDir,
        archived: marker.archived,
        by: marker.by,
        at: marker.at,
        source: marker.source,
      })
    }
  }
  return out
}
