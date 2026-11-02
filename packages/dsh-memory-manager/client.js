/**
 * Client half of dsh-memory-manager: the Memory panel.
 *
 * sidebar.panellist icon (id: memory-panel) -> main panel keyed 'memory-panel'.
 * Data comes from the Host route /api/memory-org/* (read-only; the memory root
 * is resolved server-side).
 *
 * Information architecture (built for long-lived memory, not a file browser):
 *   rail   = 总览 / 功能 / 思想 / 每日 / 索引, each with a live count
 *   总览   = health + "最近改动" timeline across every zone + zone counts
 *   分区   = rows with a one-line index summary, relative time and size,
 *            sortable (时间/名称) and filterable — the list stays readable as
 *            the memory grows
 *   阅读   = section cards (iteration blocks / principle sections / day
 *            threads / index tables), newest block expanded first, with a
 *            jump strip and expand-all; internal .md links navigate in-panel
 *
 * Visual language deliberately mirrors the host primitives (Button / Tag /
 * Input / SidebarRoot panelRow): --dsw-alias-* colors, --dsw-radius-* scale,
 * .5px border hairlines, interactive-bg hover, the 2px focus ring, 28/32px
 * control heights. Styles ship as one <style> element inside the panel root
 * (component-local, removed on unmount) so :hover/:focus-visible behave like
 * the host's CSS modules.
 */
