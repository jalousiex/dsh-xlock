/**
 * dsh-xlock — 测试套件（零外部依赖；DSH 内置 node 运行）。
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DSH_NODE_EXECUTABLE>" test/run.mjs
 *
 * 隔离：全程把 USERPROFILE / LOCALAPPDATA 指到临时 fixture 根，
 * 不触碰真实 ~/.dsh/sessions 与本机 %LOCALAPPDATA%。
 * 宿主半（index.js）用真实 schemastery：整包复制到临时目录 +
 * node_modules junction（见 loadHostHalf）。
 */

import { zstdCompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = join(here, '..')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond === true) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}`)
  }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
  }
}
function section(title) {
  console.log(`\n== ${title}`)
}
async function throwsName(fn, expectedName) {
  try {
    await fn()
    return false
  } catch (error) {
    return error?.name === expectedName
  }
}
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

// ── fixture 根（隔离 env）───────────────────────────────────────────────
const fxRoot = mkdtempSync(join(tmpdir(), 'dsh-xlock-test-'))
const fxHome = join(fxRoot, 'home')
const fxAppData = join(fxRoot, 'appdata')
mkdirSync(join(fxHome, '.dsh', 'sessions', '--D-work-demo--'), { recursive: true })
mkdirSync(fxAppData, { recursive: true })
process.env.USERPROFILE = fxHome
process.env.LOCALAPPDATA = fxAppData
process.env.DSH_XLOCK_REGISTRY = join(fxRoot, 'machines.json')

// env 已隔离 → 现在才动态导入（模块在调用时才读 env，但保险起见全部后置）。
const { walkLog, parseLogFilename, recordMeta, splitFrames } = await import('../core/frames.mjs')
const { readMarker, markerStatus, acquireMarker, releaseMarker, createHeldMarker, listMarkerConflicts, markerPath, XlockHeldError } = await import(
  '../core/marker.mjs'
)
const { classifyCopy, auditCopyFile, detectOpenTurn } = await import('../core/classify.mjs')
const { tailRepairIfNeeded } = await import('../core/repair.mjs')
const { quarantineFile, writeDivergentExport, listQuarantine, gcQuarantine } = await import('../core/quarantine.mjs')
const { loadIdentity } = await import('../core/identity.mjs')
const { loadConfig, loadMachines } = await import('../core/config.mjs')
const { wrapPersistence, XlockDivergentError } = await import('../core/intercept.mjs')
const { auditSessionDir, renderReport } = await import('../core/audit.mjs')
const { inventorySessionDir } = await import('../core/sessionfs.mjs')
const { projectKey, writeOriginOnce, readOrigin, inferOrigin, listOriginConflicts, ORIGIN_NAME } = await import('../core/origin.mjs')

// ── 合成会话日志工具 ────────────────────────────────────────────────────
function frameOf(lines) {
  return zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
}
function headerLine(id = 'session-test0001-2222-3333-4444-555555555555') {
  return JSON.stringify({ type: 'session', version: 4, id, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 })
}
/**
 * 真机事件形态：时间字段是 time（epoch ms），turn/step 在 data 里 —— 不是顶层 createdAt。
 * 夹具必须照真机写，否则 recordMeta 的解析路径测不出来。
 */
function event(seq, type, extra = {}) {
  const { turn = 1, step, ...rest } = extra
  const data = { turn, ...(step === undefined ? {} : { step }) }
  return JSON.stringify({ seq, type, time: 1700000000000 + seq * 1000, data, ...rest })
}
function headerCreatedAtOnly() {
  return JSON.stringify({ type: 'session', version: 4, id: 'x', createdAt: 1700000000000, isSeeded: false })
}
/** 标准健康日志：header + 4 events，2 帧。 */
function healthyLog() {
  return Buffer.concat([
    frameOf([headerLine(), event(1, 'turn/start'), event(2, 'user/message', { message: 'hello' })]),
    frameOf([event(3, 'assistant/message', { message: 'hi' }), event(4, 'turn/end', { reason: { kind: 'completed' } })]),
  ])
}
function writeSession(dir, name, buf) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), buf)
}

/** 定位真实 schemastery：DSH_PROFILE_DIR → ~/.dsh/profiles/<profile> → 已安装的任何 profile。 */
function resolveSchemasteryPath() {
  const candidates = []
  const rel = join('node_modules', '@deepseek-ai', 'schemastery')
  if (process.env.DSH_PROFILE_DIR) candidates.push(join(process.env.DSH_PROFILE_DIR, rel))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profilesRoot = join(home, 'profiles')
  for (const name of ['desktop', 'web']) candidates.push(join(profilesRoot, name, rel))
  try {
    for (const name of readdirSync(profilesRoot)) candidates.push(join(profilesRoot, name, rel))
  } catch {}
  for (const c of candidates) {
    if (existsSync(join(c, 'lib', 'index.cjs')) || existsSync(join(c, 'package.json'))) return c
  }
  throw new Error(`找不到 @deepseek-ai/schemastery，试过: ${candidates.join(' | ')}`)
}

// ═══════════════════════════════ frames ═══════════════════════════════
section('frames.mjs 帧走查与文件名解析')
{
  const walk = walkLog(healthyLog())
  eq(walk.health.frameCount, 2, '健康日志帧数=2')
  eq(walk.records.length, 5, '健康日志记录数=5（header+4 events）')
  eq(walk.health.tornTailFrame, false, '无 torn tail frame')
  eq(walk.health.tornJsonlLastLine, false, '无 torn JSONL')
  eq(walk.health.seqGaps.length, 0, '无 seq 断档')
  eq(walk.header?.version, 4, 'header 解析正确')
  eq(detectOpenTurn(walk.records), undefined, 'turn 已闭合')

  // 回归：真机事件 time 字段 + data.turn，不是顶层 createdAt/turn。
  const metaReal = recordMeta(event(7, 'step/start', { turn: 2, step: 3 }))
  eq(metaReal.time, 1700000000000 + 7000, 'recordMeta 取 time 作为时间戳')
  eq(metaReal.createdAt, undefined, '事件无顶层 createdAt')
  eq(metaReal.turn, 2, 'recordMeta 从 data 取 turn')
  eq(metaReal.step, 3, 'recordMeta 从 data 取 step')
  // 兼容：老格式顶层 turn/step 仍能读。
  const metaTop = recordMeta(JSON.stringify({ seq: 9, type: 'turn/start', turn: 4, step: 1, createdAt: 1700000009000 }))
  eq([metaTop.turn, metaTop.step, metaTop.createdAt], [4, 1, 1700000009000], '顶层 turn/step/createdAt 兼容')

  // 回归：未闭合 turn 必须能从 data.turn 判出（此前恒为 undefined）。
  const openTurnLog = Buffer.concat([
    frameOf([headerLine(), event(1, 'turn/start', { turn: 1 })]),
    frameOf([event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), event(3, 'turn/start', { turn: 2 })]),
  ])
  eq(detectOpenTurn(walkLog(openTurnLog).records), 2, '未闭合 turn 由 data.turn 判出')

  // torn tail frame：健康日志 + 半个假 zstd 帧字节。
  const tornTail = Buffer.concat([healthyLog(), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03])])
  const walkTorn = walkLog(tornTail)
  eq(walkTorn.health.tornTailFrame, true, 'torn tail frame 检出')
  eq(walkTorn.records.length, 5, 'torn tail frame 不丢完整记录')

  // torn JSONL 末行：帧内最后一行截断（无换行、JSON 不完整）。
  const tornLine = Buffer.concat([
    frameOf([headerLine(), event(1, 'turn/start')]),
    Buffer.from(zstdCompressSync(Buffer.from(`${event(2, 'user/message')}\n{"seq":3,"type":"user/mess`, 'utf8'))),
  ])
  const walkLine = walkLog(tornLine)
  eq(walkLine.health.tornJsonlLastLine, true, 'torn JSONL 末行检出')
  eq(walkLine.health.tornFrameIndex, 1, 'torn JSONL 帧序号=1')
  eq(walkLine.records.filter((r) => typeof r.seq === 'number').length, 2, '残行不混入记录')

  // parseLogFilename。
  eq(parseLogFilename('session.jsonl.zstd'), { kind: 'canonical', version: 0 }, 'v0 canonical')
  eq(parseLogFilename('session.v4.jsonl.zstd'), { kind: 'canonical', version: 4 }, 'vN canonical')
  const pc = parseLogFilename('session.v4.jsonl.sync-conflict-20261113-101500-DEADBEE.zstd')
  eq(
    { kind: pc.kind, version: pc.version, shortId: pc.shortId, date: pc.date, time: pc.time },
    { kind: 'conflict', version: 4, shortId: 'DEADBEE', date: '20261113', time: '101500' },
    '冲突副本名解析',
  )
  eq(parseLogFilename('SESSION.V4.JSONL.ZSTD').kind, 'other', '大写不认')
  eq(parseLogFilename('session.v04.jsonl.zstd').kind, 'other', '前导零不认')
  eq(parseLogFilename('session.v4.jsonl.zstd.tmp').kind, 'other', '临时后缀不认')
}

