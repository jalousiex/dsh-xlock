/**
 * dsh-xlock — zstd 帧走查与会话日志解析。
 *
 * 会话日志 = 多个 zstd frame 背靠背拼接（每 frame ≈ 一次提交批的 JSONL）。
 * Node 24 内置 zlib.zstdDecompressSync 只解第一个 frame——恰好用它做
 * 「从候选起点解码到候选终点」的边界试探：
 *   - 终点=真帧尾 → 成功；
 *   - 终点在帧内（magic 误报）→ 解码失败（unexpected end）；
 *   - 起点后的第一个 magic 即真帧尾（健康文件帧背靠背无缝）。
 *
 * 记录形态（dsh-session，以真机日志为准）：
 *   首行 header {type:'session', version, id, createdAt, isSeeded, delegationDepth, …}
 *   其后 events {seq(连续), type:'turn/start'|…, time(epoch ms), data:{turn, step, …}}
 *   —— 时间字段是 time（不是 createdAt）；turn/step 在 data 里，不在顶层。
 */

import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 把 buffer 切成 zstd frame 边界并解码。
 * @param {Buffer} buf 文件全量字节
 * @returns {{
 *   frames: Array<{start:number,end:number,text?:string}>,
 *   tornTailStart?: number  // 末尾不可解码残帧的起点（torn final frame）
 * }}
 */
export function splitFrames(buf) {
  const candidates = []
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 1)) {
    candidates.push(i)
  }
  const frames = []
  let tornTailStart
  let idx = 0
  while (idx < candidates.length) {
    const start = candidates[idx]
    if (start >= buf.length) break
    let end
    // 依次尝试后续候选终点（含 buf.length），第一个解码成功的即帧尾。
    for (let j = idx + 1; ; j++) {
      const stop = j < candidates.length ? candidates[j] : buf.length
      if (stop <= start) {
        if (j >= candidates.length) {
          end = undefined
          break
        }
        continue
      }
      try {
        const out = zstdDecompressSync(buf.subarray(start, stop))
        // 截断帧可能「解码成功但产出 0 字节」——例如 [magic, 0x09] 这种 5 字节残尾，
        // zstdDecompressSync 不抛错而返回空 buffer。空内容不构成帧边界，
        // 继续往后试更长终点；试尽即判为残帧。
        if (out.length > 0) {
          end = { stop, text: out.toString('utf8') }
          break
        }
      } catch {
        // 解码失败：终点在帧内，继续试下一个候选。
      }
      if (j >= candidates.length) {
        end = undefined
        break
      }
    }
    if (end) {
      frames.push({ start, end: end.stop, text: end.text })
      // 跳过被吞进本帧的所有候选（含 magic 误报）。
      let next = idx + 1
      while (next < candidates.length && candidates[next] < end.stop) next++
      idx = next
    } else {
      tornTailStart = start
      break
    }
  }
  return { frames, tornTailStart }
}

/**
 * 解析一条记录行的关键信息。
 * @param {string} line JSONL 行
 * @returns {{seq?:number,type?:string,turn?:number,step?:number,createdAt?:number,time?:number}}
 */
export function recordMeta(line) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return { torn: true }
  }
  if (!obj || typeof obj !== 'object') return { torn: true }
  // 真机日志：turn/step 在 data 里；时间字段是 time（header 用 createdAt）。
  const data = obj.data !== null && typeof obj.data === 'object' ? obj.data : undefined
  const turn = typeof obj.turn === 'number' ? obj.turn : typeof data?.turn === 'number' ? data.turn : undefined
  const step = typeof obj.step === 'number' ? obj.step : typeof data?.step === 'number' ? data.step : undefined
  return {
    seq: typeof obj.seq === 'number' ? obj.seq : undefined,
    type: typeof obj.type === 'string' ? obj.type : undefined,
    turn,
    step,
    createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : undefined,
    time: typeof obj.time === 'number' ? obj.time : undefined,
    raw: obj,
  }
}

/**
 * 走查整个日志 buffer → 记录 + 健康状况。
 * @param {Buffer} buf
 * @returns {{
 *   header?: object,
 *   records: Array<{seq?:number,type?:string,turn?:number,step?:number,createdAt?:number,time?:number,lineNo:number,raw:object}>,
 *   health: {
 *     tornTailFrame: boolean,       // 末帧不可解（DSH 写打开会自愈截断）
 *     tornJsonlLastLine: boolean,   // 完整帧内末行 JSON 截断（DSH 拒载 → 需修复）
 *     tornFrameIndex?: number,      // 出现 JSON 截断的帧序号（0 基）
 *     corruptMiddle: boolean,       // 中间帧不可解（无法按帧修复）
 *     seqGaps: Array<[number, number]>,   // [前 seq, 后 seq] 非连续处
 *     frameCount: number,
 *   }
 * }}
 */