window.__ModuleLoader__.load({
	id: 'dsh-memory-manager',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useRef } = React;

		const API = '/api/memory-org';
		const enc = encodeURIComponent;

		const NAV = [
			{ key: 'overview', label: '总览', icon: '⌂' },
			{ key: 'index', label: '索引', icon: '☰' },
			{ key: 'functions', label: '功能', icon: '⬡' },
			{ key: 'insights', label: '思想', icon: '✦' },
			// 道层（dao/）——最抽象的一层。此前它没有导航项，所以即使文件存在，
			// 面板里也点不到：能写不能看，等于半个功能。
			{ key: 'dao', label: '道', icon: '☯' },
			{ key: 'capabilities', label: '能力', icon: '⚒' },
			{ key: 'skills', label: '技能', icon: '⌘' },
			{ key: 'daily', label: '每日', icon: '◷' },
			{ key: 'inbox', label: '收件箱', icon: '✉' },
		];
		const ZONE_LABEL = { functions: '功能', insights: '思想', dao: '道', capabilities: '能力', skills: '技能', daily: '每日', '': '索引' };
		const ZONE_DIR = { functions: 'functions', insights: 'insights', dao: 'dao', capabilities: 'capabilities', skills: 'skills', daily: '' };

		const css = `
/* Host-aligned visuals: metrics and tokens are copied from the shipped primitives
   so the panel reads as a native surface beside host pages — base type 14/22,
   Button md 36px / sm 28px, Input 32px + border-l4 + bg-layer-1 with a
   state-business focus border, Tag 11/17 with color-mix tones, markdown links on
   --dsw-alias-link, code on --ds-font-family-code, and the host's
   --dsw-focus-ring-* pair. Lists use the host's hairline rows, not border boxes. */
.dmo-root{height:100%;display:flex;flex-direction:column;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dmo-header{display:flex;align-items:center;gap:10px;padding:14px 20px 10px}
.dmo-title{font-size:16px;line-height:24px;font-weight:600;margin:0}
.dmo-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dmo-search{display:inline-flex;align-items:center;gap:6px;height:32px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);min-width:200px}
.dmo-search:focus-within{border-color:var(--dsw-alias-state-business-primary)}
.dmo-search input{flex:1;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;min-width:0}
.dmo-search input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dmo-kbd{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:0 4px}
.dmo-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px;height:36px;transition:background .15s ease}
.dmo-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-btn:active{background:var(--dsw-alias-interactive-bg-active)}
.dmo-btn.outline{border:.5px solid var(--dsw-alias-border-l3)}
	.dmo-btn.danger{border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
	.dmo-btn.danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dmo-btn.sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm)}
.dmo-btn.link{padding:0 2px;height:auto;color:var(--dsw-alias-link);font-weight:500;text-decoration:none}
.dmo-btn.link:hover{background:transparent;text-decoration:underline dotted var(--dsw-alias-link);text-underline-offset:3px}
.dmo-btn:disabled{opacity:.4;cursor:not-allowed}
.dmo-btn:focus-visible,.dmo-row:focus-visible,.dmo-tl-row:focus-visible,.dmo-gcard:focus-visible,.dmo-nav:focus-visible,.dmo-sec-head:focus-visible,.dmo-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dmo-body{flex:1;display:flex;min-height:0;padding:0 20px 16px;gap:16px}
.dmo-rail{width:184px;flex-shrink:0;display:flex;flex-direction:column;gap:1px;overflow-y:auto;border-right:.5px solid var(--dsw-alias-border-l2);padding-right:8px}
.dmo-nav{display:flex;align-items:center;gap:8px;width:100%;padding:0 8px;height:32px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:14px;text-align:left}
.dmo-nav:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-nav.active{background:var(--dsw-alias-interactive-bg-active);font-weight:600}
.dmo-nav .ico{width:16px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dmo-nav .cnt{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dmo-main{flex:1;min-width:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
.dmo-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.dmo-card.tight{padding:8px 10px}
.dmo-h2{font-size:14px;line-height:22px;font-weight:600;margin:0 0 8px}
.dmo-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dmo-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:17px;font-weight:500;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);background:transparent;cursor:default}
.dmo-chip.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);border-color:transparent;color:var(--dsw-alias-state-success-primary)}
.dmo-chip.warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-color:transparent;color:var(--dsw-alias-state-warn-primary)}
.dmo-chip.fail{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:transparent;color:var(--dsw-alias-state-error-primary)}
.dmo-chip.btn{cursor:pointer}
.dmo-chip.btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-chip.active{background:var(--dsw-alias-interactive-bg-active);border-color:transparent;color:var(--dsw-alias-label-primary);font-weight:600}
.dmo-mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);color:inherit;border-radius:3px;padding:0 2px}
.dmo-resolve{display:inline-flex;align-items:center;padding:0 8px;border-radius:999px;font-size:11px;line-height:18px;font-weight:500;white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);vertical-align:1px}
.dmo-tl{display:flex;flex-direction:column}
.dmo-tl-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}
.dmo-tl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-tl-when{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);width:76px;flex-shrink:0;font-variant-numeric:tabular-nums}
.dmo-tl-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;flex-shrink:0}
.dmo-tl-sum{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmo-zone-tag{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:0 4px;flex-shrink:0}
.dmo-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmo-toolbar .grow{flex:1;min-width:120px}
.dmo-filter{height:32px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;width:100%}
.dmo-filter::placeholder{color:var(--dsw-alias-label-dimmed)}
.dmo-filter:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dmo-rows{display:flex;flex-direction:column}
.dmo-group{display:flex;flex-direction:column}
.dmo-month{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em;margin:8px 0 2px}
.dmo-row{display:block;width:100%;text-align:left;padding:10px 8px;border:none;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;cursor:pointer;font:inherit}
.dmo-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-row-top{display:flex;align-items:baseline;gap:8px}
.dmo-row-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:14px;line-height:22px}
.dmo-row-meta{margin-left:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);flex-shrink:0;font-variant-numeric:tabular-nums}
.dmo-row-sum{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* skill library rows: the row is a container (flex), the open button takes the
   remaining width, the lifecycle controls sit at the right edge. */
.dmo-row-btn{display:block;flex:1;min-width:0;text-align:left;padding:10px 8px;border:none;background:transparent;color:inherit;cursor:pointer;font:inherit}
.dmo-row-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-row-actions{display:flex;align-items:center;gap:8px;padding:0 10px;flex-shrink:0}
.dmo-switch{position:relative;width:34px;height:20px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s ease;padding:0}
.dmo-switch.on{background:var(--dsw-alias-state-success-primary);border-color:transparent}
.dmo-switch-dot{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s ease}
.dmo-switch.on .dmo-switch-dot{transform:translateX(14px)}
.dmo-row-del{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:20px;cursor:pointer;padding:2px 6px;border-radius:var(--dsw-radius-sm)}
.dmo-row-del:hover{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dmo-crumbs{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px}
.dmo-crumb-sep{color:var(--dsw-alias-label-tertiary)}
.dmo-doc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dmo-doc-title{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:14px;font-weight:600}
.dmo-toc{display:flex;flex-wrap:wrap;gap:4px}
.dmo-toc-chips{display:flex;flex-wrap:wrap;gap:4px}
.dmo-sec{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dmo-sec-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:none;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;text-align:left}
.dmo-sec-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-sec-head .caret{color:var(--dsw-alias-label-tertiary);width:10px;flex-shrink:0;font-size:10px}
.dmo-sec-date{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;flex-shrink:0}
.dmo-sec-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmo-sec-body{padding:4px 12px 10px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dmo-md{margin:6px 0;line-height:22px;font-size:14px;color:var(--dsw-alias-label-primary);word-break:break-word}
.dmo-md p{margin:6px 0}
.dmo-md ul{margin:6px 0;padding-left:20px}
.dmo-md li{margin:2px 0}
.dmo-md h3,.dmo-md h4,.dmo-md h5{margin:10px 0 4px;font-size:14px;font-weight:600}
.dmo-md blockquote{margin:6px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dmo-md pre{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px;overflow-x:auto;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px}
.dmo-md code{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);padding:0 3px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px}
/* fenced code block: outer frame carries the language badge + copy button, the
   pre itself keeps its own scroll so a long line never stretches the panel. */
.dmo-code{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);overflow:hidden;margin:8px 0;background:var(--dsw-alias-bg-layer-2)}
.dmo-code-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dmo-code-lang{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,monospace);text-transform:lowercase}
.dmo-code-copy{margin-left:auto;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;padding:2px 6px;border-radius:var(--dsw-radius-sm)}
.dmo-code-copy:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dmo-code .dmo-pre{margin:0;border:none;border-radius:0;background:transparent}
/* Syntax token colors: every one rides a Host semantic variable so the panel
   follows the active theme; the fallbacks only exist for a stripped build. */
.dmo-t-kw{color:var(--dsw-alias-state-business-primary,#7ab0ff);font-weight:500}
.dmo-t-str{color:var(--dsw-alias-state-success-primary,#6fce89)}
.dmo-t-com{color:var(--dsw-alias-label-tertiary,#8a8a8a);font-style:italic}
.dmo-t-num{color:var(--dsw-alias-state-warn-primary,#e3b341)}
.dmo-t-fn{color:var(--dsw-alias-brand-text,#c792ea)}
.dmo-t-diff-add{display:block;background:color-mix(in srgb,var(--dsw-alias-code-diff-added,#2ea043) 14%,transparent);color:var(--dsw-alias-code-diff-added,#3fb950)}
.dmo-t-diff-del{display:block;background:color-mix(in srgb,var(--dsw-alias-code-diff-deleted,#f85149) 14%,transparent);color:var(--dsw-alias-code-diff-deleted,#f85149)}
.dmo-t-diff-meta{display:block;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dmo-md blockquote{margin:6px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dmo-md hr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:10px 0}
.dmo-link{color:var(--dsw-alias-link);cursor:pointer;text-decoration:none;border:none;background:transparent;font:inherit;padding:0;font-weight:500}
.dmo-link:hover{text-decoration:underline dotted var(--dsw-alias-link);text-underline-offset:3px}
/* tables: zebra rows + horizontal scroll in their own box (wide comparison
   tables scroll instead of stretching the whole panel). */
.dmo-table-wrap{overflow-x:auto;margin:8px 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dmo-table{width:100%;border-collapse:collapse;font-size:14px;margin:0}
.dmo-table th,.dmo-table td{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:6px 8px;text-align:left;vertical-align:top}
.dmo-table th{font-weight:600;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap;background:var(--dsw-alias-bg-layer-1)}
.dmo-table tbody tr:last-child td{border-bottom:none}
.dmo-table tbody tr.odd{background:var(--dsw-alias-bg-layer-1)}
.dmo-idx-row{cursor:pointer}
.dmo-idx-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-idx-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap}
.dmo-snippet{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dmo-empty{color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;padding:18px 2px}
.dmo-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dmo-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dmo-probs{margin:6px 0 0;padding-left:20px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dmo-prose{margin:0;padding-left:20px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dmo-prose li{margin:2px 0}
.dmo-prose li::marker{color:var(--dsw-alias-label-tertiary)}
.dmo-growth{display:flex;gap:8px;flex-wrap:wrap}
.dmo-gcard{flex:1 1 120px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:8px 10px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);text-align:left;color:inherit;font:inherit}
.dmo-gcard:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dmo-gnum{font-size:20px;line-height:28px;font-weight:600}
/* environment block (5.26.0 overview): key/value rows + the index fill meter. */
.dmo-env-rows{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}
.dmo-env-row{display:flex;gap:8px;align-items:center}
.dmo-env-k{width:56px;flex-shrink:0;color:var(--dsw-alias-label-tertiary)}
.dmo-env-v{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dmo-meter{position:relative;display:inline-block;width:80px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);vertical-align:middle;overflow:hidden}
.dmo-meter-fill{position:absolute;inset:0 auto 0 0;background:var(--dsw-alias-state-success-primary)}
.dmo-meter-fill.over{background:var(--dsw-alias-state-warning-primary)}
@media (max-width:720px){.dmo-body{flex-direction:column;padding:0 12px 12px}.dmo-rail{width:auto;flex-direction:row;overflow-x:auto;border-right:none;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:0 0 6px}}
`;

		// ---------------------------------------------------------------------
		// pure helpers
		// ---------------------------------------------------------------------

		/** "3 小时前" style relative time; falls back to the date for old items. */
		function relTime(iso) {
			const t = Date.parse(iso ?? '');
			if (!Number.isFinite(t)) return '';
			const diff = Date.now() - t;
			if (diff < 60_000) return '刚刚';
			if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
			if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
			if (diff < 2 * 86_400_000) return `昨天 ${new Date(t).toTimeString().slice(0, 5)}`;
			if (diff < 8 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
			return new Date(t).toISOString().slice(0, 10);
		}

		function fmtBytes(n) {
			if (!Number.isFinite(n)) return '';
			return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
		}

		/** Strip inline markdown for one-line summaries. */
		function plain(s) {
			return String(s ?? '')
				.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
				.replace(/[*`]/g, '')
				.replace(/\s+/g, ' ')
				.trim();
		}

		/**
		 * Read the navigation tables out of MEMORY.md: slug -> one-line summary.
		 * This is what makes a zone list readable without opening every file, and
		 * it works from the index the panel already fetches. Tables: functions /
		 * insights / capabilities / skills.
		 */
		function parseIndexTables(text) {
			const out = { functions: {}, insights: {}, dao: {}, capabilities: {}, skills: {} };
			let zone = null;
			// 小节 → 分区，用**有序的精确前缀**判定，不用 `includes`。
			// 起因：`## 道层（最抽象的指导思想）` 里含「思想」二字，被 `includes('思想')`
			// 先命中，于是整节被当成 insights 解析——道层永远解析不出行，且失败得
			// 无声无息（没有报错，只是空）。关键字子串判定在标题互相包含时必然出错。
			const HEADING_ZONE = [
				['功能模块', 'functions'],
				['道层', 'dao'],
				['创新优化思想', 'insights'],
				['技能台账', 'skills'],
				['能力台账', 'capabilities'],
			];
			for (const raw of String(text ?? '').split('\n')) {
				const line = raw.trim();
				if (line.startsWith('## ')) {
					const hit = HEADING_ZONE.find(([kw]) => line.includes(kw));
					zone = hit ? hit[1] : null;
					continue;
				}
				// dao rows are bullets, not table rows — and BOTH spellings occur in
				// real roots: `- **[名](dao/名.md)** — 命题` (the older index generation)
				// and `- **名** — 命题（[正文](dao/名.md)）` (memory_dao-era guidance).
				// Key by whatever `dao/<slug>.md` links exist on the line, so the
				// lookup slug always matches the zone list's file name; the old
				// bold-text-first pattern keyed link-form rows under the RAW markdown
				// text — present but never found, an empty zone list again.
				if (zone === 'dao') {
					if (!line.startsWith('-')) continue;
					const links = [...line.matchAll(/\[[^\]]+\]\((dao\/[^)\s]+\.md)\)/g)];
					const summary = plain(line.replace(/^-\s*/, ''));
					if (links.length) {
						// Key by the FILE name in the href — that is what the zone list
						// reports and what summaryOf() looks up by.
						for (const [, href] of links) {
							const slug = href.split('/').pop().replace(/\.md$/, '');
							out.dao[slug] = { summary, href };
						}
					} else {
						const bold = /^-\s*\*\*([^*]+)\*\*/.exec(line);
						if (bold) out.dao[bold[1].trim()] = { summary, href: `dao/${bold[1].trim()}.md` };
					}
					continue;
				}
				if (!zone || !line.startsWith('|')) continue;
				const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
				// 2 as the floor (name + summary): the index tables lost their link
				// column in 5.15.0, so a 3-cell floor silently drops every row.
				if (cells.length < 2) continue;
				if (cells.every((c) => /^[-: ]*$/.test(c))) continue;
				const slug = plain(cells[0]);
				if (!slug || /^(功能域|思想主题|主题|功能域摘要|能力|技能)/.test(slug)) continue;
				// Column-agnostic, like the server: the pre-5.15.0 rows kept the link
				// in cell 3, the current one bakes it into cell 1.
				const href = cells.map((c) => /\]\(([^)\s]+\.md)\)/.exec(c)?.[1]).find(Boolean) ?? '';
				out[zone][slug] = { summary: plain(cells.slice(1).join(' ')), href };
			}
			return out;
		}

		/**
		 * Read the two prose sections of MEMORY.md that the index tables skip:
		 * the cross-feature consensus block and the environment-constant block.
		 *
		 * Both live outside the four navigation tables, so they used to be
		 * reachable only by scrolling the raw index page. The overview surfaces
		 * them because they are the memory a future session most needs at a
		 * glance ("what did we agree" + "which machine path is real").
		 *
		 * @param text - MEMORY.md content.
		 * @returns `{ consensus: string[], env: string[] }` — bullet lines each.
		 */
		function parseProseSections(text) {
			const out = { consensus: [], env: [] };
			let zone = null;
			for (const raw of String(text ?? '').split('\n')) {
				const line = raw.trim();
				if (/^##\s/.test(raw)) {
					zone = /共识|规范/.test(line) ? 'consensus' : /环境常量/.test(line) ? 'env' : null;
					continue;
				}
				if (!zone || !line.startsWith('-') || line === '-') continue;
				const body = plain(line.replace(/^-\s*/, ''));
				if (body) out[zone].push(body);
			}
			return out;
		}

		/** Split a memory file into its head summary + `## ` sections. */
		function splitSections(text) {
			const preamble = [];
			const sections = [];
			let cur = null;
			for (const line of String(text ?? '').split('\n')) {
				if (/^##\s/.test(line)) {
					if (cur) sections.push(cur);
					cur = { heading: line.replace(/^##\s*/, '').trim(), lines: [] };
				} else if (cur) cur.lines.push(line);
				else preamble.push(line);
			}
			if (cur) sections.push(cur);
			return {
				preamble: preamble.join('\n').trim(),
				sections: sections.map((s) => ({
					heading: s.heading,
					body: s.lines.join('\n').trim(),
					date: (s.heading.match(/\[(\d{4}-\d{2}-\d{2})/) ?? [])[1] ?? null,
				})),
			};
		}

		/** Which memory file (if any) an internal markdown href points at. */
		function resolveHref(href, zone) {
			const clean = String(href ?? '').split('#')[0].trim();
			if (!clean || /^(https?:|mailto:|#)/.test(clean)) return null;
			// 5.24.0: a skill index row links to its HOST bundle via file:///. The
			// skill's identity is the bundle DIRECTORY name (SKILL.md is the leaf),
			// and clicking it opens the bundle view — not the memory reader.
			if (/^file:\/\//i.test(clean)) {
				const segs = clean.replace(/\\/g, '/').split('/').filter(Boolean);
				const leaf = segs[segs.length - 1] ?? '';
				if (leaf !== 'SKILL.md') return null;
				return { zone: 'bundle', name: segs[segs.length - 2] ?? '' };
			}
			const p = clean.replace(/^(\.\.\/)+/, '').replace(/^\.\//, '');
			if (p.startsWith('functions/')) return { zone: 'functions', name: p.slice(10) };
			if (p.startsWith('insights/')) return { zone: 'insights', name: p.slice(9) };
			if (p.startsWith('dao/')) return { zone: 'dao', name: p.slice(4) };
			if (/^\d{4}-\d{2}-\d{2}\.md$/.test(p)) return { zone: 'daily', name: p };
			if (p === 'MEMORY.md') return { zone: '', name: null };
			if (/^[^/]+\.md$/.test(p) && zone !== undefined) return { zone, name: p };
			return null;
		}

		/** Per-kind first-open policy: never dump 20KB of history on the reader. */
		/** Index sections that start expanded: the tables, and the dao list. */
		const INDEX_OPEN_RE = /^(功能模块索引|创新优化思想索引|道层|能力台账|技能台账)/;
		function defaultOpen(kind, sections, text) {
			const open = {};
			const small = String(text ?? '').length < 4000;
			sections.forEach((s, i) => {
				if (kind === 'functions') open[i] = small || i === 0; // reversed: index 0 is the newest
				// 精确前缀而非关键字子串：道层标题含「思想」二字，子串匹配会把
				// 「道层（最抽象的指导思想）」当成思想索引。
				else if (kind === 'index') open[i] = INDEX_OPEN_RE.test(s.heading);
				else open[i] = true;
			});
			return open;
		}

		// ---------------------------------------------------------------------
		// data
		// ---------------------------------------------------------------------

		/**
		 * GET a JSON endpoint with abort-on-unmount. `fixtures` is a test seam:
		 * when it carries the URL the value is returned synchronously (the UI
		 * test renders every view without a server).
		 */
		function useApi(url, fixtures) {
			const [state, setState] = useState({ data: null, loading: Boolean(url), error: null });
			useEffect(() => {
				if (!url) {
					setState({ data: null, loading: false, error: null });
					return undefined;
				}
				const ac = new AbortController();
				setState((s) => ({ ...s, loading: true }));
				fetch(url, { signal: ac.signal })
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
					.then((d) => setState({ data: d, loading: false, error: null }))
					.catch((e) => {
						if (e?.name === 'AbortError') return;
						setState({ data: null, loading: false, error: String(e?.message ?? e) });
					});
				return () => ac.abort();
			}, [url]);
			if (fixtures && url && Object.prototype.hasOwnProperty.call(fixtures, url)) return fixtures[url];
			return state;
		}

		// ---------------------------------------------------------------------
		// primitives
		// ---------------------------------------------------------------------

		function Btn({ children, onClick, tone, sm, title, disabled, 'data-dmo': mark }) {
			return h(
				'button',
				{
					type: 'button',
					className: `dmo-btn${tone ? ` ${tone}` : ''}${sm ? ' sm' : ''}`,
					onClick,
					title,
					disabled,
					// 面板的测试钩子一律走 data-dmo（ui-test 的序列化器只输出它）。
					// 透传出来，破坏性按钮之类才有稳定的断言锚点。
					...(mark === undefined ? {} : { 'data-dmo': mark }),
				},
				children,
			);
		}

		function Chip({ children, tone, onClick, title }) {
			const cls = `dmo-chip${tone ? ` ${tone}` : ''}${onClick ? ' btn' : ''}`;
			return onClick
				? h('button', { type: 'button', className: cls, onClick, title, 'data-dmo': 'chip' }, children)
				: h('span', { className: cls, title, 'data-dmo': 'chip' }, children);
		}

		function Card({ children, tight, className }) {
			return h('div', { className: `dmo-card${tight ? ' tight' : ''}${className ? ` ${className}` : ''}` }, children);
		}

		function CardTitle({ children, right }) {
			return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('h3', { className: 'dmo-h2', style: { margin: 0 } }, children), right ? h('span', { style: { marginLeft: 'auto' } }, right) : null);
		}

		// ---------------------------------------------------------------------
		// markdown rendering (links navigate inside the panel)
		// ---------------------------------------------------------------------

		function inline(text, keyBase, zone, onNavigate) {
			const src = String(text ?? '');
			const out = [];
			// One pointer per row: the same target rendered twice in a single line
			// (raise-site link + ✅ resolution pointer) reads as a stutter — repeats
			// collapse to plain text. The ✅ marker itself is collapsed into a chip
			// tag (see the fourth token branch).
			const seenTargets = new Set();
			// Hrefs may contain spaces: safeSlug only forbids path separators, so
			// themes like 「可观测性先于修 bug」 are legal filenames. An [^)\s]-style
			// pattern silently degrades those links to raw text (path shown twice —
			// reads as a duplicate row) instead of rendering them.
			const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]*\]\([^)\n]+\)|（✅[^）]*）)/g;
			let last = 0;
			let m;
			let n = 0;
			while ((m = re.exec(src))) {
				if (m.index > last) out.push(src.slice(last, m.index));
				const tok = m[1];
				const key = `${keyBase}-${n++}`;
				if (tok.startsWith('**')) out.push(h('strong', { key }, tok.slice(2, -2)));
				else if (tok.startsWith('`')) out.push(h('code', { key }, tok.slice(1, -1)));
				else if (tok.startsWith('（✅')) {
					// Resolution stamp → a compact, non-repeating chip. Any link inside
					// stays reachable as the chip's click target instead of a second
					// inline pointer.
					const linkM = /\[([^\]]*)\]\(([^)]+)\)/.exec(tok);
					const label = tok
						.replace(/^[（(]/, '')
						.replace(/[）)]$/, '')
						.replace(/\s*→\s*\[[^\]]*\]\([^)]*\)/, '')
						.trim();
					const target = linkM ? resolveHref(linkM[2], zone) : null;
					const jump = target && onNavigate ? () => onNavigate(target) : undefined;
					out.push(h('span', { key, className: 'dmo-resolve', onClick: jump, title: jump ? `打开 ${target.name}` : undefined }, label));
				} else {
					const mm = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
					const label = mm[1] || mm[2];
					const target = resolveHref(mm[2], zone);
					if (target && seenTargets.has(target.zone + ':' + target.name)) {
						out.push(label);
					} else if (target) {
						seenTargets.add(target.zone + ':' + target.name);
						out.push(
							h(
								'button',
								{
									key, type: 'button', className: 'dmo-link', title: mm[2],
									onClick: () => onNavigate(target),
								},
								label,
							),
						);
					} else if (/^https?:/.test(mm[2])) {
						out.push(h('a', { key, className: 'dmo-link', href: mm[2], target: '_blank', rel: 'noreferrer' }, label));
					} else out.push(label);
				}
				last = m.index + tok.length;
			}
			if (last < src.length) out.push(src.slice(last));
			return out.filter((x) => x !== '');
		}

		// --- code-block syntax coloring -----------------------------------------
		// The panel stores procedures, commands and patches, and the Host's own
		// markdown renderer ships no highlighter either, so a fenced block used to
		// be one flat grey blob. This is a deliberately small tokenizer: comments,
		// strings, numbers, keywords, and unified-diff lines — enough that the eye
		// separates structure from payload at a glance. Colors ride the Host's
		// semantic theme variables, so dark and light themes both stay legible and
		// nothing here invents a palette. Unknown languages render untouched.

		const LANG_KEYWORDS = {
			js: 'const let var function return if else for while do switch case break continue new class extends super this typeof instanceof in of delete void yield await async try catch finally throw import export from default null undefined true false',
			ts: 'const let var function return if else for while do switch case break continue new class extends implements interface type enum namespace declare as readonly public private protected static abstract async try catch finally throw import export from default null undefined true false void never unknown any string number boolean',
			py: 'def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield pass break continue global nonlocal assert async await del print',
			sh: 'if then else elif fi for while do done case esac function return export local set shift source echo exit read until select time',
			bash: 'if then else elif fi for while do done case esac function return export local set shift source echo exit read until select time',
			ps: 'if else elseif foreach for while switch do return function param begin end process filter where',
			powershell: 'if else elseif foreach for while switch do return function param begin end process filter where',
			sql: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE DROP ALTER TABLE INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL DISTINCT UNION CASE WHEN THEN ELSE END',
			go: 'func package import var const type struct interface map chan go defer return if else for range switch case default break continue go nil true false string int int64 float64 bool byte rune error',
			rust: 'fn let mut const struct enum impl trait use pub mod match if else for while loop return break continue self super crate where move async await dyn ref true false Some None Ok Err String str i32 u32 usize bool char',
			java: 'public private protected class interface extends implements static final void int long double float boolean char new return if else for while switch case default try catch finally throw throws import package this super null true false',
			c: 'int char float double long short unsigned signed struct union enum typedef static const extern void return if else for while do switch case break continue goto sizeof NULL',
			cpp: 'int char float double long short unsigned signed struct union enum class template typename namespace using public private protected static const constexpr virtual override inline void return if else for while do switch case break continue new delete nullptr true false auto',
			csharp: 'using namespace class struct interface enum public private protected internal static virtual override abstract sealed async await var new return if else for foreach while switch case default try catch finally throw null true false void int string bool object list',
			yaml: 'true false null yes no on off',
			json: 'true false null',
			toml: 'true false',
		};
		const LANG_ALIASES = {
			javascript: 'js', typescript: 'ts', tsx: 'ts', jsx: 'js', node: 'js',
			python: 'py', shell: 'sh', zsh: 'sh', console: 'sh', cmd: 'sh', pwsh: 'powershell', ps1: 'powershell',
			golang: 'go', rs: 'rust', cs: 'csharp', h: 'c', cc: 'cpp', cxx: 'cpp', md: '', markdown: '',
		};

		/**
		 * Split one fenced code block into [class, text] tokens.
		 *
		 * Single-quoted strings stop at the line end unless closed: the common
		 * failure of a stray quote swallowing the rest of a block is worse than a
		 * missing color, so an unterminated string stays plain text.
		 *
		 * @param text - the block body (already fence-stripped).
		 * @param lang - the fence language tag (may be '' or unknown).
		 * @returns tokens with class in {kw,str,com,num,fn,diff-add,diff-del,diff-meta,''}.
		 */
		function tokenizeCode(text, lang) {
			const source = String(text ?? '');
			const base = (LANG_ALIASES[lang] ?? lang ?? '').toLowerCase();
			if (!source.trim()) return [['', source]];
			const tokens = [];
			const push = (cls, value) => {
				if (value === '') return;
				if (cls === '' && tokens.length && tokens[tokens.length - 1][0] === '') {
					tokens[tokens.length - 1][1] += value;
					return;
				}
				tokens.push([cls, value]);
			};

			// Unified diff: line-level coloring, no further tokenizing. Auto-
			// detection is limited to plain/unknown fences — YAML opens a document
			// with `---`, so treating every leading dash as a deletion would
			// mis-color whole config blocks.
			const looksDiffLang = base === '' || base === 'text' || base === 'diff' || base === 'patch';
			if (base === 'diff' || base === 'patch' || (looksDiffLang && /^(diff --git|@@ -\d|\+\+\+ |--- )/m.test(source))) {
				for (const line of source.split('\n')) {
					if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) push('diff-meta', `${line}\n`);
					else if (line.startsWith('@@')) push('diff-meta', `${line}\n`);
					else if (line.startsWith('+')) push('diff-add', `${line}\n`);
					else if (line.startsWith('-')) push('diff-del', `${line}\n`);
					else push('', `${line}\n`);
				}
				const trimmed = tokens[tokens.length - 1];
				if (trimmed && trimmed[1].endsWith('\n')) trimmed[1] = trimmed[1].slice(0, -1);
				return tokens;
			}

			const keywords = new Set((LANG_KEYWORDS[base] ?? '').split(/\s+/).filter(Boolean));
			const hashComment = base === 'py' || base === 'sh' || base === 'yaml' || base === 'toml' || base === 'powershell';
			const slashComment = base !== '' && base !== 'yaml' && base !== 'toml' && base !== 'sql' && base !== 'powershell' && base !== 'md';
			const lineComment = (
				rest,
			) => {
				const end = rest.indexOf('\n');
				return end === -1 ? rest.length : end;
			};
			let i = 0;
			while (i < source.length) {
				const rest = source.slice(i);
				const two = rest.slice(0, 2);
				// Block comment.
				if (two === '/*') {
					const end = source.indexOf('*/', i + 2);
					const stop = end === -1 ? source.length : end + 2;
					push('com', source.slice(i, stop));
					i = stop;
					continue;
				}
				if (hashComment && rest[0] === '#') {
					const stop = i + lineComment(source.slice(i));
					push('com', source.slice(i, stop));
					i = stop;
					continue;
				}
				if (slashComment && two === '//') {
					const stop = i + lineComment(source.slice(i));
					push('com', source.slice(i, stop));
					i = stop;
					continue;
				}
				if (base === 'sql' && two === '--') {
					const stop = i + lineComment(source.slice(i));
					push('com', source.slice(i, stop));
					i = stop;
					continue;
				}
				// String (single line, escape-aware, unterminated stays plain).
				const quote = rest[0];
				if (quote === '"' || quote === "'" || quote === '`') {
					let j = i + 1;
					let closed = false;
					while (j < source.length) {
						const ch = source[j];
						if (ch === '\\') {
							j += 2;
							continue;
						}
						if (ch === '\n' && quote !== '`') break;
						if (ch === quote) {
							closed = true;
							j += 1;
							break;
						}
						j += 1;
					}
					if (closed) {
						push('str', source.slice(i, j));
						i = j;
						continue;
					}
					push('', quote);
					i += 1;
					continue;
				}
				// Number: only at a non-word boundary (an identifier like `u32` is
				// consumed whole by the word branch below, so no tail can leak here).
				const num = /^[+-]?\d[\w.]*/.exec(rest);
				if (num && !/[\w]/.test(source[i - 1] ?? '')) {
					push('num', num[0]);
					i += num[0].length;
					continue;
				}
				// Word: keyword / identifier.
				const word = /^[A-Za-z_$][\w$]*/.exec(rest);
				if (word) {
					const value = word[0];
					if (keywords.has(value) || (base === 'sql' && keywords.has(value.toUpperCase()))) push('kw', value);
					else if (/^\s*\(/.test(rest.slice(value.length)) && !keywords.has(value)) push('fn', value);
					else push('', value);
					i += value.length;
					continue;
				}
				push('', rest[0]);
				i += 1;
			}
			return tokens;
		}

		function MarkdownBody({ text, zone, onNavigate }) {
			const lines = String(text ?? '').split('\n');
			const blocks = [];
			let i = 0;
			let k = 0;
			while (i < lines.length) {
				const line = lines[i];
				if (line.trim() === '') {
					i++;
					continue;
				}
				if (/^```/.test(line.trim())) {
					// Language tag rides the fence (```js → badge "js"), and a copy
					// button turns a stored script into something usable without
					// selecting 40 lines by hand — the panel is read-only, so copying
					// is the one action a reader legitimately wants.
					const lang = line.trim().slice(3).trim();
					const buf = [];
					i++;
					while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
					i++;
					const body = buf.join('\n');
					// A known language gets token spans; an unknown one renders the
					// body as-is (a wrong color is worse than no color).
					const tokens = tokenizeCode(body, lang);
					const tokenized = tokens.length > 0 && tokens.some(([cls]) => cls !== '');
					blocks.push(
						h(
							'div',
							{ key: `b${k++}`, className: 'dmo-code' },
							h(
								'div',
								{ className: 'dmo-code-bar' },
								h('span', { className: 'dmo-code-lang' }, lang || 'text'),
								h(
									'button',
									{
										type: 'button', className: 'dmo-code-copy', title: '复制代码', 'data-dmo': 'code-copy',
										onClick: (e) => {
											const done = () => { e.target.textContent = '已复制'; setTimeout(() => { e.target.textContent = '复制'; }, 1200); };
											if (navigator.clipboard?.writeText) navigator.clipboard.writeText(body).then(done, done);
											else done();
										},
									},
									'复制',
								),
							),
							tokenized
								? h(
										'pre',
										{ className: 'dmo-pre dmo-hl' },
										tokens.map(([cls, value], n) => (cls ? h('span', { key: `t${n}`, className: `dmo-t-${cls}` }, value) : value)),
									)
								: h('pre', { className: 'dmo-pre' }, body),
						),
					);
					continue;
				}
				if (/^\|/.test(line.trim())) {
					const rows = [];
					while (i < lines.length && /^\|/.test(lines[i].trim())) rows.push(lines[i++].trim());
					const parsed = rows
						.map((r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
						.filter((cells) => !cells.every((c) => /^[-: ]*$/.test(c)));
					const head = parsed.shift();
					blocks.push(
						h(
							'div',
							{ key: `b${k++}`, className: 'dmo-table-wrap' },
							h(
								'table',
								{ className: 'dmo-table' },
								[
									head ? h('thead', { key: 'th' }, h('tr', null, head.map((c, x) => h('th', { key: x }, inline(c, `h${x}`, zone, onNavigate))))) : null,
									h(
										'tbody',
										{ key: 'tb' },
										parsed.map((cells, y) => h('tr', { key: y, className: y % 2 ? 'odd' : undefined }, cells.map((c, x) => h('td', { key: x }, inline(c, `c${y}-${x}`, zone, onNavigate))))),
									),
								],
							),
						),
					);
					continue;
				}
				if (/^\s*[-*]\s+/.test(line)) {
					const items = [];
					while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
					blocks.push(h('ul', { key: `b${k++}` }, items.map((t, x) => h('li', { key: x }, inline(t, `i${x}`, zone, onNavigate)))));
					continue;
				}
				// Headings at EVERY level (1-4). The 3/4-only pattern left `##`
				// falling through to the paragraph branch, where the hashes print
				// as literal text — a whole class of stored bodies (skills whose
				// sections are `## 程序体`-style) rendered as raw markdown.
				if (/^#{1,4}\s/.test(line)) {
					const level = line.match(/^#+/)[0].length;
					const tag = level <= 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
					blocks.push(h(tag, { key: `b${k++}` }, inline(line.replace(/^#+\s*/, ''), `h${k}`, zone, onNavigate)));
					i++;
					continue;
				}
				if (/^>\s?/.test(line)) {
					const buf = [];
					while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
					blocks.push(h('blockquote', { key: `b${k++}` }, inline(buf.join(' '), `q${k}`, zone, onNavigate)));
					continue;
				}
				if (/^-{3,}$/.test(line.trim())) {
					blocks.push(h('hr', { key: `b${k++}` }));
					i++;
					continue;
				}
				const buf = [];
				while (i < lines.length && lines[i].trim() !== '' && !/^(\||\s*[-*]\s|#{1,4}\s|>|```|-{3,}$)/.test(lines[i])) buf.push(lines[i++]);
				blocks.push(h('p', { key: `b${k++}` }, inline(buf.join(' '), `p${k}`, zone, onNavigate)));
			}
			return h('div', { className: 'dmo-md' }, blocks);
		}

		/**
		 * Split a zone section into its sub-tables.
		 *
		 * A zone section is NOT always one table: once it grows past ~40 rows the
		 * server's `memory_index` writes `### 索引·<域>` sub-tables (and R5 nags
		 * until it does), each carrying its OWN header row. Rendering the whole
		 * `##` section as a single table therefore printed the column header
		 * ("功能域" / "思想主题") twice and glued two tables together with no
		 * separator — the duplication the panel showed for exactly those two
		 * zones.
		 *
		 * @returns `[{ title, lines }]` — one entry per table, empty ones dropped.
		 */
		function subTablesOf(section) {
			const parts = [];
			let cur = { sub: '', lines: [] };
			for (const line of String(section?.body ?? '').split('\n')) {
				if (/^###\s/.test(line.trim())) {
					parts.push(cur);
					cur = { sub: line.trim().replace(/^###\s*/, ''), lines: [] };
				} else cur.lines.push(line);
			}
			parts.push(cur);
			const title = (sub) => {
				// The heading is used AS WRITTEN: the old `replace(/^[^ ]*\s*/, '')`
				// silently ate the leading name of any heading containing a space
				// ("能力台账 细节子目录（…）" rendered as "细节子目录（…）").
				const parent = String(section.heading ?? '').trim();
				if (!sub) return parent;
				// `索引·业务功能` → parent reads better than a bare sub-title.
				return `${parent} · ${sub.replace(/^索引[·・]\s*/, '')}`;
			};
			return parts
				.map((p) => ({ title: title(p.sub), lines: p.lines }))
				.map((p) => ({
					...p,
					rows: p.lines
						.map((l) => l.trim())
						.filter((l) => l.startsWith('|'))
						.map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
						.filter((cells) => cells.length >= 2 && !cells.every((c) => /^[-: ]*$/.test(c))),
				}))
				.filter((p) => p.rows.length > 1); // a header alone is not a table
		}

		/** MEMORY.md navigation tables: each row opens its target file. */
		function IndexTables({ text, onNavigate }) {
			const { sections } = splitSections(text);
			// 只挑**表格**类小节；道层是 bullet 列表，由索引页的普通小节卡渲染，
			// 不在这里（subTablesOf 本来也会把它过滤成空，但精确前缀让意图明确，
			// 也避免标题里含「思想」的道层被误收进来）。
			const wanted = sections.filter((s) => /^(功能模块索引|创新优化思想索引|能力台账|技能台账)/.test(s.heading));
			if (!wanted.length) return null;
			const tables = wanted.flatMap((s) => subTablesOf(s));
			if (!tables.length) return null;
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 10 } },
				tables.map((t, ti) => {
					const rows = t.rows.slice();
					const head = rows.shift() ?? [];
					return h(
						'section',
						{ key: `t${ti}` },
						h('h3', { className: 'dmo-h2' }, t.title),
						h(
							'table',
							{ className: 'dmo-table' },
							[
								h('thead', { key: 'h' }, h('tr', null, head.map((c, x) => h('th', { key: x }, plain(c))))),
								h(
									'tbody',
									{ key: 'b' },
									rows.map((cells, y) => {
										const href = cells.map((c) => /\]\(([^)]+\.md)\)/.exec(c)?.[1]).find(Boolean);
										const target = href ? resolveHref(href, '') : null;
										return h(
											'tr',
											{
												key: y, className: target ? 'dmo-idx-row' : undefined,
												onClick: target && onNavigate ? () => onNavigate(target) : undefined,
												title: target ? `打开 ${target.name}` : undefined,
											},
											cells.map((c, x) => h('td', { key: x, className: x === 0 ? 'dmo-idx-name' : undefined }, inline(c, `r${y}-${x}`, '', onNavigate))),
										);
									}),
								),
							],
						),
					);
				}),
			);
		}

		// ---------------------------------------------------------------------
		// reader
		// ---------------------------------------------------------------------

		function Section({ index, section, open, onToggle, zone, onNavigate, registerRef }) {
			return h(
				'div',
				{ className: 'dmo-sec', 'data-dmo': 'section', ref: (el) => registerRef(index, el) },
				h(
					'button',
					{ type: 'button', className: 'dmo-sec-head', onClick: () => onToggle(index), 'data-dmo': 'section-head' },
					h('span', { className: 'caret' }, open ? '▾' : '▸'),
					section.date ? h('span', { className: 'dmo-sec-date' }, section.date) : null,
					h('span', { className: 'dmo-sec-title' }, section.heading),
					h('span', { className: 'dmo-meta', style: { marginLeft: 'auto' } }, `${section.body.length}B`),
				),
				open ? h('div', { className: 'dmo-sec-body' }, h(MarkdownBody, { text: reverseBullets(section.body), zone, onNavigate })) : null,
			);
		}

		/**
		 * Daily threads are append-only audit trails (oldest line first on disk),
		 * but every time-ordered surface reads newest-first — flip the bullet
		 * order of a section body for display. Non-bullet lines (headings, prose,
		 * tables) keep their positions so structure never shuffles.
		 */
		function reverseBullets(body) {
			const lines = String(body ?? '').split('\n');
			const idx = lines.map((l, i) => (/^\s*[-*]\s/.test(l) ? i : -1)).filter((i) => i >= 0);
			if (idx.length < 2) return body;
			const out = lines.slice();
			idx.forEach((orig, k) => {
				out[orig] = lines[idx[idx.length - 1 - k]];
			});
			return out.join('\n');
		}

		function Reader({ view, text, meta, kind, root, onBack, onNavigate }) {
			const { preamble, sections } = splitSections(text ?? '');
			const [open, setOpen] = useState(() => defaultOpen(kind, sections, text));
			const [allOpen, setAllOpen] = useState(false);
			const refs = useRef(new Map());
			const fileName = view.zone === '' ? 'MEMORY.md' : view.name;

			useEffect(() => {
				setOpen(defaultOpen(kind, sections, text));
				setAllOpen(false);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [view.zone, fileName, text]);

			const registerRef = (i, el) => {
				if (el) refs.current.set(i, el);
				else refs.current.delete(i);
			};
			const jump = (i) => {
				setOpen((m) => ({ ...m, [i]: true }));
				if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => refs.current.get(i)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
			};
			const toggleAll = () => {
				const next = !allOpen;
				setAllOpen(next);
				const m = {};
				sections.forEach((s, i) => (m[i] = next));
				setOpen(m);
			};
			const copyPath = () => {
				const rel = view.zone === '' ? 'MEMORY.md' : `${ZONE_DIR[view.zone] ? `${ZONE_DIR[view.zone]}/` : ''}${fileName}`;
				const full = root ? `${root}/${rel}`.replace(/\\/g, '/') : rel;
				try {
					navigator.clipboard?.writeText(full);
				} catch {
					/* clipboard unavailable */
				}
			};

			// Every time-ordered surface reads newest-first: the section cards are
			// rendered in reverse file order (file stays append-only oldest-first;
			// the reader flips it), so the top card is always the latest state.
			// Index maps (`open[i]`, `refs`, `jump(i)`) keep the ORIGINAL section
			// indices — only the render order changes.
			const shown = sections.map((s, i) => ({ s, i })).reverse();
			const chipRows = kind === 'functions' ? shown.map(({ s, i }) => ({ i, label: s.date ? `${s.date}${/补$/.test(s.heading) ? '补' : ''}` : `#${i + 1}` })) : shown.map(({ s, i }) => ({ i, label: s.heading.slice(0, 14) }));

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 10 } },
				h(
					'div',
					{ className: 'dmo-crumbs' },
					h(Btn, { sm: true, onClick: onBack, title: '返回列表' }, '← 返回'),
					view.zone !== '' ? h('span', { className: 'dmo-meta' }, ZONE_LABEL[view.zone]) : null,
					view.zone !== '' ? h('span', { className: 'dmo-crumb-sep' }, '/') : null,
					h('span', { className: 'dmo-mono', style: { fontSize: 12 }, 'data-dmo': 'crumb' }, fileName),
				),
				h(
					'div',
					{ className: 'dmo-doc-head' },
					meta
						? h('span', { className: 'dmo-meta' }, [fmtBytes(meta.bytes), relTime(meta.mtime), sections.length ? `${sections.length} 个片段` : null].filter(Boolean).join(' · '))
						: h('span', { className: 'dmo-meta' }, sections.length ? `${sections.length} 个片段` : ''),
					h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
						sections.length > 1 ? h(Btn, { sm: true, tone: 'outline', onClick: toggleAll }, allOpen ? '仅看最新' : '展开全部') : null,
						h(Btn, { sm: true, tone: 'outline', onClick: copyPath, title: '复制文件路径' }, '复制路径'),
					),
				),
				sections.length > 3
					? h(
							'div',
							{ className: 'dmo-toc' },
							chipRows.map((c) =>
								h(
									'button',
									{ key: c.i, type: 'button', className: 'dmo-chip btn', onClick: () => jump(c.i), title: sections[c.i].heading, 'data-dmo': 'toc-chip' },
									c.label,
								),
							),
						)
					: null,
				kind === 'index' ? h(IndexTables, { text: text ?? '', onNavigate }) : null,
				preamble && kind !== 'index'
					? h(Card, { tight: true }, h(MarkdownBody, { text: preamble, zone: view.zone, onNavigate }))
					: null,
				kind === 'index'
					? h(
							'div',
							{ style: { display: 'flex', flexDirection: 'column', gap: 6 } },
							sections
								// 表格类小节与「共识/环境常量」都在别处渲染，索引页不重复。
								// 判据用精确前缀而不是关键字子串：`## 道层（最抽象的指导思想）`
								// 含「思想」二字，用子串匹配会把道层整节误过滤掉。
								.filter((s) => !/^(功能模块索引|创新优化思想索引|能力台账|技能台账|决策共识|环境常量)/.test(s.heading))
								.map((s, i) => h(Card, { key: `x${i}`, tight: true }, h('h3', { className: 'dmo-h2' }, s.heading), h(MarkdownBody, { text: s.body, zone: '', onNavigate }))),
						)
					: h(
							'div',
							{ style: { display: 'flex', flexDirection: 'column', gap: 6 } },
							shown.map(({ s, i }) => h(Section, { key: `${s.heading}-${i}`, index: i, section: s, open: Boolean(open[i]), onToggle: (x) => setOpen((m) => ({ ...m, [x]: !m[x] })), zone: view.zone, onNavigate, registerRef })),
						),
			);
		}

		// ---------------------------------------------------------------------
		// overview / lists / search
		// ---------------------------------------------------------------------

		function Overview({ health, counts, timeline, usage, env, prose, preview, previewQ, setPreviewQ, onOpen, onZone, onNavigate }) {
			const problems = health?.results ?? [];
			const fails = problems.filter((p) => p.level === 'FAIL');
			const warns = problems.filter((p) => p.level === 'WARN');
			const cold = problems.filter((p) => p.rule === 'TEMP');
			const usageLayer = usage?.layers ?? {};
			const hotspots = usage?.hotspots ?? [];
			const hasSignals = (usage?.signalCount ?? 0) > 0;
			// Index fill meter: comfort line is the design target, the hard line
			// the wall. Two thresholds, one bar — the reader sees headroom at a
			// glance instead of reading a byte count.
			const envRow = env
				? h(
						'div',
						{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
						h(
							'div',
							{ className: 'dmo-chips' },
							h(Chip, { tone: 'ok' }, `运行版本 ${env.version || '?'}`),
							env.canReload
								? h(Chip, { tone: 'ok' }, '支持热重启')
								: h(Chip, { tone: 'warn' }, '宿主不支持热重启'),
							env.hotReloadRunning ? h(Chip, { tone: 'warn' }, '换弹进行中') : null,
						),
						h(
							'div',
							{ className: 'dmo-env-rows', 'data-dmo': 'env-rows' },
							h('div', { className: 'dmo-env-row' }, h('span', { className: 'dmo-env-k' }, '记忆根'), h('span', { className: 'dmo-env-v dmo-mono' }, env.memoryRoot ?? '')),
							h('div', { className: 'dmo-env-row' }, h('span', { className: 'dmo-env-k' }, '技能库'), h('span', { className: 'dmo-env-v dmo-mono' }, env.skillRoot ?? '')),
							h(
								'div',
								{ className: 'dmo-env-row' },
								h('span', { className: 'dmo-env-k' }, '索引体积'),
								h(
									'span',
									{ className: 'dmo-env-v' },
									h(
										'span',
										{ className: 'dmo-meter', title: `MEMORY.md ${env.indexBytes ?? 0}B / 舒适线 ${env.indexComfortBytes ?? 0}B / 硬上限 ${env.indexHardBytes ?? 0}B` },
										h('i', { className: `dmo-meter-fill${(env.indexBytes ?? 0) > (env.indexComfortBytes ?? 0) ? ' over' : ''}`, style: { width: `${Math.min(100, Math.round(((env.indexBytes ?? 0) / Math.max(1, env.indexHardBytes ?? 1)) * 100))}%` } }),
									),
									h('span', { className: 'dmo-meta' }, ` ${fmtBytes(env.indexBytes ?? 0)} / 舒适 ${fmtBytes(env.indexComfortBytes ?? 0)}`),
								),
							),
						),
					)
				: null;
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 12 } },
				h(
					Card,
					null,
					h(
						'div',
						{ className: 'dmo-chips' },
						h(Chip, { tone: fails.length ? 'fail' : 'ok' }, fails.length ? `FAIL ${fails.length}` : '无 FAIL'),
						h(Chip, { tone: warns.length ? 'warn' : null }, warns.length ? `WARN ${warns.length}` : '无 WARN'),
						cold.length ? h(Chip, { tone: 'warn' }, `❄ 冷记忆 ${cold.length}`) : null,
					),
					problems.length
						? h('ul', { className: 'dmo-probs' }, problems.slice(0, 12).map((p, i) => h('li', { key: i }, `[${p.level}] ${p.rule}: ${p.message}`)))
						: h('div', { className: 'dmo-meta', style: { marginTop: 6 } }, '体检通过：索引体积、摘要、反向链接、日期顺序、死链、冷记忆均正常。'),
				),
				h(
					'div',
					{ className: 'dmo-growth' },
					[
						{ zone: 'functions', label: '功能模块' },
						{ zone: 'insights', label: '创新优化思想' },
						{ zone: 'capabilities', label: '能力台账' },
						{ zone: 'skills', label: '技能库' },
						{ zone: 'daily', label: '当日线索' },
					].map((g) =>
						h(
							'button',
							{ key: g.zone, type: 'button', className: 'dmo-gcard', onClick: () => onZone(g.zone), 'data-dmo': 'growth-card' },
							h('div', { className: 'dmo-gnum' }, String(counts[g.zone] ?? 0)),
							h('div', { className: 'dmo-meta' }, g.label),
						),
					),
				),
				// Consensus + environment constants: the two prose blocks of
			// MEMORY.md that the index tables do not carry. They answer "what
			// did we agree across features" and "which machine path is real",
			// which is exactly what a future session needs before acting.
			prose && (prose.consensus.length || prose.env.length)
				? h(
						Card,
						null,
						h(CardTitle, null, '共识与环境常量'),
						h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
							prose.consensus.length
								? h('div', null,
										h('div', { className: 'dmo-meta', style: { marginBottom: 4 } }, '跨功能共识 / 规范'),
										h('ul', { className: 'dmo-prose' }, prose.consensus.map((c, i) => h('li', { key: `c${i}` }, c))),
									)
								: null,
							prose.env.length
								? h('div', null,
										h('div', { className: 'dmo-meta', style: { marginBottom: 4 } }, '环境常量（易忘）'),
										h('ul', { className: 'dmo-prose' }, prose.env.map((c, i) => h('li', { key: `e${i}` }, c))),
									)
								: null,
						),
					)
				: null,
			env
					? h(Card, null, h(CardTitle, null, '运行环境'), envRow)
					: null,
				h(
					Card,
					null,
					h(CardTitle, null, '使用信号'),
					!hasSignals
						? h('div', { className: 'dmo-meta' }, '还没有使用信号。召回命中与 memory_read 会自动记录；纠正/认可用 memory_usage(record) 记一笔。')
						: h(
								'div',
								{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
								h(
									'div',
									{ className: 'dmo-chips', 'data-dmo': 'usage-layers' },
									h(Chip, null, `实验 ${usageLayer['实验'] ?? 0}`),
									h(Chip, { tone: 'ok' }, `专项 ${usageLayer['专项'] ?? 0}`),
									h(Chip, { tone: 'ok' }, `通用 ${usageLayer['通用'] ?? 0}`),
									h('span', { className: 'dmo-meta' }, `30 天 ${usage.signalCount} 条信号`),
								),
								hotspots.length
									? h(
											'ul',
											{ className: 'dmo-probs' },
											hotspots.map((h0, i) =>
												h('li', { key: i }, [
													h0.flips >= 2 ? `结论反复推翻（翻转 ${h0.flips}）` : null,
													h0.badRate > 0.4 ? `纠正率 ${Math.round(h0.badRate * 100)}%` : null,
													` — ${h0.href}`,
												].filter(Boolean).join(' · ')),
											),
										)
									: h('div', { className: 'dmo-meta' }, '无热点：没有反复推翻或高纠正率的记忆。'),
							),
				),
				preview
					? h(RecallPreviewCard, { res: preview, q: previewQ, setQ: setPreviewQ, onNavigate })
					: null,
				h(
					Card,
					null,
					h(CardTitle, null, '最近改动'),
					timeline.length
						? h(
								'div',
								{ className: 'dmo-tl' },
								timeline.map((t, i) =>
									h(
										'button',
										{ key: i, type: 'button', className: 'dmo-tl-row', onClick: () => onOpen(t.zone, t.name), 'data-dmo': 'timeline-row', title: t.name },
										h('span', { className: 'dmo-tl-when' }, relTime(t.mtime)),
										h('span', { className: 'dmo-zone-tag' }, ZONE_LABEL[t.zone]),
										h('span', { className: 'dmo-tl-name' }, t.zone === 'daily' ? t.name.replace(/\.md$/, '') : t.name.replace(/\.md$/, '')),
										t.summary ? h('span', { className: 'dmo-tl-sum' }, t.summary) : null,
									),
								),
							)
						: h('div', { className: 'dmo-meta' }, '还没有记忆文件。'),
				),
			);
		}

		/**
		 * Recall self-check (5.26.0 overview card): type what a future session
		 * might say and see EXACTLY which index rows the real pre-step pipeline
		 * would inject, with the reasons (name hits, lexical score, usage stats).
		 * The same endpoint already debugged recall from the CLI side; this makes
		 * it visible in the panel. All state is parent-owned (q is the input
		 * value, res the debounced fetch) so the card renders deterministically
		 * under the UI shim — the same contract SearchPane proves.
		 */
		function RecallPreviewCard({ res, q, setQ, onNavigate }) {
			const data = res?.data;
			const rows = data?.rows ?? [];
			return h(
				Card,
				null,
				h(CardTitle, null, '召回自检'),
				h(
					'div',
					{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
					h('input', {
						type: 'search', className: 'dmo-filter', placeholder: '输入一段话，看它现在会召回什么…',
						value: q, 'data-dmo': 'preview-input',
						onChange: (e) => setQ(e.target.value),
					}),
					q.trim().length < 2
						? h('div', { className: 'dmo-meta' }, '至少 2 个字。命中 = 未来会话开头会注入的记忆行。')
						: res?.loading
							? h('div', { className: 'dmo-empty' }, '跑召回中…')
							: res?.error
								? h('div', { className: 'dmo-empty' }, `召回失败：${res.error}`)
								: h(
										'div',
										{ className: 'dmo-rows', 'data-dmo': 'preview-rows' },
										rows.length
											? rows.map((r, i) => {
													const t = resolveHref(r.href, r.zone === 'skill' ? 'skills' : r.zone === 'insight' ? 'insights' : 'functions');
													// recall rows name zones in the SINGULAR (skill/function/
													// insight); the label table keys them in plural.
													const zoneKey = r.zone === 'skill' ? 'skills' : r.zone === 'insight' ? 'insights' : r.zone === 'function' ? 'functions' : r.zone;
													// A bundle row's leaf is SKILL.md — the reader wants the
													// DIRECTORY name (the skill's identity), not the leaf.
													const seg = String(r.href).split('/').filter(Boolean);
													const leaf = seg[seg.length - 1] ?? '';
													const label = leaf === 'SKILL.md' ? (seg[seg.length - 2] ?? leaf) : leaf.replace(/\.md$/, '');
													return h(
														'div',
														{ key: i, className: 'dmo-row', 'data-dmo': 'preview-row' },
														h(
															'button',
															{
																type: 'button', className: 'dmo-row-btn', title: r.href,
																disabled: !t,
																onClick: () => t && onNavigate(t),
															},
															h(
																'div',
																{ className: 'dmo-row-top' },
																h('span', { className: 'dmo-zone-tag' }, ZONE_LABEL[zoneKey] ?? r.zone),
																h('span', { className: 'dmo-row-name' }, label),
																h('span', { className: 'dmo-row-meta' }, `得分 ${r.fusedScore}`),
															),
															h('div', { className: 'dmo-row-sum' }, r.summary),
														),
														r.reasons?.length
															? h(
																	'div',
																	{ className: 'dmo-chips', style: { padding: '0 8px 8px' } },
																	r.reasons.map((why, j) => h('span', { key: j, className: 'dmo-chip' }, why)),
																)
															: null,
													);
												})
											: h('div', { className: 'dmo-empty' }, data?.message ?? '（无命中）'),
									),
				),
			);
		}

		function ZoneList({ zone, rows, sort, setSort, filter, setFilter, onOpen }) {
			const label = ZONE_LABEL[zone] ?? zone;
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
				h(
					'div',
					{ className: 'dmo-toolbar' },
					h('span', { style: { fontSize: 14, fontWeight: 600 } }, label),
					h('span', { className: 'dmo-meta' }, `${rows.length} 项`),
					zone !== 'daily' ? h(Btn, { sm: true, tone: 'outline', onClick: () => setSort(sort === 'time' ? 'name' : 'time'), title: '切换排序' }, sort === 'time' ? '按时间 ↓' : '按名称 ↑') : h('span', { className: 'dmo-meta' }, '按时间 ↓'),
					h('span', { className: 'grow' }),
					h('input', { className: 'dmo-filter', style: { width: 180 }, placeholder: zone === 'daily' ? '过滤日期…' : '按名称或摘要过滤…', value: filter, onChange: (e) => setFilter(e.target.value) }),
				),
				rows.length
					? h(
							'div',
							{ className: 'dmo-rows' },
							rows.map((f, i) => {
								// Daily threads accumulate one file per day, so months get a
								// sticky-ish separator: 100 days stay scannable.
								const month = f.name.slice(0, 7);
								const newMonth = zone === 'daily' && (i === 0 || rows[i - 1].name.slice(0, 7) !== month);
								return h(
									'div',
									{ key: f.name, className: 'dmo-group' },
									newMonth ? h('div', { key: 'm', className: 'dmo-month' }, month) : null,
									h(
										'button',
										{ key: 'r', type: 'button', className: 'dmo-row', onClick: () => onOpen(zone, f.name), title: f.name, 'data-dmo': 'row' },
										h(
											'div',
											{ className: 'dmo-row-top' },
											h('span', { className: 'dmo-row-name' }, zone === 'daily' ? f.name.replace(/\.md$/, '') : f.name.replace(/\.md$/, '')),
											h('span', { className: 'dmo-row-meta' }, `${relTime(f.mtime)} · ${fmtBytes(f.bytes)}`),
										),
										f.summary ? h('div', { className: 'dmo-row-sum' }, f.summary) : null,
									),
								);
							}),
						)
					: h('div', { className: 'dmo-empty' }, filter ? '没有匹配的条目。' : `${label}区还没有文件。`),
			);
		}

		// ---------------------------------------------------------------------
		// skill library (memory-crystallized vs host-installed)
		// ---------------------------------------------------------------------

		/**
		 * The skills destination: a library over ONE store (5.24.0) — every skill
		 * is a host bundle under the user skill root. The ONE toggle splits by
		 * provenance: 结晶技能 = bundles this plugin owns (`agent_created`), in
		 * every lifecycle state; 系统技能 = installed bundles (skill-creator and
		 * friends), read-only. Both tabs open the same bundle view. `tab` is
		 * navigation state owned by the parent (not local useState) so the panel
		 * renders either side deterministically — in the browser via setView, in
		 * the UI test via initialView.
		 */
		function SkillLibrary({ data, loading, error, tab, onTab, onOpenMemory, onOpenHost, onToggle, onDelete, actMsg, toggleBusy, filter, setFilter }) {
			const mem = data?.memory ?? [];
			const host = data?.host ?? [];
			const q = filter.trim().toLowerCase();
			const match = (s) => !q || String(s.name).toLowerCase().includes(q) || String(s.description ?? '').toLowerCase().includes(q);
			const shown = tab === 'host' ? host.filter(match) : mem.filter(match);
			const STATUS_TONE = { active: 'ok', candidate: 'warn', retired: undefined };
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
				h(
					'div',
					{ className: 'dmo-toolbar' },
					h('span', { style: { fontSize: 14, fontWeight: 600 } }, '技能库'),
					h(
						'div',
						{ className: 'dmo-chips' },
						h('button', { type: 'button', className: `dmo-chip btn${tab === 'memory' ? ' active' : ''}`, 'data-dmo': 'skill-tab', onClick: () => onTab('memory') }, `结晶技能 ${mem.length}`),
						h('button', { type: 'button', className: `dmo-chip btn${tab === 'host' ? ' active' : ''}`, 'data-dmo': 'skill-tab', onClick: () => onTab('host') }, `系统技能 ${host.length}`),
					),
					h('span', { className: 'grow' }),
					h('input', { className: 'dmo-filter', style: { width: 180 }, placeholder: '按名称或描述过滤…', value: filter, onChange: (e) => setFilter(e.target.value), 'data-dmo': 'skill-filter' }),
				),
				data?.hostDegraded && tab === 'host'
					? h('div', { className: 'dmo-empty' }, '宿主技能根不可读，系统技能暂不可列；结晶技能不受影响。')
					: null,
				error
					? h('div', { className: 'dmo-empty' }, `读取技能库失败：${error}`)
					: loading && !data
						? h('div', { className: 'dmo-empty' }, '读取技能库…')
						: actMsg
							? h('div', { className: 'dmo-empty', 'data-dmo': 'skill-actmsg' }, actMsg)
							: shown.length
					? h(
							'div',
							{ className: 'dmo-rows' },
							shown.map((s) =>
								h(
									'div',
									{
										key: `${tab}:${s.name}`, className: 'dmo-row', 'data-dmo': 'skill-row',
										title: s.name,
									},
									// The row opens the skill; the controls at its right act
									// WITHOUT opening (separate buttons, stopPropagation
									// not needed — they are not inside the open button).
									h(
										'button',
										{
											type: 'button', className: 'dmo-row-btn', 'data-dmo': 'skill-open',
											onClick: () => (tab === 'host' ? onOpenHost(s.name) : onOpenMemory(s.name)),
											title: `打开 ${s.name}`,
										},
										h(
											'div',
											{ className: 'dmo-row-top' },
											h('span', { className: 'dmo-row-name' }, s.name),
											h(
												'span',
												{ className: 'dmo-row-meta' },
												tab === 'host'
													? h(Chip, {}, `${s.source || 'host'} · ${s.files?.length ?? 0} 文件`)
													: h(
															'span',
															{},
															h(Chip, { tone: STATUS_TONE[s.status] }, s.status),
															// 5.24.0: one store — active IS published
															// (the bridge gate reads this same bundle), so a
															// separate "已发布宿主" badge would only echo
															// the status chip. Scope still earns its own.
															s.scope ? h(Chip, {}, s.scope === 'project' && s.scopeProject ? `${s.scope}:${s.scopeProject}` : s.scope) : null,
														),
											),
										),
										s.description ? h('div', { className: 'dmo-row-sum' }, s.description) : null,
									),
									// Lifecycle controls, crystallized side only: the enable
									// switch (activate/retire) and delete. Host bundles are
									// managed in their own repos / the plugin manager.
									tab === 'memory'
										? h(
												'span',
												{ className: 'dmo-row-actions' },
												h(
													'button',
													{
														type: 'button', className: `dmo-switch${s.status === 'active' ? ' on' : ''}`,
														'data-dmo': 'skill-toggle', role: 'switch', 'aria-checked': s.status === 'active',
														title: s.status === 'active' ? '停用（retire）' : '启用（activate）',
														onClick: () => onToggle(s.name, s.status === 'active' ? 'retire' : 'activate'),
														disabled: toggleBusy === s.name,
													},
													h('span', { className: 'dmo-switch-dot' }),
												),
												h(
													'button',
													{
														type: 'button', className: 'dmo-row-del',
														'data-dmo': 'skill-delete', title: `删除 ${s.name}（不可恢复，git 是档案）`,
														onClick: () => onDelete(s.name),
													},
													'×',
												),
											)
										: null,
								),
							),
						)
					: h('div', { className: 'dmo-empty' }, filter ? '没有匹配的技能。' : tab === 'host' ? '宿主技能根没有可列的目录包。' : '还没有结晶技能——memory_skill(candidates) 看提名，反复跑通的操作可结晶成程序。'),
			);
		}

		/**
		 * A skill's STORED-CONTENT view (5.24.0: ONE renderer for ONE store).
		 * Every skill is a host bundle; the SKILL.md body renders plus the file
		 * tree (scripts/references/...) — each file one click away. The panel
		 * reads what is ON DISK; the registry (invocation policy, publish gates)
		 * is the machine's surface and is deliberately not consulted here.
		 * `sel` is navigation state owned by the parent (the same reasoning as the
		 * library tab: a local useState would be untestable under the UI shim).
		 */
		function SkillBundleView({ data, name, onBack, sel, onSel, fixtures }) {
			const d = data?.data;
			const files = d?.files ?? [];
			const fileUrl = sel ? `${API}/skillfile?name=${enc(name)}&file=${enc(sel)}` : null;
			const fileRes = useApi(fileUrl, fixtures);
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
				h(
					'div',
					{ className: 'dmo-toolbar' },
					h(Btn, { sm: true, onClick: onBack, title: '返回技能库', 'data-dmo': 'back' }, '← 返回技能库'),
					h('span', { className: 'grow' }),
					h('span', { className: 'dmo-meta' }, '存储内容 · 只读'),
				),
				h(
					'div',
					{ style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
					h(
						'div',
						{ style: { width: 230, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
						h('div', { className: 'dmo-meta', style: { padding: '0 2px' } }, `文件 ${files.length}`),
						h(
							'div',
							{ className: 'dmo-chips' },
							files.map((f) =>
								h('button', {
									key: f.rel, type: 'button',
									className: `dmo-chip btn${sel === f.rel ? ' active' : ''}`,
									'data-dmo': 'skill-file',
									onClick: () => onSel(f.rel),
									title: f.rel,
								}, f.rel || 'SKILL.md'),
							),
						),
					),
					h(
						'div',
						{ style: { flex: 1, minWidth: 0 } },
						sel === null
							? h(
									'div',
									{ className: 'dmo-card' },
									h('h3', { className: 'dmo-h2', style: { margin: '0 0 6px' } }, name),
									d?.description ? h('div', { className: 'dmo-row-sum', style: { marginBottom: 6 } }, d.description) : null,
									h(MarkdownBody, { text: d?.text ?? '', zone: undefined, onNavigate: () => {} }),
								)
							: fileRes.loading
								? h('div', { className: 'dmo-empty' }, '读取文件…')
								: fileRes.error
									? h('div', { className: 'dmo-empty' }, `读取失败：${fileRes.error}`)
									: h(
											'div',
											{ className: 'dmo-card' },
											h('h3', { className: 'dmo-h2', style: { margin: '0 0 6px' } }, sel),
											h('pre', { className: 'dmo-md', style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, fileRes.data?.text ?? ''),
										),
					),
				),
			);
		}

		/** Mark every occurrence of the query inside a snippet (case-insensitive). */
		function highlight(text, q) {
			const src = String(text ?? '');
			const needle = String(q ?? '').trim();
			if (!needle) return [src];
			const out = [];
			const lower = src.toLowerCase();
			const needleLower = needle.toLowerCase();
			let at = 0;
			let i = 0;
			for (;;) {
				const next = lower.indexOf(needleLower, at);
				if (next === -1) break;
				if (next > at) out.push(src.slice(at, next));
				out.push(h('mark', { key: `m${i++}`, className: 'dmo-mark' }, src.slice(next, next + needle.length)));
				at = next + needle.length;
			}
			if (at < src.length) out.push(src.slice(at));
			return out;
		}

		// ---------------------------------------------------------------------
		// 问题收件箱（2026-10-26）
		// ---------------------------------------------------------------------
		// 各插件与 agent 投递的问题汇总在这里，用户一屏看到"有哪些问题、
		// 谁报的、多久了、修了没"。设计取向：状态可改而不只是只读 ——
		// 用户能标 acknowledged（已认领）或 resolved（已解决），这些操作
		// 走 POST /inbox-action 落到磁盘，下次体检据此判断是否真的修好。
		const INBOX_STATUS = [
			{ key: 'open', label: '未处理', mark: '○', tone: 'warn' },
			{ key: 'acknowledged', label: '处理中', mark: '◐', tone: 'info' },
			{ key: 'resolved', label: '已解决', mark: '●', tone: 'ok' },
		];

		/** 把 ISO 时间说成"多久之前"。 */
		function agoText(iso) {
			if (!iso) return '';
			const ms = Date.now() - new Date(iso).getTime();
			if (!Number.isFinite(ms) || ms < 0) return '';
			const min = Math.floor(ms / 60000);
			if (min < 1) return '刚刚';
			if (min < 60) return `${min} 分钟前`;
			const hour = Math.floor(min / 60);
			if (hour < 24) return `${hour} 小时前`;
			const day = Math.floor(hour / 24);
			return `${day} 天前`;
		}

		function InboxPane({ res, statusFilter, setStatusFilter, onStateChange }) {
			const data = res.data;
			const items = data?.items ?? [];
			const counts = data?.counts ?? { open: 0, acknowledged: 0, resolved: 0 };
			const [busy, setBusy] = useState(null);
			// 二次确认：正在等确认的 fingerprint。删除不可逆，误点代价大，
			// 故第一次点只把按钮变成"确认删除"，第二次点才真删。
			const [confirming, setConfirming] = useState(null);
			const total = counts.open + counts.acknowledged + counts.resolved;

			/** 统一走 /inbox-action：payload 决定是改状态还是删除。 */
			const write = (fingerprint, payload) => {
				setBusy(fingerprint);
				fetch(`${API}/inbox-action`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ fingerprint, ...payload }),
				})
					.then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
					.then(() => {
						setConfirming(null);
						onStateChange?.();
					})
					.catch(() => {})
					.finally(() => setBusy(null));
			};

			const changeStatus = (fingerprint, status) => write(fingerprint, { status });
			const remove = (fingerprint) => write(fingerprint, { op: 'delete' });

			const chips = INBOX_STATUS.map((s) =>
				h(
					'button',
					{
						key: s.key,
						type: 'button',
						className: `dmo-chip btn${statusFilter === s.key ? ' active' : ''}`,
						'data-dmo': 'inbox-filter',
						onClick: () => setStatusFilter(s.key),
						title: `只看${s.label}`,
					},
					`${s.mark} ${s.label} ${counts[s.key] ?? 0}`,
				),
			);

			const head = h(
				'div',
				{ className: 'dmo-toolbar' },
				h('span', { style: { fontSize: 14, fontWeight: 600 } }, '问题收件箱'),
				h('span', { className: 'dmo-meta' }, `共 ${total} 条`),
				h('span', { className: 'grow' }),
				h('div', { className: 'dmo-chips' }, chips),
			);

			if (!items.length) {
				const which = statusFilter ? INBOX_STATUS.find((s) => s.key === statusFilter)?.label : '全部';
				return h(
					'div',
					{ style: { display: 'flex', flexDirection: 'column', gap: 10 } },
					head,
					h(
						'div',
						{ className: 'dmo-card' },
						h('div', { className: 'dmo-empty' }, `「${which}」里没有条目。`),
						h(
							'div',
							{ className: 'dmo-meta', style: { padding: '0 14px 14px' } },
							'插件体检发现的问题会自动投递到这里，agent 也可以用 memory_inbox 主动报告。',
						),
					),
				);
			}

			const rows = items.map((item) => {
				const status = INBOX_STATUS.find((s) => s.key === item.status) ?? INBOX_STATUS[0];
				const isBusy = busy === item.fingerprint;
				// 状态按钮：open → 认领 / 解决；acknowledged → 解决；resolved → 重开
				const actions = [];
				if (item.status === 'open') {
					actions.push(
						h(Btn, { key: 'ack', sm: true, tone: 'outline', disabled: isBusy, onClick: () => changeStatus(item.fingerprint, 'acknowledged') }, '认领'),
					);
				}
				if (item.status !== 'resolved') {
					actions.push(
						h(Btn, { key: 'res', sm: true, tone: 'outline', disabled: isBusy, onClick: () => changeStatus(item.fingerprint, 'resolved') }, '标记已解决'),
					);
				} else {
					actions.push(
						h(Btn, { key: 'reopen', sm: true, tone: 'outline', disabled: isBusy, onClick: () => changeStatus(item.fingerprint, 'open') }, '重新打开'),
					);
				}

				// 删除：与"标记已解决"是两回事 —— 解决保留记录（说明处理过），
				// 删除抹掉记录（这条根本不该在收件箱里：误报、重复投递、不再需要跟踪）。
				// 不可逆，故点第一次只进入确认态，第二次才真删。
				const awaiting = confirming === item.fingerprint;
				actions.push(
					h(
						Btn,
						{
							key: 'del',
							sm: true,
							tone: awaiting ? 'danger' : 'outline',
							disabled: isBusy,
							'data-dmo': 'inbox-delete',
							title: awaiting ? '再点一次即永久删除，不可撤销' : '彻底删除这条（不可撤销）',
							onClick: () => (awaiting ? remove(item.fingerprint) : setConfirming(item.fingerprint)),
						},
						awaiting ? '确认删除' : '删除',
					),
				);
				if (awaiting) {
					actions.push(
						h(
							Btn,
							{
								key: 'cancel',
								sm: true,
								tone: 'link',
								disabled: isBusy,
								onClick: () => setConfirming(null),
							},
							'取消',
						),
					);
				}

				return h(
					'div',
					{ key: item.fingerprint, className: 'dmo-gcard', 'data-dmo': 'inbox-row' },
					h(
						'div',
						{ className: 'dmo-gcard-head' },
						h('span', { className: 'dmo-gnum' }, status.mark),
						h('span', { style: { fontWeight: 600 } }, item.code),
						h(Chip, { tone: item.severity === 'error' ? 'warn' : undefined }, item.severity),
						h('span', { className: 'dmo-meta' }, item.from),
						item.times > 1 ? h('span', { className: 'dmo-meta' }, `重复 ${item.times} 次`) : null,
						h('span', { className: 'grow' }),
						h('span', { className: 'dmo-meta' }, agoText(item.lastSeenAt)),
					),
					h('div', { style: { padding: '0 14px 10px' } }, item.message),
					item.hint ? h('div', { className: 'dmo-meta', style: { padding: '0 14px 10px' } }, `提示：${item.hint}`) : null,
					h(
						'div',
						{ className: 'dmo-meta', style: { padding: '0 14px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
						...actions,
						awaiting
							? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '删除后无法恢复；若只是处理完了，改用「标记已解决」')
							: null,
					),
				);
			});

			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, head, ...rows);
		}

		function SearchPane({ res, q, zone, setZone, onOpen }) {
			const hits = res.data?.hits ?? [];
			const zones = [
				{ key: 'all', label: '全部' },
				{ key: 'index', label: '索引' },
				{ key: 'functions', label: '功能' },
				{ key: 'insights', label: '思想' },
				{ key: 'capabilities', label: '能力' },
				{ key: 'skills', label: '技能' },
				{ key: 'daily', label: '每日' },
			];
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
				h(
					'div',
					{ className: 'dmo-toolbar' },
					h('span', { style: { fontSize: 14, fontWeight: 600 } }, `搜索“${q}”`),
					h('span', { className: 'dmo-meta' }, `${hits.length} 处命中`),
					h('span', { className: 'grow' }),
					setZone
						? h(
								'div',
								{ className: 'dmo-chips' },
								zones.map((z) =>
									h(
										'button',
										{
											key: z.key, type: 'button',
											className: `dmo-chip btn${(zone ?? 'all') === z.key ? ' active' : ''}`,
											'data-dmo': 'search-zone',
											onClick: () => setZone(z.key),
										},
										z.label,
									),
								),
							)
						: null,
				),
				res.loading ? h('div', { className: 'dmo-empty' }, '搜索中…') : null,
				res.error ? h('div', { className: 'dmo-empty' }, `搜索失败：${res.error}`) : null,
				h(
					'div',
					{ className: 'dmo-rows' },
					hits.map((hit, i) =>
						h(
							'button',
							{ key: i, type: 'button', className: 'dmo-row', onClick: () => onOpen(hit.zone, hit.name), 'data-dmo': 'row' },
							h(
								'div',
								{ className: 'dmo-row-top' },
								h('span', { className: 'dmo-zone-tag' }, ZONE_LABEL[hit.zone] ?? hit.zone),
								h('span', { className: 'dmo-row-name' }, hit.name.replace(/\.md$/, '')),
								hit.line ? h('span', { className: 'dmo-row-meta' }, `第 ${hit.line} 行`) : null,
							),
							(hit.snippet ?? hit.text) ? h('div', { className: 'dmo-snippet' }, highlight(hit.heading ? `${hit.heading} · ${hit.snippet ?? hit.text}` : (hit.snippet ?? hit.text), q)) : null,
						),
					),
				),
				!res.loading && !hits.length
					? h(
							'div',
							{ className: 'dmo-empty' },
							(zone ?? 'all') === 'all' ? '没有命中。换个关键词试试（≥2 字符，支持中文）。' : '这个分区没有命中——点「全部」看其它分区。',
						)
					: null,
			);
		}

		// ---------------------------------------------------------------------
		// panel
		// ---------------------------------------------------------------------

		function MemoryPanel(props) {
			const fixtures = props?.__apiFixtures;
			const [view, setView] = useState(props?.initialView ?? { kind: 'overview' });
			const [sort, setSort] = useState('time');
			const [filter, setFilter] = useState('');
			const [query, setQuery] = useState('');
			const [live, setLive] = useState('');
			const [searchZone, setSearchZone] = useState('all');
			const [inboxFilter, setInboxFilter] = useState('');
			const [tick, setTick] = useState(0);
			// Hot-reload button state (5.25.0): `reloading` guards against a second
			// click while a swap is in flight (the server side has its own single
			// guard; this one is for the button), `reloadMsg` carries the result.
			const [reloading, setReloading] = useState(false);
			const [reloadMsg, setReloadMsg] = useState('');
			// Recall self-check card (5.26.0): its own input, debounced through the
			// SAME mechanism the global search proves (live → fetch url). The overview
			// is where "what would a future session recall" is worth asking.
			const [previewQ, setPreviewQ] = useState('');
			const [previewLive, setPreviewLive] = useState('');
			const preview = useApi(previewLive.length >= 2 ? `${API}/recall-preview?q=${enc(previewLive)}` : null, fixtures);
			useEffect(() => {
				const t = setTimeout(() => setPreviewLive(previewQ.trim()), 350);
				return () => clearTimeout(t);
			}, [previewQ]);
			const searchRef = useRef(null);
			const mainRef = useRef(null);

			const overview = useApi(`${API}/overview?v=${tick}`, fixtures);
			// 收件箱随 tick 刷新：状态改变后立即重新取，用户能看到进度跳动
			const inboxRes = useApi(`${API}/inbox?v=${tick}`, fixtures);
			const funcs = useApi(`${API}/list?zone=functions&v=${tick}`, fixtures);
			const insights = useApi(`${API}/list?zone=insights&v=${tick}`, fixtures);
			// 道层也要取：少了这一行，点侧栏「道」会直接抛 TypeError（lists.dao
			// 未定义 → rowsOf 里 .map 崩），而不是显示空列表。
			const daos = useApi(`${API}/list?zone=dao&v=${tick}`, fixtures);
			const caps = useApi(`${API}/list?zone=capabilities&v=${tick}`, fixtures);
			const skills = useApi(`${API}/list?zone=skills&v=${tick}`, fixtures);
			const dailies = useApi(`${API}/list?zone=daily&v=${tick}`, fixtures);
			const indexFile = useApi(`${API}/file?name=MEMORY.md&v=${tick}`, fixtures);
			// Skill library + one host skill's body: fetched ONLY when their view is
			// active, so opening other zones never hits the host registry (a heavier
			// read). A null url returns an idle state — the hooks stay unconditional.
			const onSkills = view.kind === 'zone' && view.zone === 'skills';
			const skillLib = useApi(onSkills ? `${API}/skills?v=${tick}` : null, fixtures);
			// 5.24.0: one store, one endpoint — a bundle opens the same way from
			// both library tabs; `tab` rides along so 返回 lands where you came from.
			const bundleSkill = useApi(view.kind === 'bundle' ? `${API}/skill?name=${enc(view.name)}` : null, fixtures);
			// Write actions go through the memory_skill TOOL channel (not a bespoke
			// API): the panel posts the same arguments the model would, so every
			// guard the tool has (safeSlug, atomic write, link lint, index sync)
			// stays in force. Failures surface inline; the list refetches after.
			const [actMsg, setActMsg] = useState('');
			// Per-row pending (5.27.0): the switch has no optimistic state — it
			// refetches after the write — so a double click fires two lifecycle
			// requests and the second lands as "已是 active" noise. The button is
			// disabled while ITS skill's action is in flight.
			const [toggleBusy, setToggleBusy] = useState('');
			const skillAction = async (args) => {
				setActMsg('');
				setToggleBusy(String(args.name ?? ''));
				try {
					const r = await fetch(`${API}/skill-action`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(args),
					});
					const j = await r.json().catch(() => ({}));
					if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
					setTick((n) => n + 1); // refetch the library
					setActMsg(j.message || '');
					return j;
				} catch (e) {
					setActMsg(`操作失败：${String(e?.message ?? e)}`);
					return null;
				} finally {
					setToggleBusy('');
				}
			};
			const search = useApi(live.length >= 2 ? `${API}/search?q=${enc(live)}${searchZone !== 'all' ? `&zone=${searchZone}` : ''}` : null, fixtures);

			const ws = overview.data?.[0];
			const counts = ws?.counts ?? {};
			// The panel API answers with `results` (see runHealthCheck); accept the
			// older `problems` spelling too so a stale server half cannot blank the
			// health chips silently.
			const health = ws ? { initialized: ws.initialized, failCount: ws.failCount, warnCount: ws.warnCount, results: ws.results ?? ws.problems ?? [] } : null;
			const indexText = indexFile.data?.text ?? '';
			const tables = parseIndexTables(indexText);
			const lists = { functions: funcs.data?.files ?? [], insights: insights.data?.files ?? [], dao: daos.data?.files ?? [], capabilities: caps.data?.files ?? [], skills: skills.data?.files ?? [], daily: dailies.data?.files ?? [] };

			useEffect(() => {
				const t = setTimeout(() => setLive(query.trim()), 350);
				return () => clearTimeout(t);
			}, [query]);
			useEffect(() => {
				const t = setInterval(() => setTick((n) => n + 1), 30_000);
				return () => clearInterval(t);
			}, []);

			const summaryOf = (zone, name) => {
				const slug = String(name ?? '').replace(/\.md$/, '');
				// One lookup, keyed by zone: the old ternary chain had no dao branch, so
				// a 道 row listed with an empty summary (present but unexplained).
				const table = Object.prototype.hasOwnProperty.call(tables, zone) ? tables[zone] : null;
				return table?.[slug]?.summary ?? '';
			};
			const rowsOf = (zone) => {
				const q = filter.trim().toLowerCase();
				let rows = lists[zone].map((f) => ({ ...f, summary: summaryOf(zone, f.name) }));
				if (q) rows = rows.filter((f) => f.name.toLowerCase().includes(q) || (f.summary ?? '').toLowerCase().includes(q));
				if (zone !== 'daily' && sort === 'name') rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
				else rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
				return rows;
			};

			let timeline = [];
			for (const zone of ['functions', 'insights', 'capabilities', 'skills', 'daily'])
				for (const f of lists[zone]) timeline.push({ zone, name: f.name, bytes: f.bytes, mtime: f.mtime, summary: summaryOf(zone, f.name) });
			timeline.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
			timeline = timeline.slice(0, 12);

			const openFile = (zone, name) => {
				setView({ kind: 'file', zone: zone ?? '', name: name ?? null });
				setQuery('');
				setLive('');
			};
			// resolveHref may return { zone: 'bundle' } (a skill row pointing at a
			// host bundle); that opens the bundle view, everything else the reader.
			const navigate = (target) => {
				if (target.zone === 'bundle') {
					setView({ kind: 'bundle', name: target.name, tab: 'memory' });
					setQuery('');
					setLive('');
					return;
				}
				openFile(target.zone, target.name);
			};
			const back = () => {
				if (view.kind === 'file' && view.zone) setView({ kind: 'zone', zone: view.zone });
				else if (view.kind === 'bundle') setView({ kind: 'zone', zone: 'skills', tab: view.tab === 'host' ? 'host' : 'memory' });
				else setView({ kind: 'overview' });
			};

			const opened = view.kind === 'file' ? view : null;
			const fileUrl = !opened ? null : opened.zone === '' ? null : `${API}/file?zone=${opened.zone}&name=${enc(opened.name)}`;
			const fileRes = useApi(fileUrl, fixtures);
			const fileMeta = !opened ? null : opened.zone === '' ? null : (lists[opened.zone] ?? []).find((f) => f.name === opened.name) ?? null;
			const fileText = opened ? (opened.zone === '' ? indexText : fileRes.data?.text ?? null) : null;
			// zone → reader kind. The trailing fallback used to be 'daily', so ANY zone
			// not listed in the chain (dao/ when it was added) silently rendered as a
			// daily log: wrong reader, wrong section grouping, wrong empty-state copy.
			// Derived from ZONE_DIR so a new zone cannot fall through to the wrong
			// reader again.
			const kindOfZone = (z) => (z === '' ? 'index' : Object.prototype.hasOwnProperty.call(ZONE_DIR, z) ? z : 'daily');
			const kind = !opened ? null : kindOfZone(opened.zone);

			const activeKey = view.kind === 'overview' ? 'overview' : view.kind === 'inbox' ? 'inbox' : view.kind === 'zone' ? view.zone : view.kind === 'bundle' ? 'skills' : view.zone === '' ? 'index' : view.zone;

			const onKeyDown = (e) => {
				const tag = e.target?.tagName;
				const typing = tag === 'INPUT' || tag === 'TEXTAREA';
				if (e.key === '/' && !typing) {
					e.preventDefault();
					searchRef.current?.focus();
					return;
				}
				if (e.key === 'Escape') {
					if (query || live) {
						setQuery('');
						setLive('');
					} else if (view.kind !== 'overview') back();
					return;
				}
				if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && mainRef.current) {
					const rows = [...mainRef.current.querySelectorAll('[data-dmo="row"],[data-dmo="timeline-row"]')];
					if (!rows.length) return;
					e.preventDefault();
					const at = rows.indexOf(document.activeElement);
					const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
					rows[next === -1 ? 0 : next]?.focus();
				}
			};

			let main = null;
			if (live.length >= 2) main = h(SearchPane, { res: search, q: live, zone: searchZone, setZone: setSearchZone, onOpen: openFile });
			else if (!ws && overview.loading) main = h('div', { className: 'dmo-empty' }, '读取记忆体检…');
			else if (overview.error) main = h('div', { className: 'dmo-empty' }, `API 不可用：${overview.error}`);
			else if (!ws) main = h('div', { className: 'dmo-empty' }, '没有已注册的 workspace。');
			else if (!health?.initialized) main = h('div', { className: 'dmo-empty' }, '记忆还没有建立（`~/.dsh/memory/` 尚未创建）。让 Agent 做一次实质工作，它就会用 memory_write 写下第一份迭代。');
			else if (view.kind === 'inbox') main = h(InboxPane, { res: inboxRes, statusFilter: inboxFilter, setStatusFilter: setInboxFilter, onStateChange: () => setTick((n) => n + 1) });
			else if (view.kind === 'overview') main = h(Overview, { health, counts, timeline, usage: overview.data?.[0]?.usage, env: overview.data?.[0]?.env, prose: parseProseSections(indexText), preview, previewQ, setPreviewQ, onOpen: openFile, onZone: (z) => setView({ kind: 'zone', zone: z }), onNavigate: navigate });
			else if (view.kind === 'zone' && view.zone === 'skills')
				main = h(SkillLibrary, {
					data: skillLib.data, loading: skillLib.loading, error: skillLib.error,
					tab: view.tab === 'host' ? 'host' : 'memory',
					// The toggle is navigation: switching sides is a setView, not a
					// local useState — so both halves are reachable in a render test.
					onTab: (t) => setView({ kind: 'zone', zone: 'skills', tab: t }),
					onOpenMemory: (name) => setView({ kind: 'bundle', name, tab: 'memory' }),
					onOpenHost: (name) => setView({ kind: 'bundle', name, tab: 'host' }),
					onToggle: (name, next) => { void skillAction({ action: next, name }); },
					onDelete: (name) => { if (window.confirm(`删除技能「${name}」？整个目录包与索引行都会被移除，只能从 .history/ 或 git 找回旧正文。`)) void skillAction({ action: 'delete', name }); },
					actMsg,
					toggleBusy,
					filter, setFilter,
				});
			else if (view.kind === 'bundle') main = h(SkillBundleView, { data: bundleSkill, name: view.name, onBack: back, sel: view.file ?? null, onSel: (f) => setView({ kind: 'bundle', name: view.name, tab: view.tab, file: f }), fixtures });
			else if (view.kind === 'zone') main = h(ZoneList, { zone: view.zone, rows: rowsOf(view.zone), sort, setSort, filter, setFilter, onOpen: openFile });
			else if (fileText) main = h(Reader, { view, text: fileText, meta: fileMeta, kind, root: ws.root, onBack: back, onNavigate: navigate });
			else main = h('div', { className: 'dmo-empty' }, fileRes.loading ? '读取文件…' : fileRes.error ? `读取失败：${fileRes.error}` : '文件为空。');

			const searchIcon = h(
				'svg',
				{ viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'aria-hidden': true },
				[h('circle', { key: 'c', cx: 11, cy: 11, r: 7 }), h('path', { key: 'l', d: 'm20 20-3.5-3.5' })],
			);

			return h(
				'div',
				{ className: 'dmo-root', onKeyDown, 'data-dmo': 'root' },
				h('style', null, css),
				h(
					'div',
					{ className: 'dmo-header' },
					h('h1', { className: 'dmo-title' }, '记忆管理'),
					h('span', { className: 'dmo-sub' }, `${counts.functions ?? 0} 功能 · ${counts.insights ?? 0} 思想 · ${counts.capabilities ?? 0} 能力 · ${counts.skills ?? 0} 技能 · ${counts.daily ?? 0} 日线索`),
					h(
						'label',
						{ className: 'dmo-search', style: { marginLeft: 'auto', width: 240 } },
						searchIcon,
						h('input', {
							ref: searchRef, type: 'search', placeholder: '搜索全部记忆', value: query,
							onChange: (e) => setQuery(e.target.value), 'data-dmo': 'search',
						}),
						h('span', { className: 'dmo-kbd' }, '/'),
					),
					h(Btn, { tone: 'outline', onClick: () => setTick((n) => n + 1), title: '重新读取记忆' }, '刷新'),
					// Hot reload (5.25.0, the mechanism borrowed from our-free-model):
					// make the running SERVER half equal the code on disk without
					// restarting the host process. The swap disposes this plugin's
					// fibers and re-registers them — including the client bundle, so
					// after a successful reload the page still needs one refresh for
					// NEW CLIENT code (the server half is instantly live).
					h(
						Btn,
						{
							tone: 'outline',
							title: '让运行中的插件 server 半重新加载磁盘代码（不重启宿主进程）；client 半改动仍需刷新页面',
							disabled: reloading,
							onClick: async () => {
								setReloading(true);
								setReloadMsg('热重启中…');
								try {
									const r = await fetch(`${API}/reload`, { method: 'POST' });
									const j = await r.json().catch(() => ({}));
									if (!r.ok && r.status !== 202) throw new Error(j.error || `HTTP ${r.status}`);
									setReloadMsg('server 半已重载');
									setTimeout(() => setReloadMsg(''), 5000);
								} catch (err) {
									setReloadMsg(`热重启失败：${String(err?.message ?? err)}`);
								} finally {
									setReloading(false);
								}
							},
						},
						reloadMsg || '热重启',
					),
				),
				h(
					'div',
					{ className: 'dmo-body' },
					h(
						'div',
						{ className: 'dmo-rail' },
						NAV.map((n) => {
							// Every zone that reports a count shows one: capabilities and
							// skills were silently excluded before, so two rail rows read
							// as empty while holding real data.
							//
							// 收件箱的数值来自它自己的接口（不在 zone 计数里），且取的是
							// **未处理**数 —— 徽标该回答"有多少要我看"，已认领/已解决
							// 不该让它一直亮着。
							const inboxOpen = inboxRes.data?.counts?.open;
							const count =
								n.key === 'overview' || n.key === 'index'
									? null
									: n.key === 'inbox'
										? inboxOpen
										: counts[n.key];
							return h(
								'button',
								{
									key: n.key, type: 'button', 'data-dmo': 'nav-item',
									className: `dmo-nav${activeKey === n.key ? ' active' : ''}`,
									onClick: () => (n.key === 'overview' ? setView({ kind: 'overview' }) : n.key === 'inbox' ? setView({ kind: 'inbox' }) : n.key === 'index' ? openFile('', null) : setView({ kind: 'zone', zone: n.key })),
								},
								h('span', { className: 'ico' }, n.icon),
								n.label,
								// data-dmo 带上 key，ui-test 才能按目标精确断言"哪一项显示了数值"。
								Number.isFinite(count) && count > 0
									? h('span', { className: 'cnt', 'data-dmo': `nav-count-${n.key}` }, String(count))
									: null,
							);
						}),
						health?.initialized && (health.results ?? []).length
							? h('div', { style: { marginTop: 8, borderTop: '.5px solid var(--dsw-alias-border-l2)', paddingTop: 8 } },
									h('button', { type: 'button', className: 'dmo-nav', onClick: () => setView({ kind: 'overview' }) }, h('span', { className: 'ico' }, '⚠'), '体检有提示', h('span', { className: 'cnt' }, String((health.results ?? []).length))))
							: null,
					),
					h('div', { className: 'dmo-main', ref: mainRef, 'data-dmo': 'main' }, main),
				),
			);
		}

		function MemoryIcon({ size = 16 } = {}) {
			return h(
				'svg',
				{ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': true },
				[
					h('path', { key: 'f', d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10l2 2h6.5A1.5 1.5 0 0 1 20 7.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.5Z' }),
					h('path', { key: 'l', d: 'M8 12h8M8 16h5' }),
				],
			);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				// Sidebar icon; its registration id doubles as the main-panel dispatch
				// key (Plugin Manager's pattern). The icon renders as a bare 16px svg
				// so the shell's panelRow glyph (current-color, 28/36px button) owns
				// color and geometry.
				ctx.slots.inject('sidebar.panellist', () =>
					ctx.slots.register(
						{ name: 'sidebar.panellist', id: 'memory-panel', order: 50, label: '记忆管理' },
						MemoryIcon,
					),
				);
				ctx.slots.inject('main', () =>
					ctx.slots.register({ name: 'main', key: 'memory-panel' }, MemoryPanel),
				);
			},
			// Pure view logic, exposed so ui-test.mjs can assert the panel's
			// parsing/folding behaviour without a browser.
			__internalsForTest: { relTime, plain, parseIndexTables, parseProseSections, splitSections, subTablesOf, resolveHref, defaultOpen, SearchPane, RecallPreviewCard, reverseBullets, highlight, tokenizeCode },
		};
	},
});