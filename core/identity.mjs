/**
 * dsh-xlock — 机器身份：machineId 的生成与加载。
 *
 * 存放于 %LOCALAPPDATA%\dsh-xlock\machineId.json：
 * - LOCALAPPDATA 不在 Syncthing 同步面，天然机器绑定，免注册表依赖；
 * - 防克隆守卫：host 不匹配（整盘克隆到新机器）→ 判陈旧并重新生成 uuid。
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { ensureDir, readJsonSafe, atomicWriteText } from './util.mjs'

/**
 * %LOCALAPPDATA%\dsh-xlock 根目录（隔离区与身份文件的家）。
 * @returns {string}
 */
export function xlockDataRoot() {
  return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Local'), 'dsh-xlock')
}

/**
 * 加载（或首次生成）本机身份。
 * @returns {{uuid:string, host:string, createdAt:string}}
 */
export function loadIdentity() {
  const dir = xlockDataRoot()
  const path = join(dir, 'machineId.json')
  const host = hostname()
  const existing = readJsonSafe(path, undefined)
  if (
    existing &&
    typeof existing.uuid === 'string' &&
    existing.uuid.length >= 8 &&
    existing.host === host
  ) {
    return existing
  }
  // 不存在 / 损坏 / 克隆（host 不匹配）→ 重新生成。
  const identity = { v: 1, uuid: randomUUID(), host, createdAt: new Date().toISOString() }
  ensureDir(dir)
  atomicWriteText(path, `${JSON.stringify(identity, null, 2)}\n`)
  return identity
}
