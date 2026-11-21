/**
 * dsh-xlock — CLI 核心（供 dsh-xlock.ps1 以 DSH 内置 node 执行）。
 *
 * 用法（经 ps1 包装）：
 *   dsh-xlock.ps1 audit   [session]   走查会话目录，输出双边画像报告（不改文件）
 *   dsh-xlock.ps1 resolve <session> --keep primary|copy   裁决分叉（异机 held 时拒绝）
 *   dsh-xlock.ps1 reset   <session>   删除本会话粘锁标记（跨机接管的唯一逃生门）
 *   dsh-xlock.ps1 status              概览：标记 held / 冲突副本 / 隔离区
 *   dsh-xlock.ps1 gc                  立即清理过期隔离区（ledger 留痕）
 *
 * 设计边界：CLI 与宿主拦截共用 core/*；CLI 只做"人"的裁决入口，
 * 不做自动合并——换正后由 DSH 自己的 generation 机制重建日志。
 */

import process from 'node:process'
import {
  readFileSync,
  existsSync,
  unlinkSync,
  openSync,
  writeSync,
  ftruncateSync,
  closeSync,
  fsyncSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { loadIdentity } from '../core/identity.mjs'
import { loadConfig, loadMachines } from '../core/config.mjs'
import { listSessionDirs, findSessionDirs, inventorySessionDir, machineName } from '../core/sessionfs.mjs'
import { auditSessionDir, renderReport } from '../core/audit.mjs'
import { inferOrigin } from '../core/origin.mjs'
import { auditCopyFile } from '../core/classify.mjs'
import { markerStatus, listMarkerConflicts, readMarker } from '../core/marker.mjs'
import { quarantineFile, writeDivergentExport, listQuarantine, gcQuarantine } from '../core/quarantine.mjs'
import { walkLog } from '../core/frames.mjs'
import { moveFile } from '../core/util.mjs'

function fail(message) {
  process.stderr.write(`dsh-xlock: ${message}\n`)
  process.exitCode = 1
}

function usage() {
  process.stdout.write(
    [
      'dsh-xlock — 跨机会话粘锁 / 同步冲突副本审计与修复',
      '',
      '命令:',
      '  audit   [session]        走查会话（缺省=全部），输出报告；不改会话文件',
      '  resolve  <session> --keep primary|copy   裁决分叉副本：primary=以主文件为准 / copy=以副本换正',
      '  reset    <session>       删除本会话粘锁标记（异机接管唯一逃生门；确认原机已停写后使用）',
      '  status                   概览：所有会话的标记/副本/需要处理项 + 隔离区统计',
      '  gc                       立即清理过期/超限隔离区',
      '',
      '会话名可用 session id 片段模糊匹配（唯一命中即执行）。',
    ].join('\n') + '\n',
  )
}

function resolveSessionDir(sessionArg) {
  const roots = listSessionDirs()
  const exact = roots.find((r) => r.name === sessionArg)
  if (exact) return { dir: exact.dir, name: sessionArg }
  const hits = findSessionDirs(sessionArg)
  if (hits.length === 1) return { dir: hits[0].dir, name: hits[0].name }
  if (hits.length === 0) throw new Error(`no session dir matches "${sessionArg}" (searched ${roots.length} buckets)`)
  throw new Error(`ambiguous session "${sessionArg}", ${hits.length} matches:\n  ${hits.map((h) => h.name).join('\n  ')}`)
}

/** resolve 的安全闸：异机持锁/标记损坏时拒绝裁决。 */
function assertNotForeignHeld(dir, identity) {
  const marker = markerStatus(dir, identity)
  if (marker.corrupt) {
    throw new Error('lock marker is corrupt — inspect with audit first; reset clears it if you accept the risk')
  }
  if (marker.foreign) {
    throw new Error(
      `session is lock-held on host "${marker.holder?.host || '?'}" — refusing. ` +
        'Stop that machine\u2019s DSH first, then re-run this command.',
    )
  }
}

export function cmdAudit(args) {
  const identity = loadIdentity()
  const machines = loadMachines()
  const targets =
    args.length === 0
      ? listSessionDirs().map((r) => ({ dir: r.dir, name: r.name }))
      : [resolveSessionDir(args[0])]
  if (targets.length === 0) {
    process.stdout.write('no session directories found\n')
    return
  }
  for (const { dir, name } of targets) {
    const report = auditSessionDir(dir, { identity, machines, sessionName: name })
    process.stdout.write(renderReport(report) + '\n\n')
  }
}

/**
 * in-place 修复"完整帧内 JSONL 末行截断"（副本换正前必做——
 * DSH 对这种情况拒载）。返回修复字节数（0=无需修复）。
 */
function repairLastLineInPlace(path) {
  const buf = readFileSync(path)
  const walk = walkLog(buf)
  if (!walk.health.tornJsonlLastLine || walk.health.tornFrameIndex === undefined || walk.health.tornFrameIndex === null) {
    return 0
  }
  const frame = walk.frames[walk.health.tornFrameIndex]
  if (!frame) return 0
  const frameText = buf.slice(frame.start, frame.end).toString('latin1') // 帧内 JSONL 为 ASCII 安全；按字节切
  const lines = frameText.split('\n')
  // 末行 JSON 解析失败 → 截掉；其余保持。
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (last.trim() === '') {
      lines.pop()
      continue
    }
    try {
      JSON.parse(last)
      break
    } catch {
      lines.pop()
    }
  }
  const keptText = lines.length > 0 ? lines.join('\n') + '\n' : ''
  const rebuilt = Buffer.concat([buf.slice(0, frame.start), zstdCompressSync(Buffer.from(keptText, 'latin1'))])
  // 自检：重走查不得再报 tornJsonlLastLine。
  const rewalk = walkLog(rebuilt)
  if (rewalk.health.tornJsonlLastLine) throw new Error(`self-check failed after repairing ${basename(path)}`)
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, rebuilt, 0, rebuilt.length, 0)
    ftruncateSync(fd, rebuilt.length)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  return buf.length - rebuilt.length
}

