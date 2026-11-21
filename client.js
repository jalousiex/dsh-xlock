/**
 * dsh-xlock —— 浏览器半（会话行标记 + 原生菜单动作）
 *
 * 数据全部来自宿主半的只读路由：
 *   GET  /dsh-xlock/session-state   每会话的锁 / 归档 / 活跃度
 *   GET  /dsh-xlock/session-ids     全量会话 id（给平台列表做集合变化检测）
 *   POST /dsh-xlock/session-state/reset {sessionId}  只删锁标记，归档不受影响
 *
 * 视觉语言（用户 2026-11-19 定稿）：
 *   圆环 实线 + 呼吸 = 另一台机器**真在写**
 *   圆环 虚线 + 灰淡 = 只剩锁标记（残锁），超时也不隐藏——那正是要解锁的情形
 *   圆点 实线 = 创建归属来自创建记录；点线 = 由目录桶推断
 * 不再画「锁 / 归」文字徽标：锁与圆环虚线态同源、信息更少；归档态平台自己已经用
 * 行淡化 + 悬浮卡片表达了，再标一次就是重复。
 *
 * 加载器契约（DSH 硬规则）：必须是
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * 旧 `{ id, exports: fn }` 形态会崩 web boot。factory 返回的对象必须声明
 * `inject`，否则平台不发放 slots 席位（ctx.slots 取不到 → 静默不注册）。
 */