// ═══════════════════════════════ marker ═══════════════════════════════
section('marker.mjs 粘锁状态机')
{
  const dir = join(fxRoot, 't-marker')
  mkdirSync(dir, { recursive: true })
  const me = { uuid: 'uuid-LOCAL', host: 'local-host' }
  const other = { uuid: 'uuid-REMOTE', host: 'remote-host' }

  eq(readMarker(dir).state, 'missing', '初始无标记')
  acquireMarker(dir, me, 'session-x')
  eq(readMarker(dir).data.state, 'held', 'missing → wx 创建 held')
  eq(readMarker(dir).data.machineId, 'uuid-LOCAL', 'held 归属本机')
  eq(markerStatus(dir, me).foreign, false, '本机判 held=false')
  eq(markerStatus(dir, other).foreign, true, '异机判 held=true')

  // held+本机 → 幂等保持；held+异机 → XlockHeldError。
  acquireMarker(dir, me, 'session-x')
  eq(readMarker(dir).data.state, 'held', '本机重复 acquire 幂等')
  let msg = ''
  try {
    acquireMarker(dir, other, 'session-x')
  } catch (e) {
    msg = e.message
  }
  ok(
    msg.includes('local-host') && msg.includes('reset') && msg.includes('xlock tool'),
    '异机 acquire 报错含持有主机名与 reset 指引（xlock 工具通道）',
  )
  eq(readMarker(dir).data.state, 'held', '异机 acquire 失败不改状态')

  // released → 任意机翻转 held。
  releaseMarker(dir)
  eq(readMarker(dir).data.state, 'released', 'close → released（不删除）')
  eq(readMarker(dir).data.machineId, 'uuid-LOCAL', 'released 保留释放方身份')
  acquireMarker(dir, other, 'session-x')
  eq(readMarker(dir).data.machineId, 'uuid-REMOTE', 'released 被异机接管 → held 归属切换')

  // corrupt → 拦。
  writeFileSync(markerPath(dir), '{broken json')
  ok(await throwsName(() => acquireMarker(dir, me, 'session-x'), 'SessionAlreadyOwnedError'), 'corrupt 标记拦（SessionAlreadyOwnedError）')
  eq(markerStatus(dir, me).corrupt, true, 'markerStatus 报 corrupt')

  // 标记冲突副本 → 拦（AC10）。
  const dir2 = join(fxRoot, 't-marker2')
  mkdirSync(dir2, { recursive: true })
  createHeldMarker(dir2, me, 'session-y')
  writeFileSync(join(dir2, '.dsh-xlock.json.sync-conflict-20261113-090000-AAAAAA.json'), '{"state":"held"}')
  eq(listMarkerConflicts(dir2).length, 1, '标记冲突副本扫描')
  ok(await throwsName(() => acquireMarker(dir2, me, 'session-y'), 'SessionAlreadyOwnedError'), '标记冲突副本拦')
}

// ═══════════════════════════════ classify ═════════════════════════════
section('classify.mjs 副本分类')
{
  const mk = (buf) => walkLog(buf)
  const p = mk(healthyLog())
  eq(classifyCopy(p, mk(healthyLog())).kind, 'identical', 'identical')
  const prefixBuf = Buffer.concat([frameOf([headerLine(), event(1, 'turn/start'), event(2, 'user/message', { message: 'hello' })])])
  eq(classifyCopy(p, mk(prefixBuf)).kind, 'prefix', 'prefix')

  // divergent：同 seq 内容不同。
  const diffBuf = Buffer.concat([
    frameOf([headerLine(), event(1, 'turn/start'), event(2, 'user/message', { message: 'CHANGED' })]),
    frameOf([event(3, 'assistant/message', { message: 'hi' })]),
  ])
  const dv = classifyCopy(p, mk(diffBuf))
  eq(dv.kind, 'divergent', 'divergent（同 seq 异内容）')
  eq(dv.firstDivergenceSeq, 2, '首个分叉 seq=2')
  eq(dv.differing.length, 1, 'differing 计数')

  // divergent：副本独有 seq。
  const copyOnlyBuf = Buffer.concat([healthyLog(), frameOf([event(5, 'user/message', { message: 'only-in-copy' })])])
  const co = classifyCopy(p, mk(copyOnlyBuf))
  eq(co.kind, 'divergent', 'divergent（copyOnly）')
  eq(co.copyOnly.length, 1, 'copyOnly 计数')

  // orphan：副本存在但主文件缺失。
  const orphanDir = join(fxRoot, 't-orphan')
  writeSession(orphanDir, 'session.v9.jsonl.sync-conflict-20261113-100000-FFFFFF.zstd', healthyLog())
  eq(
    auditCopyFile(
      join(orphanDir, 'session.v9.jsonl.sync-conflict-20261113-100000-FFFFFF.zstd'),
      join(orphanDir, 'session.v9.jsonl.zstd'),
    ).kind,
    'orphan',
    'orphan（主文件缺失）',
  )

  // unreadable：副本只有垃圾字节。
  const garbage = join(fxRoot, 'garbage.zstd')
  writeFileSync(garbage, Buffer.from('not zstd at all'))
  const gdir = join(fxRoot, 't-classify')
  writeSession(gdir, 'session.v4.jsonl.zstd', healthyLog())
  eq(auditCopyFile(garbage, join(gdir, 'session.v4.jsonl.zstd')).kind, 'unreadable', 'unreadable')
}