export function cmdResolve(args) {
  const keepIdx = args.indexOf('--keep')
  let keep
  if (keepIdx !== -1 && args[keepIdx + 1]) keep = args[keepIdx + 1]
  const sessionArg = args.filter((a, i) => a !== '--keep' && i !== keepIdx + 1)[0]
  if (!sessionArg || !keep || !['primary', 'copy'].includes(keep)) {
    fail('usage: resolve <session> --keep primary|copy')
    return
  }
  const identity = loadIdentity()
  const { dir, name } = resolveSessionDir(sessionArg)
  assertNotForeignHeld(dir, identity)

  const inv = inventorySessionDir(dir)
  if (inv.logConflicts.length === 0) {
    process.stdout.write(`session "${name}": no log conflict copies — nothing to resolve\n`)
    return
  }
  const machines = loadMachines()
  let acted = 0
  for (const copy of inv.logConflicts) {
    const primary = inv.canonical.find((c) => c.version === copy.version)
    const mn = machineName(copy.shortId, machines)
    const metaBase = {
      sessionId: name,
      machines: { copy: mn.name, shortId: copy.shortId },
      classifiedAs: undefined,
      action: `resolve --keep ${keep}`,
    }
    if (!primary) {
      fail(`copy ${copy.name} has no canonical counterpart (orphan) — decide manually, not auto-resolved`)
      continue
    }
    const verdict = auditCopyFile(copy.path, primary.path)
    metaBase.classifiedAs = verdict.kind
    if (verdict.kind === 'identical' || verdict.kind === 'prefix') {
      const qdir = quarantineFile(copy.path, { ...metaBase, kind: 'conflict-copy', note: `resolve: ${verdict.kind} copy discarded` })
      process.stdout.write(`quarantined ${copy.name} (${verdict.kind}) → ${qdir}\n`)
      acted++
      continue
    }
    if (verdict.kind === 'unreadable') {
      fail(`copy ${copy.name} is unreadable (${verdict.error || 'no frames'}) — not auto-resolved; inspect manually`)
      continue
    }
    // divergent（含 firstDivergenceSeq）：按裁决方向落盘。
    if (keep === 'primary') {
      const qdir = quarantineFile(copy.path, {
        ...metaBase,
        kind: 'conflict-copy',
        note: 'resolve --keep primary: copy side discarded',
      })
      // 导出放隔离目录内（copyOnly + differing 双边记录）。
      const exportPath = writeDivergentExport(qdir, copy.name, verdict, {
        sessionId: name,
        copyMachine: mn.name,
        firstDivergenceSeq: verdict.firstDivergenceSeq,
      })
      process.stdout.write(`copy-side records exported → ${exportPath}\n`)
      process.stdout.write(`quarantined copy ${copy.name} → ${qdir}\nprimary stays authoritative: ${primary.name}\n`)
      acted++
    } else {
      // keep=copy：副本换正为主文件，原主文件隔离（原字节完整留证）。
      const repairedBytes = repairLastLineInPlace(copy.path)
      if (repairedBytes > 0) process.stdout.write(`promoted copy tail-repaired in place (dropped ${repairedBytes} torn bytes)\n`)
      const qdir = quarantineFile(primary.path, {
        ...metaBase,
        kind: 'primary-demoted',
        note: 'resolve --keep copy: original primary discarded (records annotated in divergent export)',
      })
      const exportPath = writeDivergentExport(qdir, primary.name, verdict, {
        sessionId: name,
        copyMachine: mn.name,
        firstDivergenceSeq: verdict.firstDivergenceSeq,
      })
      const canonicalName = `session.v${copy.version}.jsonl.zstd`
      let dest = join(dir, canonicalName)
      let retries = 0
      while (existsSync(dest) && retries < 4) {
        retries++
        dest = join(dir, `session.v${copy.version}.x${retries}.jsonl.zstd`)
      }
      moveFile(copy.path, dest)
      process.stdout.write(`copy promoted: ${copy.name} → ${basename(dest)}\noriginal primary quarantined → ${qdir}\n`)
      if (verdict.copyOnly?.length || verdict.differing?.length) {
        process.stdout.write(`primary-side records exported → ${exportPath}\n`)
      }
      acted++
    }
  }
  process.stdout.write(`resolve done: ${acted} copy(ies) handled. Re-run audit to confirm.\n`)
}

