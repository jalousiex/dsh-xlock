/**
 * dsh-xlock — DSH 原生工具注册（工程化：模型只做触发与参数搬运，全部判定走 core/*）。
 *
 * 动机（用户要求 m01580）：跨机接管逃生门 reset 不能依赖 dsh-xlock.ps1 ——
 * mobile / 无 shell 环境下用户只能与助手对话。注册为 DSH 原生工具后，
 * 任何会话里一句话即可触发；错误消息里的指引同步指向本工具。
 *
 * 注册形态对齐 dsh-plugin-market/src/tools.ts:66-71（普通 bundle 直接注册）：
 *   ctx.inject(['tools'], (toolCtx) => { toolCtx.tools.register(definition) })
 * 校验规则见 dsh-tools/src/index.ts:128（output.schema/render、timeoutMs、
 * name!==保留名 'run_code'）。
 */
import { cmdAudit, cmdResolve, cmdReset, cmdStatus, cmdGc } from '../cli/xlock.mjs'

/**
 * cmd* 函数全部同步并向 process.stdout 写结果；宿主进程（GUI 子系统）stdout
 * 不可见，工具需把结果作为字符串返回 → 临时接管 stdout.write 捕获输出。
 * 同步代码单线程执行，finally 保证恢复；异常向调用方（execute）传播。
 */
function captureStdout(fn) {
  const chunks = []
  if (!process.stdout || typeof process.stdout.write !== 'function') {
    fn()
    return '(output not capturable: no stdout)'
  }
  const orig = process.stdout.write
  process.stdout.write = function (chunk) {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join('')
}

export function defineXlockTool() {
  return {
    name: 'xlock',
    description: [
      'dsh-xlock 跨机会话粘锁与同步冲突副本管理（纯工程工具，不含智能判断）。',
      'status=全部会话的锁标记/冲突副本概览+隔离区统计；',
      'audit=会话目录双边画像走查报告（只读不改文件）；',
      'reset=删除会话粘锁标记（跨机接管唯一逃生门）——仅当确认持有方机器已停写（已崩溃或放弃该会话）时使用；',
      'resolve=裁决同步冲突副本（keep=primary 以主文件为准 / copy 以副本换正，换正前自动修复 torn 末行）；',
      'gc=清理过期/超限隔离区（ledger 留痕）。',
      'session 参数支持 session id 片段模糊匹配（必须唯一命中）。',
    ].join(''),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'audit', 'reset', 'resolve', 'gc'],
        description: '子命令',
      },
      session: {
        type: 'string',
        description: 'session id 或唯一前缀（audit/reset/resolve 必填）',
      },
      keep: {
        type: 'string',
        enum: ['primary', 'copy'],
        description: 'resolve 裁决方向（resolve 必填）：primary=以主文件为准，copy=以副本换正',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      if (exec?.signal?.throwIfAborted) exec.signal.throwIfAborted()
      const action = args?.action
      const session = args?.session
      try {
        switch (action) {
          case 'status':
            return captureStdout(() => cmdStatus()) || '(no output)'
          case 'audit': {
            if (!session) return 'ERROR: audit 需要 session 参数（全量概览请用 action=status）'
            return captureStdout(() => cmdAudit([session])) || '(no output)'
          }
          case 'reset': {
            if (!session) return 'ERROR: reset 需要 session 参数'
            return captureStdout(() => cmdReset([session])) || '(no output)'
          }
          case 'resolve': {
            if (!session) return 'ERROR: resolve 需要 session 参数'
            if (args.keep !== 'primary' && args.keep !== 'copy') return 'ERROR: resolve 需要 keep=primary|copy'
            return captureStdout(() => cmdResolve([session, '--keep', args.keep])) || '(no output)'
          }
          case 'gc':
            return captureStdout(() => cmdGc()) || '(no output)'
          default:
            return `ERROR: unknown action "${action}"（status|audit|reset|resolve|gc）`
        }
      } catch (error) {
        return `ERROR: ${error?.message || String(error)}`
      }
    },
  }
}

/**
 * 注册工具。tools = tools 服务实例（toolCtx.tools）。
 * @returns 注册 disposer（失败/无服务返回 undefined，绝不抛——插件 bug 不得弄哑会话）。
 */
export function registerXlockTool(tools) {
  if (!tools || typeof tools.register !== 'function') return undefined
  return tools.register(defineXlockTool())
}