// ═══════════════════════════════ repair ═══════════════════════════════
section('repair.mjs 尾部修复门禁')
{
  const dir = join(fxRoot, 't-repair')
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'session.v4.jsonl.zstd')
  const tornLine = Buffer.concat([
    frameOf([headerLine(), event(1, 'turn/start')]),
    zstdCompressSync(Buffer.from(`${event(2, 'user/message')}\n{"seq":3,"type":"user/mess`, 'utf8')),
  ])
  writeFileSync(logPath, tornLine)
  let quarantined = null
  const r1 = tailRepairIfNeeded(logPath, { quarantineCopy: (src, meta) => ((quarantined = { src, meta }), join(dir, 'q')), sessionId: 's' })
  eq(r1.repaired, true, 'torn 末行 → 修复')
  ok(quarantined?.meta?.kind === 'torn-pre-repair', '修复前先隔离原文件')
  const after = walkLog(readFileSync(logPath))
  eq(after.health.tornJsonlLastLine, false, '修复后重走查干净')
  eq(after.records.filter((r) => r.seq === 2).length, 1, 'seq=2 保留')
  eq(after.records.filter((r) => r.seq === 3).length, 0, '残行 seq=3 剔除')

  // 健康文件不动。
  const healthyPath = join(dir, 'session.v2.jsonl.zstd')
  writeFileSync(healthyPath, healthyLog())
  const before = sha256(healthyPath)
  const r2 = tailRepairIfNeeded(healthyPath, { quarantineCopy: () => join(dir, 'q2'), sessionId: 's' })
  eq(r2.repaired, false, '健康文件不修')
  eq(sha256(healthyPath), before, '健康文件字节不动')

  // torn tail frame → 交回 DSH 自愈，不动。
  const tornTailPath = join(dir, 'session.v3.jsonl.zstd')
  writeFileSync(tornTailPath, Buffer.concat([healthyLog(), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x09])]))
  const r3 = tailRepairIfNeeded(tornTailPath, { quarantineCopy: () => join(dir, 'q3'), sessionId: 's' })
  eq(r3.repaired, false, 'torn tail frame 不修（DSH 自愈）')
  eq(r3.reason, 'torn-tail-frame', '原因=torn-tail-frame')
}

// ═══════════════════════════════ quarantine + gc ══════════════════════
section('quarantine.mjs 隔离区与 gc（AC9）')
{
  const src = join(fxRoot, 'q-src.txt')
  writeFileSync(src, 'payload')
  const qdir = quarantineFile(src, { sessionId: 'session-test0001', kind: 'conflict-copy', classifiedAs: 'prefix', action: 'auto-quarantine' })
  ok(!existsSync(src), '隔离后源文件不在')
  ok(existsSync(join(qdir, 'q-src.txt')), '文件进隔离目录')
  ok(existsSync(join(qdir, 'meta.json')), 'meta.json 落盘')
  eq(JSON.parse(readFileSync(join(qdir, 'meta.json'), 'utf8')).classifiedAs, 'prefix', 'meta 记录分类')
  const entries = listQuarantine()
  eq(entries.length, 1, 'listQuarantine 计数')

  // gc：一条刚隔离（保留），一条 40 天前（删除，retentionDays=30）。
  // age 取条目内全部文件 mtime 的最大值（含 meta.json）→ 目录+每个文件都要拨。
  const ageEntry = (dir, date) => {
    utimesSync(dir, date, date)
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), date, date)
  }
  writeFileSync(join(fxRoot, 'q-old.txt'), 'old')
  const oldDir = quarantineFile(join(fxRoot, 'q-old.txt'), { sessionId: 'session-test0001', kind: 'conflict-copy' })
  ageEntry(oldDir, new Date(Date.now() - 40 * 864e5))
  const cfg = { retentionDays: 30, exportRetentionDays: 180, maxQuarantineBytes: 512 * 1024 * 1024 }
  const gc1 = gcQuarantine(cfg)
  eq(gc1.deleted, 1, '过期条目删除')
  ok(existsSync(entries[0].dir), '未过期条目保留')

  // 分叉导出类更久保留。
  writeFileSync(join(fxRoot, 'q-exp.txt'), 'exp')
  const expDir = quarantineFile(join(fxRoot, 'q-exp.txt'), { sessionId: 's', kind: 'divergent-export', classifiedAs: 'divergent' })
  ageEntry(expDir, new Date(Date.now() - 40 * 864e5))
  eq(gcQuarantine(cfg).deleted, 0, 'divergent-export 40 天不删（180 天保留期）')

  // 总量上限：限 1 字节 → 最旧优先删。
  eq(gcQuarantine({ retentionDays: 30, exportRetentionDays: -1, maxQuarantineBytes: 1 }).deleted, 2, '总量超限最旧优先删')

  // divergent 导出文件形态。
  const edir = join(fxRoot, 't-export')
  writeSession(edir, 'session.v4.jsonl.zstd', healthyLog())
  writeSession(edir, 'session.v4.jsonl.sync-conflict-20261113-100000-BBBBBB.zstd', Buffer.concat([healthyLog(), frameOf([event(9, 'user/message', { message: 'extra' })])]))
  const verdict = auditCopyFile(join(edir, 'session.v4.jsonl.sync-conflict-20261113-100000-BBBBBB.zstd'), join(edir, 'session.v4.jsonl.zstd'))
  const exportPath = writeDivergentExport(edir, 'session.v4.jsonl.sync-conflict-20261113-100000-BBBBBB.zstd', verdict, { sessionId: 's' })
  const exportLines = readFileSync(exportPath, 'utf8').trim().split('\n')
  ok(exportLines.some((l) => l.includes('only-in-copy') || l.includes('"seq":9')), '导出含 copyOnly 记录')
}