export function cmdReset(args) {
  const sessionArg = args[0]
  if (!sessionArg) {
    fail('usage: reset <session>')
    return
  }
  const identity = loadIdentity()
  const { dir, name } = resolveSessionDir(sessionArg)
  const marker = readMarker(dir)
  const markerConflicts = listMarkerConflicts(dir)
  if (marker.state === 'missing' && markerConflicts.length === 0) {
    process.stdout.write(`session "${name}": no lock marker — nothing to reset\n`)
    return
  }
  const removed = []
  const markerPath = join(dir, '.dsh-xlock.json')
  if (existsSync(markerPath)) {
    unlinkSync(markerPath)
    removed.push('.dsh-xlock.json')
  }
  for (const c of markerConflicts) {
    unlinkSync(join(dir, c))
    removed.push(c)
  }
  process.stdout.write(
    removed.length > 0
      ? `reset "${name}": removed ${removed.join(', ')} — next write-open on any machine takes the lock\n`
      : `reset "${name}": nothing removed\n`,
  )
}

export function cmdStatus() {
  const identity = loadIdentity()
  const machines = loadMachines()
  const roots = listSessionDirs()
  const lines = []
  let attention = 0
  const unknownDevices = new Set()
  for (const root of roots) {
    const dir = root.dir
    const name = root.name
    const inv = inventorySessionDir(dir)
    const marker = markerStatus(dir, identity)
    // 创建归属（与 marker 是两件事：marker 是「现在谁持有」，这是「当初谁建的」）。
    const origin = inferOrigin(dir, { identity, registry: machines, bucket: root.bucket })
    const bits = []
    if (marker.state === 'held') bits.push(marker.foreign ? `HELD-foreign(${marker.holder?.host || '?'})` : 'held-self')
    else if (marker.corrupt) bits.push('marker-corrupt')
    else if (marker.state === 'released') bits.push('released')
    if (origin.source !== 'unknown' && !origin.local) bits.push(`created-remote(${origin.host})`)
    if (inv.logConflicts.length > 0) bits.push(`log-copies×${inv.logConflicts.length}`)
    if (inv.markerConflicts.length > 0) bits.push(`marker-copies×${inv.markerConflicts.length}`)
    // 归档标记本体是常态（存在即正常），不进摘要；只有它的 Syncthing 冲突
    // 副本（两台机并发改归档状态的痕迹）才是需要看一眼的异常。
    // 迁移后这桶从 foreignMarkers（外来标记）改名 archiveConflicts（自己的标记）。
    const archiveCopies = inv.archiveConflicts
    if (archiveCopies.length > 0) bits.push(`archive-copies×${archiveCopies.length}`)
    if (inv.other.length > 0) bits.push(`other×${inv.other.length}`)
    for (const c of inv.logConflicts) {
      const mn = machineName(c.shortId, machines)
      if (!mn.known) unknownDevices.add(c.shortId)
    }
    if (bits.length > 0) {
      lines.push(`  ${name}: ${bits.join(', ')}`)
      if (marker.foreign || marker.corrupt || inv.logConflicts.length > 0 || inv.markerConflicts.length > 0 || archiveCopies.length > 0) attention++
    }
  }
  process.stdout.write(`sessions: ${roots.length} dir(s), ${attention} need attention\n`)
  if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n')
  const qEntries = listQuarantine()
  const qBytes = qEntries.reduce((sum, e) => sum + e.bytes, 0)
  const qroot = join(process.env.LOCALAPPDATA || process.env.USERPROFILE || '.', 'dsh-xlock', 'quarantine')
  process.stdout.write(`quarantine: ${qEntries.length} item(s), ${qBytes} bytes — ${qroot}\n`)
  if (unknownDevices.size > 0) {
    process.stdout.write(`unknown device shortId(s): ${[...unknownDevices].join(', ')} → add to machines.json (AC8)\n`)
  }
}

