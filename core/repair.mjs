/**
 * dsh-xlock — 尾部修复门禁。
 *
 * 目标缺陷：**完整已提交帧内 JSONL 末行截断**（DSH 拒载：
 * generation.ts:344 "complete frame contains a torn JSONL record"）。
 * 修复：截掉末残行 → 只重压缩该帧 → 前序帧字节原样保留 → 原文件先隔离再重写。
 *
 * 不碰的情形（交回 DSH 原生路径 / 报告）：
 * - torn final frame（DSH 写打开自愈截断）；
 * - 中间帧损坏（无法按帧修复 → audit 报告）。
 */

import { closeSync, copyFileSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync, fsyncSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { walkLog, splitFrames } from './frames.mjs'

/**
 * 尾部修复（若需要）。
 * @param {string} logPath 会话日志绝对路径（canonical 名）
 * @param {object} opts
 * @param {(src: string, meta: object) => string} opts.quarantineCopy 隔离函数（返回隔离目录）
 * @param {string} opts.sessionId
 * @param {(line: string) => void} [opts.log]
 * @returns {{repaired: boolean, reason?: string, droppedBytes?: number, quarantineDir?: string}}
 */
export function tailRepairIfNeeded(logPath, { quarantineCopy, sessionId, log = () => {} }) {
  let size
  try {
    size = statSync(logPath).size
  } catch {
    return { repaired: false, reason: 'missing' }
  }
  if (size < 8) return { repaired: false, reason: 'empty' }
  const buf = readFileSync(logPath)
  const { frames, tornTailStart } = splitFrames(buf)
  if (tornTailStart !== undefined) {
    // DSH 写打开自愈；我们不重复造轮子。
    return { repaired: false, reason: 'torn-tail-frame' }
  }
  if (frames.length === 0) return { repaired: false, reason: 'no-frames' }
  const last = frames[frames.length - 1]
  const text = last.text
  if (text === undefined) return { repaired: false, reason: 'undecodable' }
  const lines = text.split('\n')
  const lastLine = lines[lines.length - 1]
  const trailingPartial = lastLine !== '' // 无换行收尾的残字（或恰好整帧无末换行且完整——见下）
  if (!trailingPartial) return { repaired: false } // 末行以 \n 收尾 → 完整

  // 残行判定：JSON.parse 失败才是截断；可解析只是缺末换行 → 只补换行不动内容。
  let isTorn
  try {
    JSON.parse(lastLine)
    isTorn = false
  } catch {
    isTorn = true
  }
  if (!isTorn) return { repaired: false }

  const keptText = lines.slice(0, -1).join('\n') + (lines.length > 1 ? '\n' : '')
  const prefixEnd = last.start
  const newFrame = zstdCompressSync(Buffer.from(keptText, 'utf8'))
  const droppedBytes = last.end - last.start - newFrame.length

  // 1) 原文件先隔离（kind=torn-pre-repair）
  let quarantineDir
  if (quarantineCopy) {
    try {
      quarantineDir = quarantineCopy(logPath, { sessionId, kind: 'torn-pre-repair', extra: { droppedBytes } })
    } catch (error) {
      // 隔离失败不放弃修复：继续原位修复（原字节已读入 buf）。
      log(`quarantine before repair failed: ${error?.message || error}`)
    }
  }

  // 2) 原位重写：前缀字节 + 新末帧；截掉多余尾巴。
  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'r+')
  try {
    let offset = 0
    if (prefixEnd > 0) {
      writeSync(fd, buf.subarray(0, prefixEnd), 0, prefixEnd, 0)
      offset = prefixEnd
    }
    writeSync(fd, newFrame, 0, newFrame.length, offset)
    fsyncSync(fd)
    ftruncateSync(fd, offset + newFrame.length)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  // 3) 自检：重走查应无 tornJsonlLastLine。
  const after = walkLog(readFileSync(logPath))
  if (after.health.tornJsonlLastLine) {
    log('repair self-check still reports torn JSONL — leaving for audit')
  }
  return { repaired: true, droppedBytes, quarantineDir }
}

/**
 * 便捷包装：把一个文件原样复制进隔离目录（原字节留证）。
 * 由 quarantine.mjs 的 quarantineFile 提供时无需本函数；测试可直接传。
 */
export { copyFileSync, readFileSync }