// ═══════════════════════════════ intercept ════════════════════════════
section('intercept.mjs 写打开门禁')
{
  const cfg = { ...loadConfig({ startupGc: false }) }
  const identity = loadIdentity()
  const sid = 'session-intercept1-2222-3333-4444-555555555555'
  const sdir = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', sid)

  function fakePersistence(dir) {
    const calls = []
    const inst = {
      calls,
      stat: async (id) => (dir ? { location: { kind: 'canonical', path: join(dir, 'session.v4.jsonl.zstd') }, header: { id } } : undefined),
      open: async (id, access) => {
        calls.push(['open', id, access])
        return {
          id,
          access,
          append: async () => calls.push(['append', id]),
          flush: async () => {},
          close: async () => calls.push(['close', id]),
        }
      },
      create: async (header) => {
        calls.push(['create', header.id])
        return {
          id: header.id,
          access: 'write',
          append: async () => calls.push(['append', header.id]),
          flush: async () => {},
          close: async () => calls.push(['close', header.id]),
        }
      },
      flush: async () => {},
      list: async () => [],
    }
    return inst
  }

  // t1: 干净目录 → open 放行 + held 标记落盘；close → released（AC2 语义）。
  writeSession(sdir, 'session.v4.jsonl.zstd', healthyLog())
  const i1 = fakePersistence(sdir)
  const restore1 = wrapPersistence(i1, identity, cfg, () => {})
  const h1 = await i1.open(sid, 'write')
  eq(readMarker(sdir).data.state, 'held', '写打开 → held 标记')
  await h1.close()
  eq(readMarker(sdir).data.state, 'released', 'handle.close → released')
  eq(readMarker(sdir).data.machineId, identity.uuid, 'released 保留本机归属')
  ok(i1.calls.some((c) => c[0] === 'open'), '原始 open 被调用')

  // t2: 异机 held → SessionAlreadyOwnedError，原始 open 不调用，文件 hash 不变（AC1）。
  writeFileSync(markerPath(sdir), JSON.stringify({ v: 1, machineId: 'uuid-OTHER', host: 'other-box', pid: 1, sessionId: sid, state: 'held' }))
  const beforeHash = sha256(join(sdir, 'session.v4.jsonl.zstd'))
  const i2 = fakePersistence(sdir)
  wrapPersistence(i2, identity, cfg, () => {})
  ok(await throwsName(() => i2.open(sid, 'write'), 'SessionAlreadyOwnedError'), '异机 held 拦（SessionAlreadyOwnedError）')
  const err2 = await i2.open(sid, 'write').catch((e) => e)
  ok(String(err2.message).includes('other-box'), '错误消息含持有主机名')
  eq(i2.calls.filter((c) => c[0] === 'open').length, 0, '原始 open 未被调用')
  eq(sha256(join(sdir, 'session.v4.jsonl.zstd')), beforeHash, '拦截时文件字节不动')

  // t3: released → 放行并翻转 held（先把 t2 的异机 held 翻成 released）。
  releaseMarker(sdir)
  const i3 = fakePersistence(sdir)
  wrapPersistence(i3, identity, cfg, () => {})
  const h3 = await i3.open(sid, 'write')
  eq(readMarker(sdir).data.state, 'held', 'released → 本机接管 held')
  await h3.close()

  // t4: prefix 副本 → 自动隔离（AC5 前半）。
  const s4 = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-intercept2-2222-3333-4444-555555555555')
  writeSession(s4, 'session.v4.jsonl.zstd', healthyLog())
  writeSession(s4, 'session.v4.jsonl.sync-conflict-20261113-100000-CCCCCC.zstd', frameOf([headerLine(), event(1, 'turn/start')]))
  const i4 = fakePersistence(s4)
  wrapPersistence(i4, identity, cfg, () => {})
  const h4 = await i4.open('session-intercept2-2222-3333-4444-555555555555', 'write')
  eq(inventorySessionDir(s4).logConflicts.length, 0, 'prefix 副本被自动隔离')
  eq(listQuarantine().some((e) => e.meta?.sessionId?.includes('intercept2')), true, '隔离区有记录')
  await h4.close()

  // t5: divergent 副本 + block → XlockDivergentError，副本保留（AC5 后半）。
  const s5 = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-intercept3-2222-3333-4444-555555555555')
  writeSession(s5, 'session.v4.jsonl.zstd', healthyLog())
  const copyName = 'session.v4.jsonl.sync-conflict-20261113-100000-DDDDDD.zstd'
  writeSession(s5, copyName, Buffer.concat([healthyLog(), frameOf([event(7, 'user/message', { message: 'extra' })])]))
  const i5 = fakePersistence(s5)
  wrapPersistence(i5, identity, { ...cfg, divergentGate: 'block' }, () => {})
  ok(await throwsName(() => i5.open('session-intercept3-2222-3333-4444-555555555555', 'write'), 'XlockDivergentError'), 'divergent+block 拦（XlockDivergentError）')
  eq(existsSync(join(s5, copyName)), true, 'divergent 副本不被自动删')
  ok(!existsSync(markerPath(s5)), '拦截路径不落标记')

  // t6: divergent + warn → 放行。
  const i6 = fakePersistence(s5)
  wrapPersistence(i6, identity, { ...cfg, divergentGate: 'warn' }, () => {})
  const h6 = await i6.open('session-intercept3-2222-3333-4444-555555555555', 'write')
  eq(existsSync(join(s5, copyName)), true, 'warn 模式副本保留')
  await h6.close()

  // t7: torn 末行 → open 前自动修复（AC4）。
  const s7 = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-intercept4-2222-3333-4444-555555555555')
  writeSession(
    s7,
    'session.v4.jsonl.zstd',
    Buffer.concat([
      frameOf([headerLine(), event(1, 'turn/start')]),
      zstdCompressSync(Buffer.from(`${event(2, 'user/message')}\n{"seq":3,"type":"user/mess`, 'utf8')),
    ]),
  )
  const i7 = fakePersistence(s7)
  wrapPersistence(i7, identity, cfg, () => {})
  const h7 = await i7.open('session-intercept4-2222-3333-4444-555555555555', 'write')
  eq(walkLog(readFileSync(join(s7, 'session.v4.jsonl.zstd'))).health.tornJsonlLastLine, false, '写打开前已修复')
  await h7.close()

  // t8: create() → 首次 append 时补挂标记（目录已物化）。
  const s8 = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-intercept5-2222-3333-4444-555555555555')
  mkdirSync(s8, { recursive: true })
  writeSession(s8, 'session.v4.jsonl.zstd', healthyLog())
  const i8 = fakePersistence(s8)
  wrapPersistence(i8, identity, cfg, () => {})
  const h8 = await i8.create({ id: 'session-intercept5-2222-3333-4444-555555555555' })
  eq(existsSync(markerPath(s8)), false, 'create 后 append 前无标记')
  await h8.append([JSON.parse(event(1, 'turn/start'))])
  eq(readMarker(s8)?.data?.state, 'held', '首次 append 补挂 held 标记')
  await h8.close()

  // t9: read 打开直通，不建标记。
  const i9 = fakePersistence(s8)
  wrapPersistence(i9, identity, cfg, () => {})
  await i9.open('session-intercept5-2222-3333-4444-555555555555', 'read')
  eq(markerStatus(s8).state, 'released', 'read 打开不动标记')

  // restore 还原方法引用。
  const i10 = fakePersistence(s8)
  const restore10 = wrapPersistence(i10, identity, cfg, () => {})
  ok(typeof i10.open === 'function' && i10.open !== null, '包装后 open 存在')
  restore10()
  ok(true, 'restore 无异常')
}

// ═══════════════════════════════ audit ═══════════════════════════════
section('audit.mjs 审计报告（AC6/AC8）')
{
  const sdir = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-audit1-2222-3333-4444-555555555555')
  writeSession(sdir, 'session.v4.jsonl.zstd', healthyLog())
  const identity = loadIdentity()
  const before = readdirSync(sdir).sort().join('|')
  const report = auditSessionDir(sdir, { identity, machines: loadMachines(), sessionName: 'session-audit1-2222-3333-4444-555555555555' })
  eq(report.needsAttention.length, 0, '健康目录 needsAttention 空')
  eq(readdirSync(sdir).sort().join('|'), before, 'AC6 audit 不改目录')
  ok(renderReport(report).includes('健康'), '报告渲染')
  // 回归：区间取事件的 time，跨度必须真实（此前首尾都退化成 header.createdAt）。
  const rangeLine = renderReport(report).split('\n').find((l) => l.includes('events, frames=')) ?? ''
  ok(
    /2023-11-14T22:13:20\.000Z → 2023-11-14T22:13:2\d\.000Z/.test(rangeLine),
    `审计区间反映事件跨度（不是首尾相同）: ${rangeLine}`,
  )

  // 分叉目录：needsAttention + 未知设备提示（AC8）。
  const sdir2 = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-audit2-2222-3333-4444-555555555555')
  writeSession(sdir2, 'session.v4.jsonl.zstd', healthyLog())
  writeSession(sdir2, 'session.v4.jsonl.sync-conflict-20261113-100000-ABC1234.zstd', Buffer.concat([healthyLog(), frameOf([event(8, 'user/message')])]))
  const report2 = auditSessionDir(sdir2, { identity, machines: { devices: {} }, sessionName: 'session-audit2-2222-3333-4444-555555555555' })
  ok(report2.needsAttention.includes('divergent-copy'), 'divergent 上报')
  const text2 = renderReport(report2)
  ok(text2.includes('ABC1234') && text2.includes('未补录'), 'AC8 未知设备短 ID 原样呈现+补录提示')
  ok(text2.includes('resolve'), '报告含 resolve 指引')
}