export function cmdGc() {
  const cfg = loadConfig()
  const gc = gcQuarantine(cfg)
  process.stdout.write(`gc: deleted=${gc.deleted} dir(s), bytesFreed=${gc.freedBytes}, remaining=${gc.entries - gc.deleted}\n`)
}

export function main(argv) {
  const [cmd, ...args] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage()
    return
  }
  try {
    switch (cmd) {
      case 'audit': return cmdAudit(args)
      case 'resolve': return cmdResolve(args)
      case 'reset': return cmdReset(args)
      case 'status': return cmdStatus()
      case 'gc': return cmdGc()
      default:
        fail(`unknown command "${cmd}"`)
        usage()
    }
  } catch (error) {
    fail(error?.message || String(error))
    if (error?.stack && process.env.DSH_XLOCK_DEBUG) process.stderr.write(error.stack + '\n')
  }
}

// 直跑入口：node cli/xlock.mjs <cmd> ...（dsh-xlock.ps1 走这条路）
// 注意：包可能经 Junction 引用（~/.dsh/dsh-plugins → 同步盘真身），
// argv[1] 与 import.meta.url 字面不同 → 必须 realpath 归一后再比，Windows 再折小写。
import { realpathSync } from 'node:fs'
if (process.argv[1]) {
  try {
    const invoked = realpathSync(resolve(process.argv[1])).toLowerCase()
    const self = realpathSync(fileURLToPath(import.meta.url)).toLowerCase()
    if (invoked === self) main(process.argv.slice(2))
  } catch {
    // 路径解析失败：按被导入处理，不执行 main。
  }
}