window.__ModuleLoader__.load({
	id: "dsh-xlock",
	factory: function (require) {
		"use strict";
		var React = require("react");

		var STATE = "/dsh-xlock/session-state";
		var RESET = "/dsh-xlock/session-state/reset";
		var IDS = "/dsh-xlock/session-ids";
		var REFRESH_MS = 15000;
		var CSS_TEXT = [
			'.dxl-ring{display:inline-block;width:11px;height:11px;border-radius:50%;box-sizing:border-box;cursor:default;vertical-align:middle}',
			'.dxl-ring[data-activity="writing"]{border:2px solid #f0883e;animation:dxl-pulse 1.6s ease-in-out infinite}',
			'.dxl-ring[data-activity="silent"]{border:2px dashed #8b949e;opacity:.6}',
			'.dxl-origin{display:inline-block;width:8px;height:8px;border-radius:50%;box-sizing:border-box;cursor:default;vertical-align:middle;margin-left:3px}',
			'.dxl-origin[data-source="record"]{border:1.5px solid #58a6ff}',
			'.dxl-origin[data-source="bucket"]{border:1.5px dotted #58a6ff;opacity:.75}',
			'@keyframes dxl-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
			'@media (prefers-reduced-motion:reduce){.dxl-ring[data-activity="writing"]{animation:none}}',
		].join("");

		// ── 状态容器 + 订阅（失败保留旧值标 stale，绝不因为一次拉取失败清空标记）──
		var state = { byId: {}, loaded: false, stale: false };
		var listeners = [];

		function notify() {
			for (var i = 0; i < listeners.length; i++) {
				try { listeners[i](state); } catch (e) {}
			}
		}

		function readDoc(doc) {
			var byId = {};
			var list = doc && Array.isArray(doc.sessions) ? doc.sessions : [];
			for (var i = 0; i < list.length; i++) {
				var item = list[i];
				if (!item || typeof item.sessionId !== "string") continue;
				byId[item.sessionId] = item;
			}
			return { byId: byId, loaded: true, stale: false };
		}

		function refresh() {
			return fetch(STATE, { headers: { accept: "application/json" } })
				.then(function (r) { return r.json(); })
				.then(function (doc) { state = readDoc(doc); notify(); return state; })
				.catch(function () {
					state = { byId: state.byId || {}, loaded: state.loaded, stale: true };
					notify();
					return state;
				});
		}

		function useXlock() {
			var pair = React.useState(state);
			var value = pair[0];
			var setValue = pair[1];
			React.useEffect(function () {
				function listener(next) { setValue(next); }
				listeners.push(listener);
				listener(state);
				return function () {
					var at = listeners.indexOf(listener);
					if (at >= 0) listeners.splice(at, 1);
				};
			}, []);
			return value;
		}

		function hostOf(item) {
			return item.host || (item.createdHost || "");
		}

		/** 活跃度三态文案（圆环 tooltip）。残锁也如实说明「多久没有新日志」。 */
		function ringLabel(item) {
			var host = hostOf(item) || "另一台机器";
			var act = (item && item.activity) || null;
			var writing = act && act.activity === "writing";
			var freshMs = act && typeof act.freshMs === "number" ? act.freshMs : null;
			if (writing) {
				return "另一台机器（" + host + "）正在运行这个会话";
			}
			if (freshMs !== null) {
				var sec = Math.max(0, Math.round(freshMs / 1000));
				var ago = sec < 90 ? sec + " 秒" : Math.round(sec / 60) + " 分钟";
				return "另一台机器（" + host + "）留下了锁标记，已停止写入 " + ago + "；可在会话菜单「解除跨机锁」";
			}
			return "另一台机器（" + host + "）留下了锁标记，没有可判读的会话日志；可在会话菜单「解除跨机锁」";
		}

		/**
		 * 会话行左侧的活跃度圆环（`sidebar.session.row.leading`）。
		 *
		 * 只画 **held-foreign**：本机持有 / 已释放 / 无标记都是正常状态，画出来只是噪音。
		 * 平台只在本行 primary status 为 idle 时才渲染这个槽（本机自己在跑的会话由平台
		 * 自己画状态点），所以两者永不并排。
		 *
		 * 不设新鲜度截断：残锁（日志早停）也画，只是换成虚线灰淡 —— 那恰是最需要
		 * 人看见并解锁的状态。
		 */
		function RemoteRunningMark(props) {
			var data = useXlock();
			var sessionId = props && props.sessionId;
			var item = sessionId && data.byId ? data.byId[sessionId] : null;
			if (!item || item.lockState !== "held-foreign") return null;
			var writing = Boolean(item.activity && item.activity.activity === "writing");
			var label = ringLabel(item);
			return React.createElement("span", {
				className: "dxl-ring",
				role: "img",
				"aria-label": label,
				title: label,
				"data-dsh-xlock": hostOf(item) || "unknown",
				"data-activity": writing ? "writing" : "silent",
			});
		}

		/**
		 * 会话行左侧的创建归属圆点（同一格，order 排在圆环之后）。
		 *
		 * 只画**异机创建**的行：本机建的是默认情况，画满一屏等于噪音；归属未知不画
		 * （宁可没有，也不拿锁标记猜）。与圆环同格，所以对端正在跑时让路——
		 * 同一格永远只有一个标记。
		 */
		function SessionOriginMark(props) {
			var data = useXlock();
			var sessionId = props && props.sessionId;
			var item = sessionId && data.byId ? data.byId[sessionId] : null;
			if (!item) return null;
			if (item.lockState === "held-foreign") return null;
			if (item.createdRemote !== true) return null;
			var source = item.originSource;
			if (source !== "record" && source !== "bucket") return null;
			var host = item.createdHost || "另一台机器";
			var basis = source === "record" ? "创建记录" : "目录桶推断";
			var label = "这条会话是在 " + host + " 上创建的 · 依据" + basis;
			return React.createElement("span", {
				className: "dxl-origin",
				role: "img",
				"aria-label": label,
				title: label,
				"data-dsh-xlock": host,
				"data-source": source,
			});
		}

		/**
		 * 会话「...」菜单 / 右键菜单里的「解除跨机锁」。
		 * 走原生 `ctx.contextMenus`：字体、行高、图标位、键盘导航全部由平台渲染，
		 * 与「重命名 / 固定 / 归档」等内置项完全一致（自绘 slot button 做不到）。
		 * 只在 held-foreign 时产出动作。
		 */
		function registerMenu(ctx) {
			return ctx.contextMenus.register({
				id: "xlock.unlock",
				target: "session",
				order: 120,
				observe: function () { return []; },
				resolve: function (target) {
					var sessionId = target && target.sessionId;
					var item = sessionId && state.byId ? state.byId[sessionId] : null;
					if (!item || item.lockState !== "held-foreign") return [];
					var host = hostOf(item) || "异机";
					return [{
						id: "xlock.unlock",
						label: "解除跨机锁（" + host + "）",
						danger: true,
						run: function () {
							return fetch(RESET, {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ sessionId: sessionId }),
							})
								.then(function () { return refresh(); })
								.catch(function () {});
						},
					}];
				},
			});
		}

		// ── 会话集合变化检测 ────────────────────────────────────────────────
		// 平台只在连接建立时重拉一次会话列表，之后靠事件增量维护。异机删掉一条会话
		// 时本机不会产生 session/disposed，那行会一直挂着。宿主半扫盘能看见「少了一条」，
		// 所以由它给出全量集合；客户端比对集合变了就让平台重拉权威基线（基线里已消失
		// 的身份会被移除）。宁可让平台重算，也不要在客户端自己拼列表。
		var sessionSet = { lastIds: "", refreshCount: 0, lastError: "" };
		var clientCtx = null;

		function checkSessionSet(ids) {
			var key = (Array.isArray(ids) ? ids.slice().sort() : []).join(",");
			if (key === sessionSet.lastIds) return false;
			sessionSet.lastIds = key;
			refreshPlatformSessions();
			return true;
		}

		function refreshPlatformSessions() {
			var sessions = null;
			try {
				sessions = clientCtx && typeof clientCtx.get === "function" ? clientCtx.get("sessions") : null;
			} catch (e) {
				sessions = null;
			}
			if (!sessions || typeof sessions.refresh !== "function") {
				sessionSet.lastError = "sessions service unavailable";
				return Promise.resolve(false);
			}
			return Promise.resolve(sessions.refresh()).then(function () {
				sessionSet.refreshCount = sessionSet.refreshCount + 1;
				sessionSet.lastError = "";
				return true;
			}).catch(function (error) {
				sessionSet.lastError = String((error && error.message) || error);
				return false;
			});
		}

		function pollSessionIds() {
			return fetch(IDS, { headers: { accept: "application/json" } })
				.then(function (r) { return r.json(); })
				.then(function (doc) { checkSessionSet(doc && doc.ids); })
				.catch(function () {});
		}

		var timer = null;
		var idTimer = null;
		function install() {
			var el = document.createElement("style");
			el.setAttribute("data-plugin-css", "dsh-xlock");
			el.textContent = CSS_TEXT;
			document.head.appendChild(el);
			void refresh();
			void pollSessionIds();
			timer = setInterval(function () { void refresh(); }, REFRESH_MS);
			idTimer = setInterval(function () { void pollSessionIds(); }, REFRESH_MS);
			return function () {
				if (timer) { clearInterval(timer); timer = null; }
				if (idTimer) { clearInterval(idTimer); idTimer = null; }
				if (el && el.parentNode) el.parentNode.removeChild(el);
			};
		}

		function apply(ctx) {
			clientCtx = ctx;
			ctx.effect(function () { return install(); }, "dsh-xlock: polling and styles");
			ctx.effect(function () { return registerMenu(ctx); }, "dsh-xlock: session menu action");
			ctx.slots.inject("sidebar.session.row.leading", function () {
				return ctx.slots.register({
					name: "sidebar.session.row.leading",
					id: "xlock-remote",
					order: 20,
					label: function () { return "异机运行中"; },
				}, RemoteRunningMark);
			});
			ctx.slots.inject("sidebar.session.row.leading", function () {
				return ctx.slots.register({
					name: "sidebar.session.row.leading",
					id: "xlock-origin",
					order: 30,
					label: function () { return "会话创建归属"; },
				}, SessionOriginMark);
			});
		}

		var exports = {
			inject: ["slots", "contextMenus"],
			STATE: STATE,
			RESET: RESET,
			IDS: IDS,
			apply: apply,
			readDoc: readDoc,
			refresh: refresh,
			pollSessionIds: pollSessionIds,
			__internals: {
				useXlock: useXlock,
				ringLabel: ringLabel,
				RemoteRunningMark: RemoteRunningMark,
				SessionOriginMark: SessionOriginMark,
				registerMenu: registerMenu,
				checkSessionSet: checkSessionSet,
			},
		};
		return exports;
	},
});