// ═══════════════════════════════ 创建归属 origin.mjs ═════════════════════
section('origin.mjs 创建归属判定')
{
  const me = loadIdentity()
  const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  // projectKey 必须与 DSH 实现逐字一致（桶名靠它生成）。
  eq(projectKey('C:\\work\\demo'), '--C-work-demo--', 'projectKey 复刻 DSH 折叠规则')
  eq(projectKey('D:\\work\\demo'), '--D-work-demo--', 'projectKey 处理盘符')
  eq(projectKey('C:\\a b'), '--C-a~0020b--', 'projectKey 非安全字符转 ~XXXX')
  eq(projectKey('\\'), '--root--', 'projectKey 全分隔符 → root')

  // L1：创建记录（权威）
  const odir = join(fxHome, '.dsh', 'sessions', '--C-work-demo--', 'session-origin1-2222-3333-4444-555555555555')
  writeSession(odir, 'session.v4.jsonl.zstd', healthyLog())
  eq(readOrigin(odir).state, 'missing', '无创建记录 → missing')
  eq(inferOrigin(odir, { identity: me, registry: { machines: {} } }).source, 'unknown', '无记录无桶命中 → unknown')
  ok(writeOriginOnce(odir, me, 'session-origin1', 'C:\\work\\demo'), '首次写创建记录成功')
  eq(writeOriginOnce(odir, { uuid: 'other-machine-zzz', host: 'Other' }, 'session-origin1', 'C:\\work\\demo'), false, '已存在 → 不再改写（只写一次）')
  const rec = readOrigin(odir)
  eq(rec.state, 'ok', '创建记录可读')
  eq(rec.data.machineId, me.uuid, '记录里是自己 machineId（未被二次写入覆盖）')
  const inf1 = inferOrigin(odir, { identity: me, registry: { machines: {} } })
  eq(inf1.source, 'record', 'L1 优先于桶推断')
  eq(inf1.local, true, '记录 = 本机 → local')
  eq(inf1.host, me.host, 'registry 未登记时用记录自带 host')

  // L1 异机 + registry 已知 → 显示机器名、local=false
  const odir2 = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-origin2-2222-3333-4444-555555555555')
  writeSession(odir2, 'session.v4.jsonl.zstd', healthyLog())
  writeOriginOnce(odir2, { uuid: other, host: 'peer-box' }, 'session-origin2', 'D:\\work\\demo')
  const registry = { machines: { [me.uuid]: { host: me.host, cwds: ['C:\\work\\demo'] }, [other]: { host: 'peer-box', cwds: ['D:\\work\\demo'] } } }
  const inf2 = inferOrigin(odir2, { identity: me, registry })
  eq(inf2.host, 'peer-box', 'L1 异机显示 registry 里的机器名')
  eq(inf2.local, false, 'L1 异机 → local=false')
  eq(inf2.cwd, 'D:\\work\\demo', 'L1 带出创建时 cwd')

  // L2：无记录 → 桶名推断（历史会话回填）
  const bdir = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-origin3-2222-3333-4444-555555555555')
  writeSession(bdir, 'session.v4.jsonl.zstd', healthyLog())
  const inf3 = inferOrigin(bdir, { identity: me, registry })
  eq(inf3.source, 'bucket', '无记录 → L2 桶名推断')
  eq(inf3.host, 'peer-box', 'L2 由桶名反查出 peer-box')
  eq(inf3.local, false, 'L2 异机 → local=false')
  eq(inferOrigin(bdir, { identity: me, registry: { machines: {} } }).source, 'unknown', 'registry 空 → L2 失败降级 unknown')

  // 桶名必须精确匹配，不跨机器误判
  const cdir = join(fxHome, '.dsh', 'sessions', '--C-work-demo--', 'session-origin4-2222-3333-4444-555555555555')
  writeSession(cdir, 'session.v4.jsonl.zstd', healthyLog())
  const inf4 = inferOrigin(cdir, { identity: me, registry })
  eq(inf4.host, me.host, 'C 桶 → 本机')
  eq(inf4.local, true, 'C 桶 → local=true')

  // 冲突副本：只算痕迹，不进 markerConflicts（否则会被误判成争抢挡住会话）
  const cfdir = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-origin5-2222-3333-4444-555555555555')
  writeSession(cfdir, 'session.v4.jsonl.zstd', healthyLog())
  writeOriginOnce(cfdir, me, 'session-origin5', 'C:\\work\\demo')
  writeFileSync(join(cfdir, `.dsh-xlock-origin.json.sync-conflict-20261115-120000-ABC1234.json`), '{}')
  eq(listOriginConflicts(cfdir).length, 1, '列出创建记录冲突副本')
  const inv5 = inventorySessionDir(cfdir)
  eq(inv5.markerConflicts.length, 0, '创建记录冲突副本不算标记冲突（防误挡）')
  eq(inv5.other.length, 0, '创建记录及其副本不进 other（防 status 噪音）')
  eq(inferOrigin(cfdir, { identity: me, registry }).conflicts, 1, '报告里带上冲突副本数')

  // marker 冲突副本仍然照旧被抓（回归：排除规则不能误伤真标记）
  const mkdir5 = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-origin6-2222-3333-4444-555555555555')
  writeSession(mkdir5, 'session.v4.jsonl.zstd', healthyLog())
  writeFileSync(join(mkdir5, '.dsh-xlock.json.sync-conflict-20261115-120000-ABC1234.json'), '{}')
  eq(inventorySessionDir(mkdir5).markerConflicts.length, 1, '真标记冲突副本仍被抓')
  eq(listMarkerConflicts(mkdir5).length, 1, 'listMarkerConflicts 仍认真标记副本')
  eq(listMarkerConflicts(cfdir).length, 0, 'listMarkerConflicts 不认创建记录副本')

  // 归档标记（xlock 自己迁入的元数据：新名 + 旧名双读兼容）
  const twdir = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-origin7-2222-3333-4444-555555555555')
  writeSession(twdir, 'session.v4.jsonl.zstd', healthyLog())
  writeFileSync(join(twdir, '.dsh-xlock-archive.json'), JSON.stringify({ v: 1, archived: true }))
  writeFileSync(join(twdir, '.dsh-tweaks-archive.json'), JSON.stringify({ v: 1, archived: true }))
  const inv7 = inventorySessionDir(twdir)
  eq(inv7.other.length, 0, '归档标记本体不进 other（防 status 噪音）')
  eq(inv7.markerConflicts.length, 0, '归档标记本体不算粘锁冲突（防误挡）')
  eq(listMarkerConflicts(twdir).length, 0, 'listMarkerConflicts 不认归档标记')
  eq(inv7.archiveConflicts.length, 0, '归档标记本体不算冲突副本（正常，单列只在副本时）')
  // 它的 Syncthing 冲突副本：也不许污染 markerConflicts（那会直接抛 XlockHeldError）。
  writeFileSync(join(twdir, '.dsh-xlock-archive.json.sync-conflict-20261116-173000-ABC1234.json'), '{}')
  writeFileSync(join(twdir, '.dsh-tweaks-archive.json.sync-conflict-20261116-173001-ABC1234.json'), '{}')
  const inv7b = inventorySessionDir(twdir)
  eq(inv7b.markerConflicts.length, 0, '归档标记冲突副本不算粘锁争抢')
  eq(inv7b.archiveConflicts.length, 2, '归档标记冲突副本进 archiveConflicts 桶')
  eq(inv7b.other.length, 0, '归档标记冲突副本也不进 other')
  eq(listMarkerConflicts(twdir).length, 0, 'listMarkerConflicts 不认归档标记副本')
  // 无关的同前缀文件仍要落 other（规则不能太宽）。
  writeFileSync(join(twdir, '.dsh-tweaks-other.json'), '{}')
  eq(inventorySessionDir(twdir).other.length, 1, '同前缀的无关文件仍算 other')

  // audit 报告输出归属行
  const rep = auditSessionDir(odir2, { identity: me, machines: registry, sessionName: 'session-origin2' })
  eq(rep.origin.source, 'record', 'audit 报告带 origin')
  const text = renderReport(rep)
  ok(text.includes('创建归属: peer-box（异机）') && text.includes('创建记录'), `报告渲染归属行: ${text.split('\n').find((l) => l.includes('创建归属'))}`)
  const repHist = auditSessionDir(bdir, { identity: me, machines: registry, sessionName: 'session-origin3' })
  ok(renderReport(repHist).includes('目录桶推断'), '历史会话报告标注「目录桶推断」')
}

