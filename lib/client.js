/**
 * Session archive manager — browser half (prebuilt module-loader bundle).
 *
 * Adds three seats to the shipped GUI:
 *   - `sidebar.panellist` + `main` (key `archive-manager`): the manager panel.
 *   - `sidebar.workspaces.session.menu.item`: "永久删除" on an archived row.
 *   - `shell.overlay`: the deletion confirmation and the result toast.
 *
 * Every destructive request goes to this package's host half at
 * `/archive-manager/api`; the panel never touches storage directly.
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-archive-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const store = require("@deepseek-ai/dsh-client-store");

		//#region styles
		const CSS = [
			".am_root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}",
			".am_header{padding:20px 24px 12px}",
			".am_title{font-size:16px;font-weight:600;line-height:24px}",
			".am_subtitle{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".am_toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 24px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}",
			".am_search{flex:1 1 200px;min-width:150px}",
			".am_count{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".am_spacer{flex:1 1 auto}",
			".am_list{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 12px 24px}",
			".am_row{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:8px}",
			".am_row:hover{background:var(--dsw-alias-bg-layer-1)}",
			".am_rowMain{flex:1 1 auto;min-width:0}",
			".am_rowTitle{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".am_rowMeta{margin-top:2px;display:flex;gap:10px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".am_rowActions{display:flex;gap:4px;flex:0 0 auto}",
			".am_warning{display:flex;gap:8px;align-items:flex-start;margin:0 24px 8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
			".am_error{margin:0 24px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}",
			".am_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:200px;color:var(--dsw-alias-label-secondary);font-size:13px}",
			".am_emptyTitle{font-size:14px;color:var(--dsw-alias-label-primary)}",
			".am_confirmList{max-height:200px;overflow:auto;margin:4px 0 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px}",
			".am_confirmItem{padding:6px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}",
			".am_confirmItem:last-child{border-bottom:none}",
			".am_confirmName{font-weight:500}",
			".am_confirmPath{margin-top:2px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
			".am_ack{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}",
			".am_badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-state-warn-primary)}",
		].join("");
		const CSS_TAG = "dsh-desktop-archive-manager/archive-manager.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-desktop-archive-manager";
			tag.dataset.pluginCss = CSS_TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locales
		const NS = "archive-manager";
		const en = {
			panel: "Archives",
			title: "Archive manager",
			subtitle: "Archived sessions keep their logs on disk until you delete them here. Deleting is permanent.",
			refresh: "Refresh",
			search: "Filter archived sessions",
			empty: "No archived sessions",
			emptyHint: "Archive a session from its row menu to see it here.",
			selectAll: "Select all",
			selected: "{count} selected",
			restore: "Restore",
			restoreSelected: "Restore selected",
			delete: "Delete",
			deleteSelected: "Delete selected",
			summary: "{count} archived · {size} on disk",
			unknownTitle: "Untitled session",
			ungrouped: "Ungrouped",
			subagent: "Subagent session",
			time: "Created {time}",
			sizeLabel: "{size} · {files} files",
			missing: "No stored log found",
			confirmTitle: "Delete archived sessions permanently",
			confirmIntro: "{count} session(s) will be removed from disk, including their logs and cached projections. This cannot be undone:",
			confirmAck: "I understand these sessions cannot be recovered",
			cancel: "Cancel",
			confirmDelete: "Delete permanently",
			deleteDone: "Deleted {count} session(s)",
			deleteLive: "Deleted {count} session(s) from disk; {live} still live in this run and will be swept after a restart",
			deletePartial: "Deleted {count}, {failed} failed",
			deleteFailed: "Deletion failed",
			restoreDone: "Restored {count} session(s)",
			busy: "Working…",
			hostError: "Archive manager host half is unavailable",
			menuDelete: "Delete permanently",
			pendingRestart: "Deleted · cleans up after restart",
			close: "Close",
		};
		const zh = {
			panel: "归档",
			title: "归档管理",
			subtitle: "已归档的会话会一直占用磁盘，直到你在这里删除它们。删除后无法恢复。",
			refresh: "刷新",
			search: "筛选已归档会话",
			empty: "暂无已归档的会话",
			emptyHint: "在会话行的菜单里执行「归档」后，会话会出现在这里。",
			selectAll: "全选",
			selected: "已选择 {count} 项",
			restore: "恢复",
			restoreSelected: "恢复所选",
			delete: "删除",
			deleteSelected: "删除所选",
			summary: "共 {count} 个归档会话 · 占用 {size}",
			unknownTitle: "未命名会话",
			ungrouped: "未分组",
			subagent: "子代理会话",
			time: "创建于 {time}",
			sizeLabel: "{size} · {files} 个文件",
			missing: "未找到会话日志",
			confirmTitle: "永久删除已归档会话",
			confirmIntro: "以下 {count} 个会话将被从磁盘删除，包括会话日志与投影缓存。此操作无法撤销：",
			confirmAck: "我了解这些会话删除后无法恢复",
			cancel: "取消",
			confirmDelete: "永久删除",
			deleteDone: "已删除 {count} 个会话",
			deleteLive: "已删除 {count} 个会话的磁盘数据；其中 {live} 个仍在本次运行的进程中，重启后自动清理",
			deletePartial: "已删除 {count} 个，{failed} 个失败",
			deleteFailed: "删除失败",
			restoreDone: "已恢复 {count} 个会话",
			busy: "处理中…",
			hostError: "归档管理器主机端不可用",
			menuDelete: "永久删除",
			pendingRestart: "已删除 · 待重启清理",
			close: "关闭",
		};
		//#endregion

		//#region host channel
		const ENDPOINT = "/archive-manager/api";
		async function callHost(op, payload) {
			let response;
			try {
				response = await fetch(ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json", "x-dsh-archive-manager": "1" },
					body: JSON.stringify(payload === undefined ? { op } : { op, ...payload }),
				});
			}
			catch (error) {
				const failure = new Error(messageOf(error));
				failure.code = "archive-manager/unreachable";
				throw failure;
			}
			if (!response.ok) {
				const failure = new Error(`HTTP ${response.status}`);
				failure.code = "archive-manager/unreachable";
				throw failure;
			}
			const envelope = await response.json();
			if (envelope === null || typeof envelope !== "object" || envelope.ok !== true) {
				const details = envelope && envelope.error ? envelope.error : {};
				const failure = new Error(details.message || "archive manager request failed");
				failure.code = details.code;
				failure.details = details.details;
				throw failure;
			}
			return envelope.value;
		}
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		//#endregion

		//#region model
		const EMPTY_IDS = Object.freeze([]);
		class ArchiveModel {
			constructor(ctx) {
				this.ctx = ctx;
				this.requestId = 0;
				this.sequence = 0;
				this.store = store.createSnapshotStore({
					status: "idle",
					items: [],
					storageRoot: undefined,
					error: null,
					confirm: null,
					notice: null,
					busy: false,
				});
				this.subscribe = this.store.subscribe;
				this.getSnapshot = this.store.getSnapshot;
			}
			update(mutate) {
				this.store.update(mutate);
			}
			async load() {
				const requestId = ++this.requestId;
				this.update((state) => {
					state.status = state.items.length === 0 ? "loading" : "refreshing";
					state.error = null;
				});
				try {
					const value = await callHost("list");
					if (requestId !== this.requestId) return;
					this.update((state) => {
						state.items = Array.isArray(value.items) ? value.items : [];
						state.storageRoot = value.storageRoot;
						state.status = "ready";
						state.error = null;
					});
				}
				catch (error) {
					if (requestId !== this.requestId) return;
					this.update((state) => {
						state.status = "error";
						state.error = messageOf(error);
					});
				}
			}
			requestDelete(sessionIds) {
				const ids = [...sessionIds];
				if (ids.length === 0) return;
				const items = new Map(this.store.getSnapshot().items.map((item) => [item.sessionId, item]));
				this.update((state) => {
					state.confirm = { ids, rows: ids.map((id) => items.get(id) ?? { sessionId: id }) };
					state.notice = null;
				});
			}
			cancelDelete() {
				this.update((state) => {
					state.confirm = null;
				});
			}
			async confirmDelete() {
				const state = this.store.getSnapshot();
				const ids = state.confirm === null ? [] : state.confirm.ids;
				if (ids.length === 0) return;
				this.update((draft) => {
					draft.busy = true;
				});
				let results;
				try {
					const value = await callHost("deleteMany", { sessionIds: ids });
					results = Array.isArray(value.results) ? value.results : [];
				}
				catch (error) {
					this.update((draft) => {
						draft.busy = false;
						draft.confirm = null;
						draft.notice = this.notice("error", "deleteFailed", { detail: messageOf(error) });
					});
					return;
				}
				const removed = results.filter((entry) => entry.removed === true || entry.pendingRestart === true).length;
				const live = results.filter((entry) => entry.pendingRestart === true).length;
				const failed = results.filter((entry) => entry.error !== undefined).length;
				await this.refreshSessions();
				this.update((draft) => {
					draft.busy = false;
					draft.confirm = null;
				});
				await this.load();
				this.update((draft) => {
					if (failed > 0) draft.notice = this.notice("warn", "deletePartial", { count: removed, failed });
					else if (live > 0) draft.notice = this.notice("warn", "deleteLive", { count: removed, live });
					else draft.notice = this.notice("success", "deleteDone", { count: removed });
				});
			}
			async restore(sessionIds) {
				const ids = [...sessionIds];
				if (ids.length === 0) return;
				this.update((draft) => {
					draft.busy = true;
				});
				let restored = 0;
				for (const id of ids) {
					try {
						await this.ctx.uiWorkspace.unarchiveSession(id);
						restored += 1;
					}
					catch {
						// A refused restore keeps the row listed; the notice reports the count.
					}
				}
				await this.refreshSessions();
				this.update((draft) => {
					draft.busy = false;
				});
				await this.load();
				this.update((draft) => {
					draft.notice = this.notice("success", "restoreDone", { count: restored });
				});
			}
			dismissNotice() {
				this.update((draft) => {
					draft.notice = null;
				});
			}
			/** Re-pull the Session baseline so deleted rows leave the sidebar. */
			async refreshSessions() {
				try {
					await this.ctx.sessions.refresh();
				}
				catch {
					// A failed refresh only delays the row removal until the next pull.
				}
			}
			notice(tone, text, params) {
				this.sequence += 1;
				return { tone, text, params: params ?? {}, seq: this.sequence };
			}
		}
		//#endregion

		//#region components
		// The renderer flattens an inject face's `hooks` object into `use<Name>`
		// props (see the renderer's bindInjectSources), so a component takes the
		// bound selector hooks as props — never the raw `hooks` object.
		function formatTime(at) {
			if (typeof at !== "number" || !Number.isFinite(at)) return "";
			const date = new Date(at);
			const pad = (value) => String(value).padStart(2, "0");
			return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}
		function titleOf(item, sessions, t) {
			const summary = item.sessionId === undefined ? undefined : sessions.byId[item.sessionId];
			const title = summary !== undefined && typeof summary.displayTitle === "string" && summary.displayTitle !== ""
				? summary.displayTitle
				: (typeof item.title === "string" && item.title !== "" ? item.title : t("unknownTitle"));
			return title;
		}
		function workspaceLabelOf(item, workspaces, t) {
			if (item.workspaceId !== undefined) {
				const found = workspaces.items.find((workspace) => workspace.workspaceId === item.workspaceId);
				if (found !== undefined && typeof found.title === "string" && found.title !== "") return found.title;
			}
			return item.origin === "subagent" ? t("subagent") : t("ungrouped");
		}
		/** The manager panel: list, filter, batch restore, batch delete. */
		function ArchiveManagerPage(props) {
			const { t, useArchives, useArchiveWorkspaces, useArchiveSessions, reload, requestDelete, restore } = props;
			const state = useArchives((value) => value);
			const workspaces = useArchiveWorkspaces((value) => value);
			const sessions = useArchiveSessions((value) => value);
			const [query, setQuery] = react.useState("");
			const [selected, setSelected] = react.useState(EMPTY_IDS);

			const needle = query.trim().toLowerCase();
			const rows = state.items.filter((item) => {
				if (needle === "") return true;
				const title = titleOf(item, sessions, t).toLowerCase();
				const workspace = workspaceLabelOf(item, workspaces, t).toLowerCase();
				return title.includes(needle) || workspace.includes(needle);
			});
			const selectedSet = new Set(selected.filter((id) => state.items.some((item) => item.sessionId === id)));
			const selectableRows = rows.filter((item) => item.pendingRestart !== true);
			const allSelected = selectableRows.length > 0 && selectableRows.every((item) => selectedSet.has(item.sessionId));
			const totalBytes = state.items.reduce((sum, item) => sum + (typeof item.bytes === "number" ? item.bytes : 0), 0);

			// No mount-time fetch here: the model loads once when the plugin
			// applies and reloads whenever the archive set changes, so the panel is
			// always current without a per-open round trip. 刷新 forces one.
			const toggle = (sessionId, next) => {
				setSelected((current) => next
					? [...current.filter((id) => id !== sessionId), sessionId]
					: current.filter((id) => id !== sessionId));
			};
			const toggleAll = (next) => {
				setSelected(next ? selectableRows.map((item) => item.sessionId) : EMPTY_IDS);
			};

			const header = jsxs("div", {
				className: "am_header",
				children: [
					jsx("div", { className: "am_title", children: t("title") }),
					jsx("div", { className: "am_subtitle", children: t("subtitle") }),
				],
			});
			const toolbar = jsxs("div", {
				className: "am_toolbar",
				children: [
					jsx(primitives.Checkbox, {
						checked: allSelected,
						disabled: rows.length === 0,
						onChange: toggleAll,
						label: t("selectAll"),
					}),
					jsx("span", {
						className: "am_count",
						children: selectedSet.size > 0 ? t("selected", { count: selectedSet.size }) : t("summary", { count: state.items.length, size: primitives.fileSizeText(totalBytes) }),
					}),
					jsx("span", { className: "am_spacer" }),
					jsx(primitives.Input, {
						className: "am_search",
						value: query,
						placeholder: t("search"),
						icon: jsx(primitives.IconSearchOutlineRegular, { size: 16 }),
						onChange: (event) => { setQuery(event.target.value); },
					}),
					jsx(primitives.Button, {
						variant: "ghost",
						icon: jsx(primitives.IconRefreshOutlineRegular, { size: 16 }),
						onClick: () => { reload(); },
						children: t("refresh"),
					}),
					jsx(primitives.Button, {
						variant: "outline",
						disabled: selectedSet.size === 0 || state.busy,
						onClick: () => { void restore([...selectedSet]); setSelected(EMPTY_IDS); },
						children: t("restoreSelected"),
					}),
					jsx(primitives.Button, {
						variant: "primary",
						disabled: selectedSet.size === 0 || state.busy,
						onClick: () => { requestDelete([...selectedSet]); },
						children: t("deleteSelected"),
					}),
				],
			});

			const banner = jsxs("div", {
				className: "am_warning",
				children: [
					jsx(primitives.IconWarningOutlineRegular, { size: 16 }),
					jsx("span", { children: t("subtitle") }),
				],
			});

			const errorLine = state.error === null
				? null
				: jsx("div", { className: "am_error", children: `${t("hostError")}: ${state.error}` });

			const body = rows.length === 0
				? jsxs("div", {
					className: "am_empty",
					children: [
						jsx(primitives.IconArchiveOutlineRegular, { size: 28 }),
						jsx("div", { className: "am_emptyTitle", children: state.status === "loading" ? t("busy") : t("empty") }),
						state.status === "loading" ? null : jsx("div", { children: t("emptyHint") }),
					],
				})
				: jsx("div", {
					className: "am_list",
					children: rows.map((item) => jsxs("div", {
						className: "am_row",
						children: [
							jsx(primitives.Checkbox, {
								checked: selectedSet.has(item.sessionId),
								disabled: item.pendingRestart === true,
								onChange: (next) => { toggle(item.sessionId, next); },
								label: "",
							}),
							jsxs("div", {
								className: "am_rowMain",
								children: [
									jsx("div", { className: "am_rowTitle", title: titleOf(item, sessions, t), children: titleOf(item, sessions, t) }),
									jsxs("div", {
										className: "am_rowMeta",
										children: [
											jsx("span", { children: workspaceLabelOf(item, workspaces, t) }),
											jsx("span", { children: t("time", { time: formatTime(item.createdAt) }) }),
											jsx("span", {
												children: item.present === true
													? t("sizeLabel", { size: primitives.fileSizeText(item.bytes), files: item.files })
													: t("missing"),
											}),
											item.pendingRestart === true ? jsx("span", { className: "am_badge", children: t("pendingRestart") }) : null,
										],
									}),
									jsx("div", { className: "am_confirmPath", children: item.directory }),
								],
							}),
							item.pendingRestart === true
								? null
								: jsxs("div", {
									className: "am_rowActions",
									children: [
										jsx(primitives.Button, {
											variant: "outline",
											disabled: state.busy,
											onClick: () => { void restore([item.sessionId]); },
											children: t("restore"),
										}),
										jsx(primitives.Button, {
											variant: "ghost",
											icon: jsx(primitives.IconTrashOutlineRegular, { size: 16 }),
											disabled: state.busy,
											onClick: () => { requestDelete([item.sessionId]); },
											children: t("delete"),
										}),
									],
								}),
						],
					}, item.sessionId)),
				});

			return jsxs("div", {
				className: "am_root",
				children: [header, toolbar, banner, errorLine, body],
			});
		}
		/** Frame-wide confirmation for the pending deletion. */
		function ArchiveConfirm(props) {
			const { t, useArchives, onConfirm, onCancel } = props;
			const state = useArchives((value) => value);
			const busy = state.busy;
			const [acknowledged, setAcknowledged] = react.useState(false);
			const open = state.confirm !== null;
			react.useEffect(() => {
				if (!open) setAcknowledged(false);
			}, [open]);
			if (!open) return null;
			const rows = state.confirm.rows;
			return jsx(primitives.Modal, {
				open: true,
				onClose: onCancel,
				title: t("confirmTitle"),
				closeLabel: t("close"),
				description: t("confirmIntro", { count: rows.length }),
				footer: jsxs(react.Fragment, {
					children: [
						jsx(primitives.Button, { variant: "outline", onClick: onCancel, children: t("cancel") }),
						jsx(primitives.Button, {
							variant: "primary",
							disabled: !acknowledged || busy,
							onClick: onConfirm,
							children: t("confirmDelete"),
						}),
					],
				}),
				children: [
					jsx("div", {
						className: "am_confirmList",
						children: rows.map((row) => jsxs("div", {
							className: "am_confirmItem",
							children: [
								jsx("div", { className: "am_confirmName", children: row.title !== undefined && row.title !== "" ? row.title : row.sessionId }),
								jsx("div", { className: "am_confirmPath", children: row.directory === undefined ? row.sessionId : row.directory }),
							],
						}, row.sessionId)),
					}),
					jsx("label", {
						className: "am_ack",
						children: [
							jsx("input", {
								type: "checkbox",
								checked: acknowledged,
								onChange: (event) => { setAcknowledged(event.target.checked); },
							}),
							jsx("span", { children: t("confirmAck") }),
						],
					}),
				],
			});
		}
		/** Result toast, rendered in the frame-wide overlay. */
		function ArchiveToast(props) {
			const { t, useArchives, dismiss } = props;
			const state = useArchives((value) => value);
			if (state.notice === null) return null;
			const detail = typeof state.notice.params.detail === "string" ? ` (${state.notice.params.detail})` : "";
			return jsx(primitives.Toast, {
				text: `${t(state.notice.text, state.notice.params)}${detail}`,
				tone: state.notice.tone === "success" ? "success" : undefined,
				onDone: dismiss,
			}, state.notice.seq);
		}
		/** Session-row menu entry: permanent deletion for archived rows only. */
		function ArchiveRowDelete(props) {
			const { t, sessionId, useMenuOpenState, useWorkspaces, requestDelete } = props;
			const menu = useMenuOpenState();
			const setMenuOpen = menu[1];
			const archivedIds = useWorkspaces === undefined ? EMPTY_IDS : useWorkspaces((snapshot) => snapshot.archivedSessionIds);
			if (!archivedIds.includes(sessionId)) return null;
			return jsx(primitives.MenuItemButton, {
				danger: true,
				separatorBefore: true,
				icon: jsx(primitives.IconTrashOutlineRegular, { size: 16 }),
				children: t("menuDelete"),
				onSelect: () => {
					setMenuOpen(false);
					requestDelete([sessionId]);
				},
			});
		}
		/** Sidebar panel icon. */
		function ArchiveManagerIcon(props) {
			return jsx(primitives.IconArchiveOutlineRegular, { size: props.size });
		}
		//#endregion

		//#region plugin
		const PANEL_ID = "archive-manager";
		const inject = ["slots", "locale", "sessions", "workspaces", "uiWorkspace"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "archive-manager: dictionaries");
			const t = ctx.locale.bind(NS);
			const model = new ArchiveModel(ctx);

			void model.load();
			let lastArchived = JSON.stringify(ctx.workspaces.list.getSnapshot().archivedSessionIds);
			ctx.effect(() => ctx.workspaces.list.subscribe(() => {
				const next = JSON.stringify(ctx.workspaces.list.getSnapshot().archivedSessionIds);
				if (next === lastArchived) return;
				lastArchived = next;
				void model.load();
			}), "archive-manager: follow the archive set");

			const face = () => ({
				// `hooks` sources are projected as `use<Name>` selector hooks; the
				// workspace/session sources are namespaced so they never shadow the
				// slot owner's own standard `useWorkspaces`/`useSessions` props.
				hooks: {
					archives: model,
					archiveWorkspaces: ctx.workspaces.list,
					archiveSessions: ctx.sessions.list,
				},
				reload: () => { void model.load(); },
				requestDelete: (sessionIds) => { model.requestDelete(sessionIds); },
				restore: (sessionIds) => model.restore(sessionIds),
			});

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: face,
			}, ArchiveManagerPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 30,
				locale: NS,
				label: () => t("panel"),
			}, ArchiveManagerIcon));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "archive-manager-confirm",
				locale: NS,
				inject: () => ({
					hooks: { archives: model },
					onConfirm: () => model.confirmDelete(),
					onCancel: () => { model.cancelDelete(); },
				}),
			}, ArchiveConfirm));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "archive-manager-toast",
				locale: NS,
				inject: () => ({
					hooks: { archives: model },
					dismiss: () => { model.dismissNotice(); },
				}),
			}, ArchiveToast));			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "archive-manager.delete",
				order: 900,
				locale: NS,
				inject: () => ({
					requestDelete: (sessionIds) => { model.requestDelete(sessionIds); },
				}),
			}, ArchiveRowDelete));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