export function walkLog(buf) {
  const { frames, tornTailStart } = splitFrames(buf)
  const records = []
  let header
  let tornJsonlLastLine = false
  let tornFrameIndex
  const seqGaps = []
  let lastSeq

  frames.forEach((frame, frameIndex) => {
    const lines = frame.text.split('\n')
    // 帧内最后一行：正常以 \n 结尾 → split 产生末尾空串；非空 = JSON 截断候选。
    const lastLine = lines[lines.length - 1]
    const bodyLines = lastLine === '' ? lines.slice(0, -1) : lines
    const trailingGarbage = lastLine !== '' && lastLine.trim() !== ''
    for (const line of bodyLines) {
      if (line.trim() === '') continue
      const meta = recordMeta(line)
      if (meta.torn) {
        // 完整帧内出现不可解析行（非末行）——按截断记录处理，仅末行可修。
        if (!tornJsonlLastLine) {
          tornJsonlLastLine = true
          tornFrameIndex = frameIndex
        }
        continue
      }
      if (!header && meta.type === 'session' && meta.raw && meta.seq === undefined) {
        header = meta.raw
        records.push({ ...meta, lineNo: records.length + 1 })
        continue
      }
      if (typeof meta.seq === 'number') {
        if (lastSeq !== undefined && meta.seq !== lastSeq + 1) seqGaps.push([lastSeq, meta.seq])
        lastSeq = meta.seq
      }
      records.push({ ...meta, lineNo: records.length + 1 })
    }
    // 末行有残字（无换行收尾且解不出 JSON）→ 标记可修复截断。
    if (trailingGarbage && recordMeta(lastLine).torn) {
      tornJsonlLastLine = true
      tornFrameIndex = frameIndex
    }
  })

  // 中间帧损坏（非末尾处解不开）：splitFrames 在第一个解不开的候选起点即停，
  // v1 一律保守记为 torn tail（DSH 读打开也只会丢弃其后内容）；
  // 是否中间损坏由 audit 报告 frameCount 与 seqGaps 供人判断。
  return {
    header,
    records,
    health: {
      tornTailFrame: tornTailStart !== undefined,
      tornJsonlLastLine,
      tornFrameIndex,
      corruptMiddle: false,
      seqGaps,
      frameCount: frames.length,
    },
    frames,
    tornTailStart,
  }
}

/**
 * 会话日志文件名解析（canonical）：
 *   v0: session.jsonl.zstd；vN≥1: session.vN.jsonl.zstd
 *   冲突副本: <canonical-without-zstd>.sync-conflict-<date>-<time>-<shortId>.zstd
 * @param {string} name
 * @returns {{kind:'canonical',version:number}|{kind:'conflict',version:number,shortId:string,date:string,time:string}|{kind:'other'}}
 */
export function parseLogFilename(name) {
  if (!name.endsWith('.zstd')) return { kind: 'other' }
  const stem = name.slice(0, -'.zstd'.length)
  let version = 0
  if (/^session\.v(0|[1-9]\d*)\.jsonl$/.test(stem)) {
    version = Number(/^session\.v(0|[1-9]\d*)\.jsonl$/.exec(stem)[1])
  } else if (/^session\.jsonl$/.test(stem)) {
    version = 0
  } else {
    const conflict = /\.sync-conflict-(\d{8})-(\d{6})-([A-Za-z0-9]+)$/.exec(stem)
    if (!conflict) return { kind: 'other' }
    const inner = stem.slice(0, conflict.index)
    if (/^session\.v(0|[1-9]\d*)\.jsonl$/.test(inner)) {
      version = Number(/^session\.v(0|[1-9]\d*)\.jsonl$/.exec(inner)[1])
    } else if (inner !== 'session.jsonl') {
      return { kind: 'other' }
    }
    return {
      kind: 'conflict',
      version,
      shortId: conflict[3],
      date: conflict[1],
      time: conflict[2],
    }
  }
  return { kind: 'canonical', version }
}