// ═══════════════ archive.mjs / archivesync.mjs / uistate.mjs（迁入+UI 新增）══
section('archive.mjs 双读单写 + archivesync 三纪律 + uistate 状态/解锁')
{
  const {
    readArchiveMarker, writeArchiveMarker,
    ARCHIVE_MARKER_NAME, LEGACY_ARCHIVE_MARKER_NAME,
  } = await import('../core/archive.mjs')
  const { createArchiveSync } = await import('../core/archivesync.mjs')
  const { getSessionLockState, resetSessionLock } = await import('../core/uistate.mjs')

  const me = { uuid: 'uuid-LOCAL', host: 'local-host' }
  const bucket = join(fxHome, '.dsh', 'sessions', '--D-work-demo--')

  // ── archive 双读单写 ──────────────────────────────────────────────────
  const ar = join(bucket, 'session-archivetest-1111-2222-3333-444444444444')
  mkdirSync(ar, { recursive: true })
  // 旧名可读
  writeFileSync(join(ar, LEGACY_ARCHIVE_MARKER_NAME), JSON.stringify({ v: 1, archived: true, host: 'old-host', machineId: 'm-old', at: 1 }))
  const arOld = readArchiveMarker(ar)
  eq(arOld.archived, true, '旧名 .dsh-tweaks-archive.json 可读')
  eq(arOld.source, 'marker', '旧名标记 source=marker')
  // 新名优先于旧名
  writeFileSync(join(ar, ARCHIVE_MARKER_NAME), JSON.stringify({ v: 1, archived: false, host: 'new-host', machineId: 'm-new', at: 2 }))
  const arNew = readArchiveMarker(ar)
  eq(arNew.archived, false, '新名优先于旧名')
  eq(arNew.by.host, 'new-host', '新名作者正确')
  // 新名损坏不回退旧名（拿更早世代盖真实状态）
  writeFileSync(join(ar, ARCHIVE_MARKER_NAME), '{broken-json')
  const arBad = readArchiveMarker(ar)
  eq(arBad.archived, null, '新名损坏不回退旧名')
  eq(arBad.source, 'none', '新名损坏按 none 保持平台原状')

  // 单写：只写新名，绝不碰旧名存量
  const aw = join(bucket, 'session-archivewrite-1111-2222-3333-444444444444')
  mkdirSync(aw, { recursive: true })
  const legacyDoc = JSON.stringify({ v: 1, archived: true, host: 'legacy', machineId: 'm-legacy', at: 9 })
  writeFileSync(join(aw, LEGACY_ARCHIVE_MARKER_NAME), legacyDoc)
  eq(writeArchiveMarker(aw, false, me, 10).ok, true, 'writeArchiveMarker 写成功')
  eq(readFileSync(join(aw, LEGACY_ARCHIVE_MARKER_NAME), 'utf8'), legacyDoc, '单写：旧名存量未被改动')
  eq(readArchiveMarker(aw).archived, false, '新名写入后读值为 false（新名优先）')

  // ── archivesync writeDiff 三纪律 ─────────────────────────────────────
  const wdB = join(bucket, 'session-wd-1111-2222-3333-4444-555555555555')
  mkdirSync(wdB, { recursive: true })
  writeFileSync(join(wdB, ARCHIVE_MARKER_NAME), JSON.stringify({ v: 1, archived: false, host: 'seed', machineId: 'm', at: 1 }))
  const regWd = {
    archivedSessionIds: [],
    archiveSession: async () => {},
    unarchiveSession: async () => {},
  }
  const syncWd = createArchiveSync({ workspaceRegistry: regWd, on: () => () => {}, logger: {} }, 60000)
  syncWd() // 立刻停掉定时器（测试钩子 dispose 仍可用）
  // 纪律①②：真变化才写 + 目录索引一次建全（多条一次对账）
  syncWd.writeDiff(new Set(['session-wd-1111-2222-3333-4444-555555555555']))
  const wdAfter = readArchiveMarker(wdB)
  eq(wdAfter.archived, true, 'writeDiff 把新增归档 id 落成标记')
  // writeDiff 内部用默认 archiveIdentity()（不接外部 identity 参数），作者=本机真实 host
  eq(wdAfter.by.host, loadIdentity().host, 'writeDiff 写入作者为本机（默认 identity）')

  // 纪律③：盘上已是目标值不重写（防回声抹掉对端作者）
  const echoDir = join(bucket, 'session-echo-1111-2222-3333-4444-555555555555')
  mkdirSync(echoDir, { recursive: true })
  writeFileSync(join(echoDir, ARCHIVE_MARKER_NAME), JSON.stringify({ v: 1, archived: true, host: 'peer-host', machineId: 'm-peer', at: 1 }))
  const regEcho = { archivedSessionIds: [], archiveSession: async () => {}, unarchiveSession: async () => {} }
  const syncEcho = createArchiveSync({ workspaceRegistry: regEcho, on: () => () => {}, logger: {} }, 60000)
  syncEcho()
  syncEcho.writeDiff(new Set(['session-echo-1111-2222-3333-4444-555555555555']))
  eq(readArchiveMarker(echoDir).by.host, 'peer-host', '盘上已目标值不重写：对端作者未被抹成本机')

  // ── archivesync applyMarkers（读侧：只动不一致的）────────────────────
  const applyDir = join(bucket, 'session-apply-1111-2222-3333-4444-555555555555')
  mkdirSync(applyDir, { recursive: true })
  writeFileSync(join(applyDir, ARCHIVE_MARKER_NAME), JSON.stringify({ v: 1, archived: true, host: 'peer', machineId: 'm', at: 1 }))
  const applied = []
  const regApply = {
    archivedSessionIds: [],
    archiveSession: async (id, opts) => { applied.push(['archive', id, opts]) },
    unarchiveSession: async (id) => { applied.push(['unarchive', id]) },
  }
  const syncApply = createArchiveSync({ workspaceRegistry: regApply, on: () => () => {}, logger: {} }, 60000)
  await syncApply.scan() // 等 create 时的首轮 applyMarkers 跑完
  syncApply()
  ok(applied.some(([op, id]) => op === 'archive' && id === 'session-apply-1111-2222-3333-4444-555555555555'), 'applyMarkers 把对端归档标记收敛到本机归档集')
  // fixture 中更早建的归档标记也会被收敛 —— 只验证不会 archive/unarchive 无标记的会话
  const noMarker = applied.filter(([, id]) => id.includes('no-such') || id.includes('ui-1111'))
  eq(noMarker.length, 0, 'applyMarkers 不碰没有归档标记的会话')

  // ── uistate getSessionLockState / resetSessionLock ───────────────────
  const uEnv = { identity: me, registry: { machines: { [me.uuid]: { host: me.host, cwds: [] } } } }
  eq(getSessionLockState('session-no-such-thing', uEnv), null, 'getSessionLockState 找不到会话返回 null')
  const uiDir = join(bucket, 'session-ui-1111-2222-3333-4444-555555555555')
  mkdirSync(uiDir, { recursive: true })
  writeFileSync(join(uiDir, ARCHIVE_MARKER_NAME), JSON.stringify({ v: 1, archived: true, host: 'peer', machineId: 'm', at: 1 }))
  writeFileSync(markerPath(uiDir), JSON.stringify({ v: 1, machineId: 'uuid-ELSEWHERE', host: 'peer-box', pid: 7, sessionId: 'session-ui-1111-2222-3333-4444-555555555555', state: 'held' }))
  const st = getSessionLockState('session-ui-1111-2222-3333-4444-555555555555', uEnv)
  eq(st.lockState, 'held-foreign', 'uistate 异机 held → held-foreign')
  eq(st.host, 'peer-box', 'uistate 带出持锁主机')
  eq(st.archived, true, 'uistate 同显归档状态')
  // 前缀不精确 → 拒绝
  const uiDir2 = join(bucket, 'session-ui-2222-2222-3333-4444-555555555555')
  mkdirSync(uiDir2, { recursive: true })
  const pre = resetSessionLock('session-ui-')
  eq(pre.ok, false, 'resetSessionLock 拒绝前缀（不精确）')
  ok(String(pre.error).includes('exact'), '前缀拒绝原因=必须精确')
  // 精确解锁：只删锁标记，归档标记不动
  const rst = resetSessionLock('session-ui-1111-2222-3333-4444-555555555555')
  eq(rst.ok, true, 'resetSessionLock 精确名成功')
  ok(rst.removed.includes('.dsh-xlock.json'), 'reset 删除锁标记')
  ok(existsSync(join(uiDir, ARCHIVE_MARKER_NAME)), 'reset 绝不碰归档标记')
  const st2 = getSessionLockState('session-ui-1111-2222-3333-4444-555555555555', uEnv)
  eq(st2.lockState, 'unmarked', 'reset 后锁状态变 unmarked')
  eq(st2.archived, true, 'reset 后归档状态保持不变')
}

