/**
 * dsh-xlock — 会话活跃度探测（core/live.mjs）
 *
 * 回答一个问题：**另一台机器此刻真的在写这条会话，还是只留下了锁标记？**
 *
 * 平台没有跨机运行状态协议：`sessionController.list` 的 `running` 只认本进程的 live
 * Agent，冷行一律 false。所以只能从本机就能看到的两个客观事实推导——锁标记为 held
 * 且持有方不是本机，再看会话日志还新不新。纯读取，不碰任何会话文件。
 *
 * 两种状态必须长得不一样：
 *   writing  对端真在写（日志新鲜，或最后一轮 turn 还没收尾）
 *   silent   标记还在但日志早停了（残锁，崩溃/未 close 留下的）
 *
 * 注意：**不做新鲜度截断**。残锁恰恰是最需要人看见并解锁的情况，早期实现把超过
 * 15 分钟的标记整个丢弃，等于把最该暴露的状态藏起来。
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 会话目录里代表「日志正在增长」的文件名（jsonl / jsonl.zstd 两代格式）。 */
export const SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']

/** Syncthing 接收中的临时文件前缀 / 冲突副本标记。 */
const SYNCTHING_TMP_PREFIX = '~syncthing~'
const SYNCTHING_CONFLICT_MARK = '.sync-conflict-'

/** zstd 帧魔数：会话日志是多帧拼接，解尾帧要先找到帧边界。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 只看日志尾巴的字节数。够了：一次 turn 的收尾/开启总在最后几帧里。 */
const TAIL_BYTES = 262144

/**
 * 会话目录里「对端最近一次写」的时间（毫秒）；没有可判读的文件返回 null。
 *
 * 为什么不能只看正式日志的 mtime：跨机同步走 Syncthing，它是「先写
 * `~syncthing~<name>.tmp`，整份收完再 rename 盖住正式文件」。对端每隔几秒就追加
 * 一段 zstd，本地这份就得整份重传一次 —— 日志越大，正式文件的 mtime 落后越久
 * （实测 1.2 MB 的日志能落后好几分钟）。只盯正式文件会把「正在传输」误判成
 * 「已停止」。所以把正在接收的临时文件、以及 `.sync-conflict-*` 副本也算作证据。
 *
 * @param {string} dir
 * @returns {number|null}
 */
export function sessionLogMtime(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  let best = null
  for (const name of names) {
    const isLog = SESSION_LOG_NAMES.includes(name)
    const isIncoming = name.startsWith(SYNCTHING_TMP_PREFIX) && SESSION_LOG_NAMES.some((log) => name.includes(log))
    const isConflict = name.includes(SYNCTHING_CONFLICT_MARK) && SESSION_LOG_NAMES.some((log) => name.includes(log))
    if (!isLog && !isIncoming && !isConflict) continue
    try {
      const info = statSync(join(dir, name))
      if (!info.isFile()) continue
      if (best === null || info.mtimeMs > best) best = info.mtimeMs
    } catch {
      /* 正在被 rename 覆盖，下次再看 */
    }
  }
  return best
}

/**
 * 读日志**尾部**，判断最后一轮是否还没收尾（`turn/start` 之后没有 `turn/end`）。
 *
 * 光看 mtime 判不出「在跑但在等」——对端跑一个长工具调用可以几分钟不写日志，那段
 * 静默会被误判成「已停止」。反过来，日志停在那里但 turn 没闭合，就说明它还在轮次
 * 中间。返回 `true`（未收尾）/ `false`（已收尾）/ `null`（读不到或格式不认识）。
 *
 * @param {string} sessionDir
 * @returns {boolean|null}
 */
export function tailHasOpenTurn(sessionDir) {
  if (!sessionDir) return null
  let file = null
  for (const name of SESSION_LOG_NAMES) {
    const candidate = join(sessionDir, name)
    try {
      if (statSync(candidate).isFile()) {
        file = candidate
        break
      }
    } catch {
      /* 试下一个候选名 */
    }
  }
  if (file === null) return null
  let fd = null
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size <= 0) return null
    const take = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(take)
    readSync(fd, buffer, 0, take, size - take)
    let text
    if (file.endsWith('.jsonl.zstd')) {
      // 多帧 zstd：从块内第一个帧边界解到末尾，拼起来再按行解析。
      const starts = []
      for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + 4)) starts.push(at)
      if (starts.length === 0) return null
      const parts = []
      for (let i = 0; i < starts.length; i += 1) {
        const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
        try {
          parts.push(zstdDecompressSync(buffer.subarray(starts[i], end)))
        } catch {
          break // 最后一帧可能被截断（正在写），前面解出来的够用
        }
      }
      if (parts.length === 0) return null
      text = Buffer.concat(parts).toString('utf8')
    } else {
      text = buffer.toString('utf8')
    }
    let open = null
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue // 尾部可能被截断成半行
      }
      if (event?.type === 'turn/start') open = true
      else if (event?.type === 'turn/end') open = false
    }
    return open
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* 关不掉不影响判断 */
      }
    }
  }
}

/**
 * 判一条会话目录的活跃度。
 *
 * @param {string} sessionDir
 * @param {{now?:number, activeMs?:number}} [opts]
 * @returns {{activity:'writing'|'silent', lastWriteAt:number|null, freshMs:number|null, openTurn:boolean}}
 */
export function describeActivity(sessionDir, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const activeMs = Number.isFinite(opts.activeMs) && opts.activeMs >= 0 ? opts.activeMs : 180000
  const lastWriteAt = sessionLogMtime(sessionDir)
  if (lastWriteAt === null) {
    return { activity: 'silent', lastWriteAt: null, freshMs: null, openTurn: false }
  }
  const freshMs = Math.max(0, now - lastWriteAt)
  // 只在新旧之间那一带才需要读日志尾巴（贵），新鲜的直接判 writing。
  const openTurn = freshMs <= activeMs ? false : tailHasOpenTurn(sessionDir) === true
  return {
    activity: freshMs <= activeMs || openTurn ? 'writing' : 'silent',
    lastWriteAt,
    freshMs,
    openTurn,
  }
}
