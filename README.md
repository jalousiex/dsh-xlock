# dsh-xlock — 跨机会话锁

给多机 Syncthing 同步 `~/.dsh/sessions` 的 DeepSeek Harness 用户：让一台机器正在用的会话，另一台机器打不开、也写不坏。

## 解决什么问题

DSH 的会话写锁是本机信号量，管不到另一台机器。两机先后打开同一个会话就会双写分叉；Syncthing 产生的冲突副本对 DSH 是隐形文件，出了错也没人告诉你。

## 功能

| 能力 | 说明 |
| --- | --- |
| 跨机写锁 | 会话运行时在会话目录落粘性标记 `.dsh-xlock.json`；异机写打开（resume/prompt）被拦，UI 显示持有主机 |
| 写前修复 | 写打开前走查 zstd 帧：截断的 JSONL 末行自动原位修复（原字节留证） |
| 冲突分诊 | Syncthing 冲突副本自动识别：identical/prefix 隔离、divergent 按配置拦截或告警、可 CLI 裁决 |
| 创建归属 | 每个会话记录当初哪台机器建的（标记 > 桶名反查 > 未知） |
| 归档同步 | 平台归档状态落成贴身标记随会话目录同步，两机归档列表对账 |
| 浏览器 UI | 异机持锁圆环（实线=在写/虚线=残锁）、归属圆点、会话菜单「解除跨机锁」 |

## 设计思路

- **fail-safe**：锁标记只由会话 open/close 翻转，崩溃残留宁可多拦不漏拦；对端确已停写后由人显式解锁（CLI `reset` 或会话菜单），插件不自行猜测。
- **工程化而非智能**：帧走查、冲突分诊全部确定性代码，不依赖大模型。
- **不动平台**：对 `sessionPersistence` 做实例级方法包装，不改原型、不重 provide；`machineId` 存同步面之外，随机器不随目录。
- **标记即数据库**：锁/归属/归档都是会话目录内的小 JSON 文件，借 Syncthing 本身同步，不引入任何跨机网络。

## CLI

```powershell
dsh-xlock.ps1 status                               # 全局状态总览
dsh-xlock.ps1 audit  <session|all>                 # 只读审计
dsh-xlock.ps1 reset  <session>                     # 跨机逃生门：删粘锁标记
dsh-xlock.ps1 resolve <session> --keep primary|copy # 裁决冲突副本
dsh-xlock.ps1 gc                                   # 隔离区清理
```

DSH 原生工具 `xlock` 同名同语义（GUI / mobile 可达）。

## 配置

包内 `config.json` 随同步面共享。常用：`divergentGate`（分叉副本拦截/放行）、`sessionActiveMs`（对端活跃判定窗口）、`retentionDays`（隔离区保留）。其余见文件内注释。

## 安装

本仓库是开发用源码目录，不直接发布到 npm。profile 的 `dependencies` 写 `file:` 相对路径指向本目录，`pnpm install` 后应为真实目录（非 Junction）。装后重启 DSH。

另一台机器（同步盘带过去源码后）：

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\dsh-plugins\dsh-xlock\install-into-profile.ps1" -ProfileName desktop
```

## 边界

- 分钟级同步延迟窗口内的双开仍可能分叉（无跨机 CAS），只能缩小不能消除；事后靠修复层 + audit + resolve 兜底。
- 只读浏览与 DSH 之外的文件工具不经过写打开，不受拦。
- `machines.json` 含本机信息，故意不进仓库；首次运行自动生成。

## 测试

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" test\run.mjs
```