// ═══════════════ live.mjs（迁入：对端活跃度）+ listSessionIds ══════════
section('live.mjs 活跃度判定（writing / silent，不做新鲜度截断）')
{
  const { SESSION_LOG_NAMES, sessionLogMtime, tailHasOpenTurn, describeActivity } = await import('../core/live.mjs')
  const { getSessionLockState, listSessionIds } = await import('../core/uistate.mjs')

  const lb = join(fxHome, '.dsh', 'sessions', '--D-work-demo--')
  const now = 1_700_000_000_000
  const logName = SESSION_LOG_NAMES[0]

  // ── sessionLogMtime ──────────────────────────────────────────────────
  const freshDir = join(lb, 'session-live-fresh-1111-2222-3333-444444444444')
  mkdirSync(freshDir, { recursive: true })
  eq(sessionLogMtime(freshDir), null, '没日志的目录 mtime 为 null')
  writeFileSync(join(freshDir, logName), Buffer.alloc(64, 1))
  const t0 = Math.floor((now - 30_000) / 1000)
  utimesSync(join(freshDir, logName), t0, t0)
  ok(sessionLogMtime(freshDir) >= (now - 60_000), '正式日志的 mtime 被采用')

  // 正在传输的 syncthing 临时文件也是证据（正式文件大、mtime 落后）
  const syncDir = join(lb, 'session-live-sync-1111-2222-3333-444444444444')
  mkdirSync(syncDir, { recursive: true })
  const oldT = Math.floor((now - 20 * 60_000) / 1000)
  writeFileSync(join(syncDir, logName), Buffer.alloc(64, 1))
  utimesSync(join(syncDir, logName), oldT, oldT)
  writeFileSync(join(syncDir, `~syncthing~${logName}.tmp`), Buffer.alloc(512, 2))
  ok(sessionLogMtime(syncDir) >= (now - 60_000), '进行中的 syncthing tmp 计入 mtime')
  rmSync(join(syncDir, `~syncthing~${logName}.tmp`), { force: true })
  ok(sessionLogMtime(syncDir) < (now - 9 * 60_000), 'tmp 移除后回到落后值')

  // ── tailHasOpenTurn ──────────────────────────────────────────────────
  const openDir = join(lb, 'session-live-open-1111-2222-3333-444444444444')
  mkdirSync(openDir, { recursive: true })
  eq(tailHasOpenTurn(openDir), null, '没有日志时 openTurn 为 null')
  const lines = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  writeFileSync(join(openDir, `${logName}.plain.jsonl`), '')
  rmSync(join(openDir, `${logName}.plain.jsonl`), { force: true })
  writeFileSync(join(openDir, 'session.jsonl'), lines([{ type: 'turn/start' }, { type: 'message' }]))
  eq(tailHasOpenTurn(openDir), true, 'turn/start 未收尾 → openTurn')
  rmSync(join(openDir, 'session.jsonl'), { force: true })
  writeFileSync(join(openDir, 'session.jsonl'), lines([{ type: 'turn/start' }, { type: 'turn/end' }]))
  eq(tailHasOpenTurn(openDir), false, 'turn 已收尾 → 关闭')

  // 多帧 zstd：只解尾帧，且末帧被截断时用前面的
  const zDir = join(lb, 'session-live-zstd-1111-2222-3333-444444444444')
  mkdirSync(zDir, { recursive: true })
  const frameA = zstdCompressSync(Buffer.from(lines([{ type: 'turn/start' }]), 'utf8'))
  const frameB = zstdCompressSync(Buffer.from(lines([{ type: 'turn/end' }]), 'utf8'))
  writeFileSync(join(zDir, logName), Buffer.concat([frameA, frameB]))
  eq(tailHasOpenTurn(zDir), false, '多帧 zstd 取最后一帧判定（已收尾）')
  writeFileSync(join(zDir, logName), frameA)
  eq(tailHasOpenTurn(zDir), true, '只剩未收尾帧 → openTurn')

  // ── describeActivity ────────────────────────────────────────────────
  const actFresh = describeActivity(freshDir, { now, activeMs: 180000 })
  eq(actFresh.activity, 'writing', '新鲜日志 → writing')
  ok(actFresh.freshMs !== null && actFresh.freshMs < 180000, 'writing 带出新鲜度')

  const actStale = describeActivity(syncDir, { now, activeMs: 180000 })
  eq(actStale.activity, 'silent', '日志早停 → silent')
  ok(actStale.freshMs === null || actStale.freshMs > 180000, 'silent 也如实给出新鲜度（不截断）')

  // 关键：远超新鲜度窗口的残锁**仍然要判出来**，不能被静默丢弃
  const ancientDir = join(lb, 'session-live-ancient-1111-2222-3333-444444444444')
  mkdirSync(ancientDir, { recursive: true })
  writeFileSync(join(ancientDir, 'session.jsonl'), lines([{ type: 'turn/start' }]))
  const ancientT = Math.floor((now - 48 * 3600_000) / 1000)
  utimesSync(join(ancientDir, 'session.jsonl'), ancientT, ancientT)
  const actAncient = describeActivity(ancientDir, { now, activeMs: 180000 })
  eq(actAncient.activity, 'writing', '两天前的未收尾 turn 仍判 writing（不做新鲜度截断）')
  ok(actAncient.freshMs > 47 * 3600_000, '残锁的新鲜度如实报出（约两天）')
  rmSync(join(ancientDir, 'session.jsonl'), { force: true })
  eq(describeActivity(ancientDir, { now }).activity, 'silent', '连日志都没有 → silent')
  eq(describeActivity(ancientDir, { now }).lastWriteAt, null, '无日志时 lastWriteAt 为 null')

  // ── uistate.activity：只有 held-foreign 才算活跃度 ────────────────────
  const me = { uuid: 'uuid-LOCAL', host: 'local-host' }
  const uEnv = { identity: me, registry: { machines: { [me.uuid]: { host: me.host, cwds: [] } } }, now }
  const actSess = 'session-ui-live-1111-2222-3333-444444444444'
  const actDir = join(lb, actSess)
  mkdirSync(actDir, { recursive: true })
  writeFileSync(join(actDir, 'session.jsonl'), lines([{ type: 'turn/start' }]))
  const recent = Math.floor((now - 5000) / 1000)
  utimesSync(join(actDir, 'session.jsonl'), recent, recent)
  writeFileSync(markerPath(actDir), JSON.stringify({ v: 1, machineId: 'uuid-ELSEWHERE', host: 'peer-box', pid: 7, sessionId: actSess, state: 'held' }))
  const foreign = getSessionLockState(actSess, uEnv)
  eq(foreign.lockState, 'held-foreign', '异机 held 仍是 held-foreign')
  eq(foreign.activity?.activity, 'writing', 'held-foreign 带出 activity.activity=writing')

  // 本机持锁不该算「对端在跑」
  writeFileSync(markerPath(actDir), JSON.stringify({ v: 1, machineId: 'uuid-LOCAL', host: 'local-host', pid: 9, sessionId: actSess, state: 'held' }))
  const own = getSessionLockState(actSess, uEnv)
  eq(own.lockState, 'held-self', '本机 held → held-self')
  eq(own.activity, null, 'held-self 不算对端活跃度（activity=null）')

  // ── listSessionIds：全量、去重、排序，且不依赖 sessionPersistence ─────
  const ids = listSessionIds()
  ok(Array.isArray(ids) && ids.length > 0, 'listSessionIds 返回非空数组')
  ok(ids.every((id) => id.startsWith('session-')), 'listSessionIds 只收 session-* 目录')
  ok(ids.includes(actSess), 'listSessionIds 收到本段会话')
  eq([...ids].sort(), ids, 'listSessionIds 已排序')
  eq(new Set(ids).size, ids.length, 'listSessionIds 已去重')
}

// ═══════════════════════════════ 宿主半 index.js ══════════════════════
section('index.js 宿主半（真实 schemastery）')
{
  // 整包复制到临时目录 + node_modules junction（真实 ESM 解析链）。
  const hostDir = join(fxRoot, 'host-half')
  cpSync(pkg, hostDir, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${fxRoot}\\home`) })
  // 不写死机器路径：优先用运行时环境，再退到常见 profile 位置（跨机可跑）。
  const schemasteryPath = resolveSchemasteryPath()
  const nmDir = join(hostDir, 'node_modules', '@deepseek-ai')
  mkdirSync(nmDir, { recursive: true })
  cpSync(schemasteryPath, join(nmDir, 'schemastery'), { recursive: true })
  // 用宿主半同款 require 方式加载（其 ESM 入口）。
  const require_ = createRequire(join(hostDir, 'index.js'))
  let hostMod = null
  try {
    // ESM 包 → 用动态 import（file URL）。
    hostMod = await import('file:///' + hostDir.replace(/\\/g, '/') + '/index.js')
  } catch (error) {
    ok(false, `宿主半导入失败: ${error?.message || error}`)
  }
  if (hostMod) {
    eq(hostMod.name, 'dsh-xlock', 'name 导出')
    ok(typeof hostMod.Config === 'function' && typeof hostMod.Config.toJSON === 'function' && typeof hostMod.Config.type === 'string', 'Config 是 schemastery schema')
    // apply 与 fake ctx：inject 回调拿到 fake persistence，effect 立即执行包装。
    const fxSess = join(fxHome, '.dsh', 'sessions', '--D-work-demo--', 'session-hosthalf1-2222-3333-4444-555555555555')
    writeSession(fxSess, 'session.v4.jsonl.zstd', healthyLog())
    const sid = 'session-hosthalf1-2222-3333-4444-555555555555'
    let wrapped = null
    const fakeSp = {
      stat: async () => ({ location: { kind: 'canonical', path: join(fxSess, 'session.v4.jsonl.zstd') } }),
      open: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }),
      create: async () => ({ append: async () => {}, flush: async () => {}, close: async () => {} }),
      flush: async () => {},
      list: async () => [],
    }
    const logs = []
    const disposers = []
    const toolDefs = []
    const fakeCtx = {
      logger: { info: (m) => logs.push(m) },
      effect(cb) {
        const off = cb()
        disposers.push(off)
        return off
      },
      inject(deps, cb) {
        // cordis 语义（agent-loop:358 实证）：回调参数是 childCtx（Context），
        // 服务经 childCtx.<name> 属性取。
        if (deps.includes('tools')) {
          cb({
            tools: {
              register(def) {
                toolDefs.push(def)
                return () => {}
              },
            },
            effect(innerCb, tag) {
              return fakeCtx.effect(innerCb, tag)
            },
          })
          return {}
        }
        cb({
          sessionPersistence: fakeSp,
          effect(innerCb, tag) {
            return fakeCtx.effect(innerCb, tag)
          },
        })
        return {}
      },
    }
    const ret = hostMod.apply(fakeCtx, { startupGc: false })
    ok(disposers.length === 2, 'effect 已注册（wrap + tool）')
    ok(ret === undefined, 'apply 不再返回 inject 结果（effect 挂 childCtx）')
    ok(logs.some((l) => l.includes('wrapping sessionPersistence')), '日志报告包装生效')
    ok(logs.some((l) => l.includes('xlock tool registered')), '日志报告工具注册')
    // 工具定义与执行（工程化 glue，复用已测 cmd*）。
    ok(toolDefs.length === 1 && toolDefs[0].name === 'xlock', 'xlock 工具已注册')
    ok(
      typeof toolDefs[0].parameters.action.enum.includes === 'function' &&
        ['status', 'audit', 'reset', 'resolve', 'gc'].every((a) => toolDefs[0].parameters.action.enum.includes(a)),
      '工具 action 枚举完整',
    )
    const statusOut = await toolDefs[0].execute({ action: 'status' }, {})
    ok(typeof statusOut === 'string' && statusOut.includes('sessions:'), '工具 status 返回文本概览')
    const resetErr = await toolDefs[0].execute({ action: 'reset', session: 'no-such-session-zzz' }, {})
    ok(resetErr.startsWith('ERROR:') && resetErr.includes('no session dir matches'), '工具 reset 未命中会话 → ERROR 文本')
    const resetNoArg = await toolDefs[0].execute({ action: 'reset' }, {})
    ok(resetNoArg.startsWith('ERROR:') && resetNoArg.includes('session 参数'), '工具 reset 缺参 → ERROR 文本')
    // 包装是否真的生效：异机 held → open 拒。
    writeFileSync(markerPath(fxSess), JSON.stringify({ v: 1, machineId: 'uuid-ELSEWHERE', host: 'elsewhere', pid: 1, sessionId: sid, state: 'held' }))
    ok(await throwsName(() => fakeSp.open(sid, 'write'), 'SessionAlreadyOwnedError'), 'apply 后宿主实例拦截生效')
    // disposer 还原。
    await disposers[0]()
    await disposers[1]()
    ok(true, 'disposer 执行无异常')
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`)
try {
  rmSync(fxRoot, { recursive: true, force: true })
} catch {}
process.exit(fail > 0 ? 1 : 0)
