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
	// 注册 id 必须等于宿主为「本包」建的那条客户端行 id —— 也就是包名。
	// 宿主按包名建客户端行，把 exports["./client"] 指向的文件当它的 bundle，
	// 加载后校验 `factories.has(包名)`；对不上就报 loaded without registering。
	//
	// 同一份面板有两种装法：独立装是 dsh-memory-manager，聚合装是 dsh-mind-system。
	// 聚合包那份的这一行由 scripts/build/rewrites.mjs 在构建时替换 —— 勿手改产物，
	// 改这里（源）：packages/dsh-memory-manager/client.js。
	//
	// 面板本身只依赖 inject:['slots'] 与槽位 id('memory-panel')，与注册 id 无关。
	id: 'dsh-mind-system',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const { useState, useEffect, useRef } = React;

		const API = '/api/memory-org';
		const enc = encodeURIComponent;

		const NAV = [
			{ key: 'overview', label: '总览', icon: '⌂' },
			// 架构图（2026-11-16 用户要求）：把五层结构、真实数据流和闭环画出来。
			// 它的每个数字都来自 /overview 的真实 counts/usage，不画不可观测的东西。
			{ key: 'arch', label: '架构', icon: '◈' },
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
.dmo-search{display:inline-flex;align-items:center;gap:6px;height:32px;box-sizing:border-box;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:var(--dsw-alias-bg-layer-1);min-width:200px}
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
.dmo-body{flex:1;display:flex;flex-direction:column;min-height:0;padding:0 20px 16px;gap:0}
/* Dashboard layout (2026-11-16): the left rail is gone — destinations read as a
   horizontal segmented bar under the header. The panel is a data surface that
   shows what the backend actually holds, not a workspace with a nav sidebar. */
.dmo-tabs{display:flex;align-items:center;gap:2px;flex-wrap:wrap;flex-shrink:0;padding:0 0 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-bottom:16px}
.dmo-tabs .dmo-nav{display:inline-flex;align-items:center;gap:6px;width:auto;padding:0 12px;height:32px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;text-align:left;transition:background .15s ease,color .15s ease}
.dmo-tabs .dmo-nav:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dmo-tabs .dmo-nav.active{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-weight:600}
.dmo-tabs .dmo-nav .ico{width:15px;text-align:center;color:inherit;opacity:.75}
.dmo-tabs .dmo-nav .cnt{margin-left:2px;font-size:11px;line-height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dmo-main{flex:1;min-width:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
/* ---- Dashboard surface (2026-11-16 redesign) -------------------------------
   Reference: huashu catalog web-13-glassmorphism-bento (Linear). What that style
   actually is, and what this block now implements:
     · near-black canvas + a soft violet glow bleeding down from the top edge
     · bento cards that are NOT equal height — a grid with explicit row spans
     · hairline borders that catch light (border-light on the top edge)
     · one hero measure per card, oversized, in a gradient wash
     · inner recessed panels inside a card, not just text on the card face
     Colors still ride host tokens so the panel keeps the host's palette, but the
     GLOW and the LAYERING are ours — that is what makes it read as a dashboard
     instead of a settings page. */
.dmo-root{position:relative;isolation:isolate}
.dmo-root::before{content:'';position:absolute;inset:0 0 auto;height:340px;pointer-events:none;z-index:0;background:
  radial-gradient(58% 100% at 50% 0%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent),transparent 72%),
  radial-gradient(42% 85% at 84% 0%,color-mix(in srgb,var(--dsw-alias-brand-text,#b59aff) 18%,transparent),transparent 68%),
  radial-gradient(30% 60% at 12% 0%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent),transparent 70%);
  opacity:1}
.dmo-header,.dmo-body{position:relative;z-index:1}
.dmo-bento{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:minmax(0,auto);grid-auto-flow:row dense;gap:14px;align-items:start}
.dmo-bento > .dmo-card{margin:0;min-width:0}
.dmo-span-3{grid-column:span 3}.dmo-span-4{grid-column:span 4}.dmo-span-5{grid-column:span 5}
.dmo-span-6{grid-column:span 6}.dmo-span-7{grid-column:span 7}.dmo-span-8{grid-column:span 8}
.dmo-span-9{grid-column:span 9}.dmo-span-12{grid-column:span 12}
/* Uneven heights are the point, but a card must never leave a hole under it:
   rows are sized by content and the grid keeps cards top-aligned. */
.dmo-rowspan-2{grid-row:span 2}
@container dmo-panel (max-width:1000px){.dmo-span-3,.dmo-span-4,.dmo-span-5{grid-column:span 6}.dmo-span-7,.dmo-span-8,.dmo-span-9{grid-column:span 12}}
@container dmo-panel (max-width:720px){.dmo-bento{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dmo-span-3,.dmo-span-4,.dmo-span-5,.dmo-span-6,.dmo-span-7,.dmo-span-8,.dmo-span-9,.dmo-span-12{grid-column:span 2}.dmo-rowspan-2{grid-row:span 1}}
/* Reset the older flat card face here: a bento card is a layered surface with a
   lit top edge, not a 1px box on the same plane as the page. */
.dmo-bento > .dmo-card{
  border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l3) 70%,transparent);
  border-top-color:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);
  border-radius:16px;
  padding:16px 18px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent),var(--dsw-alias-bg-layer-1));
  box-shadow:0 1px 0 0 color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent) inset,0 8px 24px -12px rgb(0 0 0 / .5);
  transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}
.dmo-bento > .dmo-card:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);box-shadow:0 1px 0 0 color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent) inset,0 12px 32px -14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
/* A hero measure: oversized gradient number + quiet label underneath. */
.dmo-measure{display:flex;flex-direction:column;gap:4px;min-width:0;position:relative}
.dmo-measure-v{font-size:34px;line-height:40px;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums;
  background:linear-gradient(135deg,var(--dsw-alias-label-primary) 12%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,var(--dsw-alias-label-primary)) 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.dmo-measure-l{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:500}
.dmo-measure-x{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* Section eyebrow: the small uppercase kicker above a card's measures. */
.dmo-eyebrow{font-size:10px;line-height:14px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.dmo-eyebrow::after{content:'';flex:1;height:.5px;background:linear-gradient(90deg,var(--dsw-alias-border-l2),transparent)}
/* ---- hero header (2026-11-16) --------------------------------------------
   The old header was one row: title + counters + search. The reference puts a
   kicker, a huge statement, and one supporting line in the upper third, with
   the status surface beside it. That hierarchy is what makes a page read as a
   dashboard rather than a table with a title bar. */
.dmo-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:14px 24px;padding:26px 26px 20px}
.dmo-hero{display:flex;flex-direction:column;gap:6px;min-width:0}
.dmo-hero-eyebrow{display:flex;align-items:center;gap:8px;font-size:11px;line-height:17px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dmo-pill{display:inline-flex;align-items:center;padding:0 7px;height:19px;border-radius:999px;font-size:10px;line-height:19px;letter-spacing:.02em;font-variant-numeric:tabular-nums;color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,var(--dsw-alias-label-primary));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}
.dmo-title{font-size:30px;line-height:38px;font-weight:680;letter-spacing:-.035em;margin:0;
  background:linear-gradient(180deg,var(--dsw-alias-label-primary),color-mix(in srgb,var(--dsw-alias-label-primary) 62%,transparent));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.dmo-sub{margin:0;max-width:62ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dmo-header-side{display:flex;flex-direction:column;align-items:flex-end;gap:10px;min-width:0}
.dmo-statusbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;padding:6px 12px;border-radius:999px;
  border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);backdrop-filter:blur(8px)}
.dmo-hero-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
/* NOTE: the header search is a plain flex label with a single input child plus
   two zero-width decorations. flex-wrap is deliberately unset here: wrapping
   moved the input to a second line and it rendered as an empty pill. */
.dmo-hero-actions .dmo-search{display:flex;align-items:center;flex-wrap:nowrap;width:300px;min-width:180px;height:36px;
  padding:0 14px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 75%,transparent);backdrop-filter:blur(10px)}
.dmo-hero-actions .dmo-search input{flex:1 1 auto;width:100%;min-width:0;color:var(--dsw-alias-label-primary);
  font-size:13px;font-family:inherit;line-height:1.4;appearance:none;background:transparent;border:none;outline:none;padding:0}
.dmo-hero-actions .dmo-search input::-webkit-search-cancel-button,.dmo-hero-actions .dmo-search input::-webkit-search-decoration{display:none}
.dmo-hero-actions .dmo-search input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
.dmo-hero-actions .dmo-search svg{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}
/* Recessed inner panel — the "card inside a card" the reference uses to hold
   content blocks (the editor pane there, the problem list here). */
.dmo-inset{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 65%,transparent);
  box-shadow:0 1px 0 0 color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent) inset}
/* Status dot + label, replacing bare chips in dense spots. */
.dmo-dot{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dmo-dot i{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex-shrink:0;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-tertiary) 16%,transparent)}
.dmo-dot.ok i{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.dmo-dot.warn i{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent)}
.dmo-dot.fail i{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
/* Sparkline: real series, no decoration. */
.dmo-spark{display:flex;align-items:flex-end;gap:3px;height:34px;margin-top:10px}
.dmo-spark b{flex:1;min-width:2px;border-radius:2px 2px 0 0;background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,transparent),color-mix(in srgb,var(--dsw-alias-state-business-primary) 25%,transparent))}
/* ---- live architecture view (2026-11-16) ----------------------------------
   Not an illustration: every node carries a count the server just returned, so
   the diagram and the numbers cannot disagree. Nodes open their zone. */
/* ---- architecture DIAGRAM (SVG, 2026-11-16) ------------------------------
   A drawn graph: boxes, directed edges with arrowheads, a feedback return arc.
   Stage edges remain neutral when historical data cannot establish health. */
.dmo-arch-svg{display:block;width:100%;height:auto;overflow:visible}
.dmo-node .dmo-node-box{fill:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent);
  stroke:color-mix(in srgb,var(--dsw-alias-border-l3) 85%,transparent);stroke-width:1;transition:stroke .16s ease,fill .16s ease}
.dmo-node.clickable{cursor:pointer}
.dmo-node.clickable:hover .dmo-node-box{stroke:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent);
  fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.dmo-node.accent .dmo-node-box{fill:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,var(--dsw-alias-bg-layer-2));
  stroke:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent)}
.dmo-node-tier{font-size:9px;letter-spacing:.08em;text-transform:uppercase;fill:var(--dsw-alias-label-dimmed);font-weight:600}
.dmo-node-name{font-size:12.5px;font-weight:650;fill:var(--dsw-alias-label-primary)}
.dmo-count-n{font-size:19px;font-weight:700;fill:var(--dsw-alias-state-business-primary);font-variant-numeric:tabular-nums}
.dmo-count-u{font-size:9.5px;fill:var(--dsw-alias-label-tertiary)}
.dmo-node-role{font-size:9.5px;fill:var(--dsw-alias-label-tertiary)}
.dmo-edge{fill:none;stroke-width:1.6}
.dmo-edge.business{stroke:var(--dsw-alias-state-business-primary)}
.dmo-edge.ok{stroke:var(--dsw-alias-state-success-primary)}
.dmo-edge.danger{stroke:var(--dsw-alias-state-error-primary);stroke-dasharray:5 4}
/* Degraded-but-alive (e.g. the SAG channel answers but rejects the key): a
   warning tone so it never reads as either working or dead. */
.dmo-edge.warn{stroke:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary));stroke-dasharray:5 4}
.dmo-edge.muted{stroke:color-mix(in srgb,var(--dsw-alias-label-dimmed) 85%,transparent);stroke-width:1.2}
.dmo-edge.dashed{stroke-dasharray:3 4}
.dmo-edge-label{font-size:9.5px;fill:var(--dsw-alias-label-tertiary)}
/* ---- index page: block-separated data view (2026-11-16) --------------------
   MEMORY.md holds seven blocks of different shapes. Rendering them as one run
   of bare tables read as an undifferentiated wall, so each block is now its own
   card with a tinted identity stripe, its own count, and a jump pill above. */
.dmo-idx-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;border-radius:12px;
  border:.5px solid var(--dsw-alias-border-l2);
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent),transparent)}
.dmo-idx-total{display:inline-flex;align-items:baseline;gap:4px;margin-right:4px;white-space:nowrap}
.dmo-idx-total b{font-size:22px;line-height:26px;font-weight:680;letter-spacing:-.02em;font-variant-numeric:tabular-nums;
  background:linear-gradient(135deg,var(--dsw-alias-label-primary) 15%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,var(--dsw-alias-label-primary)) 95%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.dmo-idx-total span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dmo-idx-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;cursor:pointer;font:inherit;
  font-size:11.5px;line-height:18px;border:.5px solid var(--dsw-alias-border-l3);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);color:var(--dsw-alias-label-secondary);
  transition:border-color .15s ease,color .15s ease,background .15s ease}
.dmo-idx-pill:hover{border-color:var(--tone,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary)}
.dmo-idx-pill-ico{opacity:.8}
.dmo-idx-pill-n{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dmo-idx-block{--tone:var(--dsw-alias-state-business-primary);
  position:relative;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 92%,transparent),var(--dsw-alias-bg-layer-1))}
/* Identity stripe: each block announces itself without shouting. */
.dmo-idx-block::before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:var(--tone);opacity:.85}
.dmo-idx-block.tone-a{--tone:var(--dsw-alias-state-business-primary)}
.dmo-idx-block.tone-b{--tone:var(--dsw-alias-brand-text,#b59aff)}
.dmo-idx-block.tone-c{--tone:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-state-warn-primary))}
.dmo-idx-block.tone-d{--tone:var(--dsw-alias-state-success-primary)}
.dmo-idx-block.tone-e{--tone:var(--dsw-alias-state-warn-primary)}
.dmo-idx-pill.tone-a{--tone:var(--dsw-alias-state-business-primary)}
.dmo-idx-pill.tone-b{--tone:var(--dsw-alias-brand-text,#b59aff)}
.dmo-idx-pill.tone-c{--tone:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-state-warn-primary))}
.dmo-idx-pill.tone-d{--tone:var(--dsw-alias-state-success-primary)}
.dmo-idx-pill.tone-e{--tone:var(--dsw-alias-state-warn-primary)}
.dmo-idx-block-head{display:flex;align-items:center;gap:9px;padding:13px 16px;flex-wrap:wrap;
  border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);
  background:color-mix(in srgb,var(--tone) 5%,transparent)}
.dmo-idx-block-ico{width:20px;height:20px;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;
  border-radius:6px;font-size:11px;background:color-mix(in srgb,var(--tone) 16%,transparent);color:var(--tone)}
.dmo-idx-block-title{font-size:14px;line-height:20px;font-weight:650;margin:0;letter-spacing:-.01em}
.dmo-idx-block-n{font-size:11px;line-height:17px;padding:0 7px;border-radius:999px;font-variant-numeric:tabular-nums;
  background:color-mix(in srgb,var(--tone) 14%,transparent);color:var(--tone)}
.dmo-idx-block-hint{margin-left:auto;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.dmo-idx-block-body{padding:6px 16px 14px}
.dmo-idx-sub{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);padding:10px 0 2px;letter-spacing:.02em}
.dmo-idx-table{margin:4px 0}
.dmo-idx-table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.dmo-idx-row{cursor:pointer}
.dmo-idx-row:hover td{background:color-mix(in srgb,var(--tone,var(--dsw-alias-state-business-primary)) 7%,transparent)}
.dmo-idx-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12.5px}
/* blockquote / list blocks inside an index block keep the reader's rhythm */
.dmo-arch-loop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dmo-arch-step{flex:1 1 130px;min-width:118px;display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:12px;
  border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 90%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 40%,transparent);opacity:.55}
.dmo-arch-step.on{opacity:1;border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 42%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent)}
.dmo-arch-step-n{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  font-size:10px;line-height:1;font-variant-numeric:tabular-nums;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-secondary)}
.dmo-arch-step.on .dmo-arch-step-n{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 25%,transparent);color:var(--dsw-alias-state-success-primary)}
.dmo-arch-step-name{font-size:12px;line-height:18px;font-weight:600}
.dmo-arch-step-d{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dmo-arch-cycle{font-size:11px;line-height:17px;padding:2px 9px;border-radius:999px;white-space:nowrap;
  border:.5px dashed var(--dsw-alias-border-l3);
  color:var(--dsw-alias-label-tertiary)}
.dmo-arch-cycle.closed{border-style:solid;border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);
  color:var(--dsw-alias-state-success-primary)}
/* Hero card: measure on top, quiet drill-in link pinned to the bottom edge. */
.dmo-hero-card{display:flex;flex-direction:column;gap:0}
.dmo-link{margin-top:auto;padding:8px 0 0;border:none;background:transparent;color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,var(--dsw-alias-label-secondary));font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer;transition:color .15s ease,gap .15s ease;display:inline-flex;align-items:center;gap:4px}
.dmo-link:hover{color:var(--dsw-alias-state-business-primary);text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
/* ---- shared surface (ALL pages, not just the overview) --------------------
   The first pass only restyled the overview, which left every other page on the
   old flat look. These rules are the single place the panel's surface is
   defined, so a zone list / reader / inbox reads as the same product as the
   dashboard: layered cards with a lit top edge, hairline rows instead of boxes,
   quiet empty states, pill controls. */
.dmo-card{border:.5px solid color-mix(in srgb,var(--dsw-alias-border-l3) 70%,transparent);
  border-top-color:color-mix(in srgb,var(--dsw-alias-label-primary) 13%,transparent);
  border-radius:14px;padding:16px 18px;
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 94%,transparent),var(--dsw-alias-bg-layer-1));
  box-shadow:0 1px 0 0 color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent) inset,0 6px 20px -14px rgb(0 0 0 / .45)}
.dmo-card.tight{padding:12px 14px}
.dmo-h2{font-size:13px;line-height:20px;font-weight:650;letter-spacing:-.01em;margin:0 0 10px;
  display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary)}
.dmo-h2::after{content:'';flex:1;height:.5px;background:linear-gradient(90deg,var(--dsw-alias-border-l2),transparent)}
/* Page header band: every non-overview page starts with one, so the eye lands
   in the same place as on the dashboard. */
.dmo-page-head{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;padding:2px 2px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-bottom:2px}
.dmo-page-title{font-size:21px;line-height:28px;font-weight:660;letter-spacing:-.025em;margin:0;
  background:linear-gradient(180deg,var(--dsw-alias-label-primary),color-mix(in srgb,var(--dsw-alias-label-primary) 66%,transparent));
  -webkit-background-clip:text;background-clip:text;color:transparent}
.dmo-page-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dmo-page-tools{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* Rows are hairlines, not cards: a list of 26 items must not become 26 boxes. */
.dmo-row{border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);transition:background .14s ease}
.dmo-row:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent)}
.dmo-row:last-child{border-bottom:none}
.dmo-toolbar{padding:2px 0 10px}
.dmo-filter{height:34px;border-radius:999px;padding:0 13px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);transition:border-color .15s ease,box-shadow .15s ease}
.dmo-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
  padding:44px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;
  border:.5px dashed color-mix(in srgb,var(--dsw-alias-border-l3) 80%,transparent);border-radius:14px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 35%,transparent)}
.dmo-btn{transition:background .15s ease,border-color .15s ease,color .15s ease}
.dmo-btn.outline{border-color:color-mix(in srgb,var(--dsw-alias-border-l3) 85%,transparent);border-radius:999px}
.dmo-btn.outline:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-state-business-primary)}
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
.dmo-empty{color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
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
/* Adapt to the panel width, including a narrow panel in a wide host window. */
.dmo-root{min-width:0;min-height:0;container-name:dmo-panel;container-type:inline-size}
/* NOTE: the header is a GRID (see the hero block above) — do not reintroduce a
   flex row here. The earlier flex override made the search box and the two
   header buttons stretch into full-height blocks, because grid children that
   were never given a size fell back to their flex item defaults. */
.dmo-header{grid-template-columns:minmax(0,1fr) auto;gap:16px 28px;padding:28px 26px 22px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dmo-header-side{align-items:flex-end;gap:12px}
.dmo-title{white-space:nowrap}
.dmo-search{min-width:160px;max-width:100%;height:36px;padding:0 10px;gap:8px;border-color:var(--dsw-alias-border-l3);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);backdrop-filter:blur(8px);transition:border-color .15s ease,box-shadow .15s ease}
.dmo-search:focus-within,.dmo-filter:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 25%,transparent)}
.dmo-body{padding:18px 24px 24px;min-width:0}.dmo-tabs{padding-bottom:12px;margin-bottom:18px;gap:4px}
.dmo-tabs .dmo-nav{min-height:34px;height:auto;padding:6px 13px;line-height:22px;flex-shrink:0;transition:background .15s ease,color .15s ease}
.dmo-tabs .dmo-nav.active{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.dmo-tabs .dmo-nav.active .ico{color:inherit}.dmo-tabs .dmo-nav .cnt{padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2)}
.dmo-main{gap:16px;overscroll-behavior:contain;scroll-padding:12px}.dmo-card{padding:18px}.dmo-card.tight{padding:12px 14px}.dmo-h2{font-size:15px;line-height:22px;margin-bottom:12px}
.dmo-growth{gap:10px}.dmo-gcard{flex-basis:145px;min-width:0;padding:14px;border-radius:var(--dsw-radius-lg);transition:background .15s ease,border-color .15s ease}.dmo-gcard:hover{border-color:var(--dsw-alias-border-l3)}
.dmo-gnum{font-size:24px;line-height:30px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.dmo-toolbar{gap:10px}.dmo-filter{height:36px;padding:0 10px}
.dmo-row,.dmo-row-btn{padding:12px 10px;border-radius:var(--dsw-radius-sm)}.dmo-row-top{min-width:0;gap:10px}.dmo-row-name{min-width:0;overflow-wrap:anywhere;font-weight:600}
.dmo-row-sum,.dmo-snippet{line-height:19px}.dmo-tl-row{padding:9px 10px}.dmo-tl-name{min-width:0;max-width:35%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmo-doc-head{gap:10px}.dmo-doc-title{font-size:16px;line-height:24px;overflow-wrap:anywhere}.dmo-toc,.dmo-toc-chips{gap:6px}
.dmo-sec{border-radius:var(--dsw-radius-lg)}.dmo-sec-head{min-height:44px;padding:10px 14px;font-weight:600}.dmo-sec-body{min-width:0;padding:10px 16px 14px}
.dmo-md{line-height:1.7;overflow-wrap:anywhere}.dmo-md p,.dmo-md ul{margin:8px 0}.dmo-md pre,.dmo-table-wrap{max-width:100%;box-sizing:border-box}.dmo-crumbs{flex-wrap:wrap;overflow-wrap:anywhere}
.dmo-row-btn:focus-visible,.dmo-row-del:focus-visible,.dmo-switch:focus-visible,.dmo-code-copy:focus-visible,.dmo-link:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
@media (max-width:720px){.dmo-header{padding:14px 12px 12px}.dmo-sub{flex-basis:100%;order:2}.dmo-hero-actions .dmo-search{width:100%;min-width:0}.dmo-header>.dmo-btn{order:4}.dmo-body{padding:12px}.dmo-tabs{overflow-x:auto;overflow-y:hidden;flex-wrap:nowrap;padding:0 2px 8px;gap:2px}.dmo-tabs .dmo-nav{width:auto;white-space:nowrap;flex:none}.dmo-tabs>div{flex:none;margin-top:0!important;border-top:0!important;padding-top:0!important}.dmo-main{min-height:0}.dmo-card{padding:14px}.dmo-tl-when{width:auto;min-width:52px}}
@container dmo-panel (max-width:720px){.dmo-header{padding:14px 12px 12px}.dmo-sub{flex-basis:100%;order:2}.dmo-hero-actions .dmo-search{width:100%;min-width:0}.dmo-header>.dmo-btn{order:4}.dmo-body{padding:12px}.dmo-tabs{overflow-x:auto;overflow-y:hidden;flex-wrap:nowrap;padding:0 2px 8px;gap:2px}.dmo-tabs .dmo-nav{width:auto;white-space:nowrap;flex:none}.dmo-tabs>div{flex:none;margin-top:0!important;border-top:0!important;padding-top:0!important}.dmo-main{min-height:0}.dmo-card{padding:14px}.dmo-tl-when{width:auto;min-width:52px}}
@media (prefers-reduced-motion:reduce){.dmo-root *,.dmo-root *::before,.dmo-root *::after{scroll-behavior:auto!important;transition-duration:0s!important;animation-duration:0s!important;animation-iteration-count:1!important}}
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
			// 月归档（2026-11 月/周折叠方案）：一个已归档月的旧链接（YYYY-MM.md）
			// 打开归档文件本身，而不是静默变成 null。
			if (/^\d{4}-\d{2}\.md$/.test(p)) return { zone: 'daily', name: p };
			if (p === 'MEMORY.md') return { zone: '', name: null };
			if (/^[^/]+\.md$/.test(p) && zone !== undefined) return { zone, name: p };
			return null;
		}

		/** Per-kind first-open policy: never dump 20KB of history on the reader. */
		/** Index sections that start expanded: the tables, and the dao list. */
		const INDEX_OPEN_RE = /^(功能模块索引|创新优化思想索引|道层|能力台账|技能台账)/;
		/** Sections pinned above the reversed history (see Reader's PIN_TOP). */
		const PINNED_TOP_RE = /^(当前状态摘要|头部摘要|状态摘要)/;
		function defaultOpen(kind, sections, text) {
			const open = {};
			const small = String(text ?? '').length < 4000;
			// Which section is the NEWEST block cannot be assumed to be index 0: the
			// head summary is pinned above the history, so index 0 is the summary
			// whenever one exists. Pick the last non-pinned section instead — that is
			// the newest iteration block under the append-only layout.
			let newest = -1;
			sections.forEach((s, i) => { if (!PINNED_TOP_RE.test(s.heading)) newest = i; });
			sections.forEach((s, i) => {
				if (kind === 'functions') open[i] = small || i === newest || PINNED_TOP_RE.test(s.heading);
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
		/**
		 * Freshness of the SSE channel, as three plain reads (no hook).
		 *
		 * WHY A MODULE BOX AND NOT A HOOK (2026-11-16, learned the hard way):
		 * the production fake-React harness (client-action-reconcile.test.js)
		 * allocates hooks POSITIONALLY and only replays effects whose single dep is
		 * an /api/memory-org/ URL. Both adding a hook AND wrapping useApi in a helper
		 * broke five real-panel tests. The channel therefore touches no hook slot:
		 * the stream effect bumps the existing `tick`, and anyone who needs the
		 * freshness numbers reads them here.
		 */
		const SSE_BOX = { payload: null, lastEventAt: null };

		/** `live` is a claim about FRESHNESS, not about having opened a socket. An
		 *  event older than 90s means the stream is dead even when no error fired
		 *  (a suspended tab or a buffering proxy does exactly that). */
		function sseFreshness() {
			const ageMs = Number.isFinite(SSE_BOX.lastEventAt) ? Date.now() - SSE_BOX.lastEventAt : null;
			return { live: ageMs !== null && ageMs < 90_000, ageMs };
		}

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

		function Card({ children, tight, className, ...rest }) {
			// Forward the remaining props. Several call sites tag cards with
			// `data-dmo="..."` and the test/panel rely on those hooks to find a
			// specific card; dropping them silently removed every such hook
			// (found on 2026-11-16 while wiring the SAG status card).
			return h('div', { ...rest, className: `dmo-card${tight ? ' tight' : ''}${className ? ` ${className}` : ''}` }, children);
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
		/**
		 * Index page: MEMORY.md is not one document, it is a dashboard of SEVEN
		 * separate blocks with different shapes (four tables, one bullet list, two
		 * prose blocks). Rendering them as one run of bare tables made the page read
		 * as a wall — no boundaries, no counts, no way to fold the part you are not
		 * reading. Each block now gets its own card with a count and a collapse
		 * control, so the page answers "what is in the index" at a glance.
		 */
		function IndexTables({ text, onNavigate }) {
			const { sections } = splitSections(text);
			// Block registry: heading prefix → block identity (tone + icon + kind).
			// Order here is the order the page renders, NOT the file order, so the
			// four structural blocks stay together and the prose blocks sink.
			const BLOCKS = [
				{ re: /^功能模块索引/, key: 'functions', name: '功能域', icon: '⬡', tone: 'a', hint: '可复跑的操作，一层一个文件' },
				{ re: /^创新优化思想索引/, key: 'insights', name: '创新优化思想', icon: '✦', tone: 'b', hint: '可重套的原则，回链来源功能域' },
				{ re: /^道层/, key: 'dao', name: '道', icon: '☯', tone: 'c', hint: '最抽象命题，由 ≥5 条法萃取' },
				{ re: /^能力台账/, key: 'capabilities', name: '能力台账', icon: '⚒', tone: 'd', hint: '外部工具 / MCP / CLI' },
				{ re: /^技能台账/, key: 'skills', name: '技能库', icon: '⌘', tone: 'd', hint: '结晶成宿主目录包的操作程序' },
				{ re: /^决策共识/, key: 'consensus', name: '决策共识 / 规范', icon: '§', tone: 'e', hint: '跨功能、约束级——违反即出事故' },
				{ re: /^环境常量/, key: 'env', name: '环境常量', icon: '⚑', tone: 'e', hint: '易忘的机器事实（路径、开关）' },
			];
			const blocks = [];
			for (const b of BLOCKS) {
				const sec = sections.find((s) => b.re.test(s.heading));
				if (!sec) continue;
				const tables = subTablesOf(sec);
				// Counting rule: a block's "how many items" must reflect what the block
				// actually holds, and MEMORY.md uses three shapes for the same idea —
				// table rows, bullet lines, and PROSE that carries inline links (道层 is
				// one quoted paragraph with `[name](dao/x.md)` inside it). Counting only
				// bullets reported 道 as 0 while the nav badge said 2 — the block said
				// the opposite of the truth. So: table rows > bullet lines > md links.
				let rows = 0;
				if (tables.length) {
					for (const t of tables) rows += Math.max(0, t.rows.length - 1);
				} else {
					const bullets = sec.body.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l)).length;
					const links = new Set((sec.body.match(/\]\([^)]+\.md\)/g) ?? []).map((m) => m.slice(1)));
					rows = bullets || links.size;
				}
				blocks.push({ ...b, sec, tables, rows });
			}
			if (!blocks.length) return null;
			const total = blocks.reduce((n, b) => n + b.rows, 0);
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 12 }, 'data-dmo': 'index-blocks' },
				// Summary strip: what the whole index holds, one number per block.
				h(
					'div',
					{ className: 'dmo-idx-summary', 'data-dmo': 'index-summary' },
					h('span', { className: 'dmo-idx-total' }, [h('b', { key: 'n' }, String(total)), h('span', { key: 'u' }, ' 条索引项')]),
					blocks.map((b) =>
						h(
							'button',
							{ key: `s${b.key}`, type: 'button', className: `dmo-idx-pill tone-${b.tone}`, onClick: () => onNavigate && document.getElementById(`dmo-idx-${b.key}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), title: b.hint, 'data-dmo': `index-pill-${b.key}` },
							h('span', { className: 'dmo-idx-pill-ico' }, b.icon),
							b.name,
							h('span', { className: 'dmo-idx-pill-n' }, String(b.rows)),
						),
					),
				),
				blocks.map((b) =>
					h(
						'div',
						{ key: b.key, id: `dmo-idx-${b.key}`, className: `dmo-idx-block tone-${b.tone}`, 'data-dmo': `index-block-${b.key}` },
						h(
							'div',
							{ className: 'dmo-idx-block-head' },
							h('span', { className: 'dmo-idx-block-ico' }, b.icon),
							h('h3', { className: 'dmo-idx-block-title' }, b.name),
							h('span', { className: 'dmo-idx-block-n' }, `${b.rows} 条`),
							h('span', { className: 'dmo-idx-block-hint' }, b.hint),
						),
						b.tables.length
							? h(
									'div',
									{ className: 'dmo-idx-block-body' },
									b.tables.map((t, ti) => {
										const rows = t.rows.slice();
										const head = rows.shift() ?? [];
										return h(
											'section',
											{ key: `t${ti}` },
											// Only show a sub-title when the parent section was split.
											b.tables.length > 1 && t.title !== b.sec.heading
												? h('div', { className: 'dmo-idx-sub' }, t.title.replace(`${b.sec.heading} · `, ''))
												: null,
											h(
												'table',
												{ className: 'dmo-table dmo-idx-table' },
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
								)
							: h('div', { className: 'dmo-idx-block-body' }, h(MarkdownBody, { text: b.sec.body, zone: '', onNavigate })),
					),
				),
			);
		}

		// ---------------------------------------------------------------------
		// reader
		// ---------------------------------------------------------------------

		function Section({ index, section, open, onToggle, zone, onNavigate, registerRef, preserveOrder }) {
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
				open ? h('div', { className: 'dmo-sec-body' }, h(MarkdownBody, { text: preserveOrder ? section.body : reverseBullets(section.body), zone, onNavigate })) : null,
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
				const rel = view.candidate ? `dao/_candidates/${fileName}` : view.zone === '' ? 'MEMORY.md' : `${ZONE_DIR[view.zone] ? `${ZONE_DIR[view.zone]}/` : ''}${fileName}`;
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
			//
			// EXCEPTION — pinned sections (2026-11-19, reported from the live panel):
			// a blind reverse moved 「当前状态摘要」 to the BOTTOM of the page, because
			// it is a `## ` section like any other. That is backwards: the head
			// summary DESCRIBES the current state and must be read first, while the
			// iteration blocks below it are history. Same for 「早期演化」, which is the
			// collapsed remainder and belongs last, not second.
			//
			// So: pinned-to-top sections keep their position above the reversed run;
			// pinned-to-bottom ones stay at the end. Only the iteration history
			// (everything else) is reversed. Tested in ui-test.
			const PIN_TOP = /^(当前状态摘要|头部摘要|状态摘要)/;
			const PIN_BOTTOM = /^(早期演化|历史原貌)/;
			const top = [];
			const middle = [];
			const bottom = [];
			sections.forEach((s, i) => {
				if (PIN_TOP.test(s.heading)) top.push({ s, i });
				else if (PIN_BOTTOM.test(s.heading)) bottom.push({ s, i });
				else middle.push({ s, i });
			});
			const shown = view.candidate ? [...top, ...middle, ...bottom] : [...top, ...middle.reverse(), ...bottom];
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
				// The index page is FULLY rendered by IndexTables (every block, tables and
				// prose alike). Rendering the non-table sections again here duplicated the
				// consensus/env blocks and left them outside their blocks' styling.
				kind === 'index'
					? null
					: h(
							'div',
							{ style: { display: 'flex', flexDirection: 'column', gap: 6 } },
							shown.map(({ s, i }) => h(Section, { key: `${s.heading}-${i}`, index: i, section: s, open: Boolean(open[i]), onToggle: (x) => setOpen((m) => ({ ...m, [x]: !m[x] })), zone: view.zone, onNavigate, registerRef, preserveOrder: Boolean(view.candidate) })),
						),
			);
		}

		// ---------------------------------------------------------------------
		// overview / lists / search
		// ---------------------------------------------------------------------

		// Snapshot is per plugin instance and never establishes capture health.
		// Only render fixed labels and numeric values: the API must not leak IDs,
		// paths, raw exception messages, or unrecognised labels into this card.
		function CaptureStatus({ capture }) {
			const data = capture && typeof capture === 'object' && !Array.isArray(capture) ? capture : null;
			const count = (key) => Number.isSafeInteger(data?.[key]) && data[key] >= 0 ? data[key] : null;
			const fmt = (key) => count(key) === null ? '未知' : String(count(key));
			const enabled = data?.enabled === true ? '已启用' : data?.enabled === false ? '未启用' : '未知';
			const observed = count('observed');
			const observations = data?.hasObservations === false && observed === 0
				? '本实例尚无观测样本，无法判断采集是否正常。'
				: data?.hasObservations === true && observed !== null && observed > 0
					? `本实例已观察 ${observed} 条事件，结果仅反映已观察的样本。`
					: '观测状态未知，无法判断采集是否正常。';
			const capacity = data?.saturated === true || (count('skippedCapacity') ?? 0) > 0
				? '观察容量不足或计数已饱和，统计不完整。'
				: data?.saturated === false && count('skippedCapacity') !== null
					? null : '观察容量状态未知。';
			const codes = {
				MEMORY_STAGE_OUTCOME_UNKNOWN: '暂存结果未知', MEMORY_WRITE_COMMIT_UNKNOWN: '写入结果未知',
				MEMORY_LEDGER_APPEND_FAILED: '记账结果未知', MEMORY_LEDGER_UNREADABLE: '账本不可读',
				MEMORY_DELETE_INTENT_PENDING: '存在未完成删除', MEMORY_CAPTURE_LOCK_BUSY: '采集锁占用',
				MEMORY_CAPTURE_LOCK_TIMEOUT: '采集锁等待超时', MEMORY_CAPTURE_LOCK_UNKNOWN: '采集锁状态未知',
				MEMORY_CAPTURE_LOCK_RELEASE_UNKNOWN: '采集锁释放结果未知',
				CAPTURE_MUTEX_UNAVAILABLE: '采集锁不可用', CAPTURE_MUTEX_UNSAFE_PATH: '采集锁路径不安全',
				CAPTURE_MUTEX_SENTINEL_CLOSE_UNKNOWN: '锁文件关闭结果未知', CAPTURE_MUTEX_OPEN_FAILED: '采集锁打开失败',
				CAPTURE_MUTEX_ACQUIRE_FAILED: '采集锁获取结果未知', CAPTURE_MUTEX_BUSY: '采集锁占用', CAPTURE_MUTEX_CLOSE_UNKNOWN: '采集锁释放结果未知',
				CAPTURE_BASELINE_UNVERIFIED: '原记录无法对账', CAPTURE_INTENT_PENDING: '存在未完成采集',
				CAPTURE_INTENT_UNKNOWN: '采集意图结果未知', CAPTURE_FINALIZE_UNKNOWN: '采集意图清理结果未知',
				CAPTURE_HISTORY_ENCODING: '原记录编码无法无损保留', CAPTURE_HISTORY_REDACTION: '原记录脱敏会改变历史',
				CAPTURE_INPUT_REDACTION: '采集内容需要进一步脱敏', CAPTURE_UNSAFE_DAILY: '每日记录路径不安全', OTHER: '其他',
			};
			const stages = { source: '来源', select: '筛选', schedule: '调度', lock: '互斥', read: '读取', dedupe: '去重', stage: '暂存', commit: '提交', ledger: '记账', cleanup: '清理', OTHER: '其他' };
			const bins = (value, labels) => {
				if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
				if (Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(labels, key))) return null;
				const parts = [];
				for (const [key, label] of Object.entries(labels)) {
					const n = value[key];
					if (!Number.isSafeInteger(n) || n < 0) return null;
					if (n > 0) parts.push(`${label} ${n}`);
				}
				return parts;
			};
			const codeDetails = bins(data?.errorCodes, codes);
			const stageDetails = bins(data?.errorStages, stages);
			const detail = (items) => items === null ? '未知' : items.length ? items.join(' · ') : '无已记录明细';
			return h(Card, null,
				h(CardTitle, null, '每日采集状态'),
				h('section', { role: 'status', 'aria-label': '每日采集状态', 'aria-live': 'polite', 'data-dmo': 'capture-status' },
					h('div', null, `采集：${enabled}`),
					h('div', { className: 'dmo-meta' }, observations),
					h('div', null, `尝试 ${fmt('scheduled')} · 确认 ${fmt('confirmed')} · 失败 ${fmt('failed')} · 待处理 ${fmt('pending')}`),
					h('div', { className: 'dmo-meta' }, `已选择 ${fmt('selected')} · 重复 ${fmt('duplicate')} · 冲突 ${fmt('conflict')}`),
					h('div', { className: 'dmo-meta' }, `来源跳过 ${fmt('skippedSource')} · 缺少标识跳过 ${fmt('skippedMissingId')} · 统计容量溢出 ${fmt('skippedCapacity')}`),
					capacity ? h('div', { className: 'dmo-meta' }, capacity) : null,
					h('div', { className: 'dmo-meta' }, `失败类别：${detail(codeDetails)}；发生阶段：${detail(stageDetails)}`),
					h('div', { className: 'dmo-meta' }, data?.intentWitness === 'present'
						? '发现未完成的采集意图，后续采集会停写；需先核查，不能自动删除。'
						: data?.intentWitness === 'not_seen'
							? '当前未发现采集意图文件；这不能证明历史上没有未完成操作。'
							: '采集意图现场状态未知。'),
					h('div', { className: 'dmo-meta' }, data?.resetOnNewInstance === true
						? '仅统计当前实例；插件重新加载或实例重建后计数清零，不代表历史记录。'
						: '统计的实例范围或重载后的状态未知。'),
				),
			);
		}

		/**
		 * Build the live architecture model from REAL server data only.
		 *
		 * Why a pure function: the panel must not draw a diagram that disagrees
		 * with the numbers beside it. Everything here comes from /overview
		 * (counts / usage / capture / env); a layer with no files still appears
		 * (an empty layer is a fact, not an omission), and anything the server
		 * cannot testify to is marked unknown rather than filled in.
		 *
		 * 数据流（写入方向，自下而上）：
		 *   每日原始记录 → functions 迭代块 → insights 原则 → dao 命题
		 * 召回方向（读取，自上而下）：dao/insights/functions 被 pre-step 钩子注入
		 * 闭环：写入 → 索引 → 召回 → 命中/纠正信号 → 下一轮阈值与分层
		 */
		const knownCount = (value) => Number.isFinite(value) ? value : null;
		const displayCount = (value) => knownCount(value) ?? '未知';

		function buildArchitecture({ counts, usage, capture, env, health, sag, cycleCoverage, runtimeSnapshot, patrolDelivery }) {
			const c = counts ?? {};
			const n = knownCount;
			// 五个层：真实数量 + 该层在当前体系里的角色。role 是静态说明，
			// count 全部来自后端。
			const layers = [
				{ key: 'daily', name: '每日原始记录', count: n(c.daily), unit: '份', role: '第 0 层：原始素材，不蒸馏', tier: 'L0' },
				{ key: 'functions', name: '功能域', count: n(c.functions), unit: '个', role: '术：可复跑的操作', tier: 'L2' },
				{ key: 'insights', name: '创新优化思想', count: n(c.insights), unit: '条', role: '法：可重套的原则', tier: 'L1' },
				{ key: 'dao', name: '道', count: n(c.dao), unit: '条', role: '最抽象命题', tier: 'L0d' },
				{ key: 'capabilities', name: '能力台账', count: n(c.capabilities), unit: '项', role: '外部工具索引', tier: 'L2c' },
			];
			const activeLayers = layers.every((l) => l.count !== null) ? layers.filter((l) => l.count > 0).length : null;
			//
			// 口径纪律（2026-11-16 用户追问"4372 条信号真实吗"后修正）：
			// usage.signalCount 是 .usage.jsonl 的**事件行数**，其中绝大多数是
			// recall 曝光（每次注入记一条、同一文件会重复几百次）。它是"曝光量"，
			// 不是"索引条目数"，也不是"被采纳数"。索引规模另有来源：indexRows。
			// 两者混用会让图把曝光吹成规模——所以这里分开存、分开标。
			const signals = n(usage?.signalCount);
			const recallEvents = n(usage?.recallEvents);
			const distinctHrefs = n(usage?.distinctHrefs);
			const indexRows = n(usage?.indexRows);
			const hasCapture = typeof capture?.enabled === 'boolean' ? capture.enabled : null;
			// Historical stock and aggregate events do not verify any stage or loop.
			const loop = [
				{ key: 'write', name: '写入', ok: null, detail: `${displayCount(n(c.daily))} 份原始 + ${displayCount(n(c.functions))} 个功能域 · 运行未验证` },
				{ key: 'distill', name: '蒸馏', ok: null, detail: `${displayCount(n(c.insights))} 条原则 / ${displayCount(n(c.dao))} 条道 · 运行未验证` },
				{ key: 'recall', name: '召回', ok: null, detail: `索引 ${displayCount(indexRows)} 行 · 运行未验证` },
				{ key: 'feedback', name: '反馈', ok: null, detail: `${displayCount(recallEvents)} 条召回曝光 · 正向/纠正 ${displayCount(n(usage?.verdictEvents))} 次 · 回流未验证` },
			];
			const loopClosed = null;
			// 存储根：只报服务器实际解析出来的路径。
			const roots = [
				{ key: 'memory', name: '记忆根', path: env?.memoryRoot ?? '', active: Boolean(env?.memoryRoot) },
				{ key: 'skills', name: '技能库', path: env?.skillRoot ?? '', active: Boolean(env?.skillRoot) },
			];
			return {
				layers,
				cycleCoverage,
				runtimeSnapshot,
				patrolDelivery,
				activeLayers,
				loop,
				loopClosed,
				roots,
				// Exposure vs. size are different facts and must never share a label:
				// signals/recallEvents count EVENTS (recall fires once per injection),
				// indexRows/distinctHrefs measure how much content actually exists.
				signals,
				recallEvents,
				distinctHrefs,
				indexRows,
				verdicts: n(usage?.verdictEvents),
				reads: n(usage?.readEvents),
				captureOn: hasCapture,
				health: { fail: n(health?.failCount), warn: n(health?.warnCount) },
				indexBytes: n(env?.indexBytes),
				indexComfort: n(env?.indexComfortBytes),
				version: env?.version ?? '',
				// Second recall channel (SAG). Three facts stay separate because they
				// fail for different reasons and need different fixes: no key →
				// configure it; service down → start it; unauthorized → rotate the key.
				// Collapsing them into one "unavailable" badge hides which one broke.
				sag: {
					configured: typeof sag?.configured === 'boolean' ? sag.configured : null,
					online: typeof sag?.online === 'boolean' ? sag.online : null,
					authorized: typeof sag?.authorized === 'boolean' ? sag.authorized : null,
					endpoint: typeof sag?.endpoint === 'string' ? sag.endpoint : '',
					// "usable" is what the diagram colours by: a channel can be online
					// yet unusable without a key, and that must show as degraded.
					usable: sag?.online === true && sag?.authorized === true,
					// unknown = the server did not report the field at all (e.g. an older
					// server half). Unknown must not be drawn as "working".
					known: sag !== undefined && sag !== null,
				},
			};
		}

		/**
		 * The live architecture view: real layers, real flow, real loop state.
		 * Deliberately a data view, not an illustration — every badge carries a
		 * number the server just returned, and unknown stays unknown.
		 */
		/**
		 * Live architecture diagram — a REAL drawing (SVG), not a row of cards.
		 *
		 * Layout (all coordinates fixed, viewBox 0 0 1120 600):
		 *   band 1  y  20- 82   来源：会话 / 外部知识库
		 *   band 2  y 150-228   蒸馏链：每日 → 功能 → 思想 → 道   (+ 台账/技能 支撑面)
		 *   band 3  y 296-366   索引 MEMORY.md（派生物，各层收行于此）
		 *   band 4  y 432-512   会话上下文 ← 召回准入 ← 使用信号（闭环三段）
		 *   return  y 540       反馈回流弧（闭环的第四段）
		 *
		 * Nodes show server counts; structural edges show direction without claiming
		 * that historical counts verify stage health or a closed loop.
		 */
		function Architecture({ model, onZone, live, lastEventAt, fallback }) {
			const m = model ?? buildArchitecture({});
			// Freshness is part of the data, not a decoration: an event older than
			// ~90s means the stream is likely dead even if it never emitted `error`
			// (a killed proxy or a suspended tab does exactly that).
			const ageMs = Number.isFinite(lastEventAt) ? Date.now() - lastEventAt : null;
			const liveMode = Boolean(live) && ageMs !== null && ageMs < 90_000;
			const view = {
				...m,
				liveMode,
				lastEventAge: ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000)),
				fallbackMode: Boolean(fallback) || !liveMode,
			};
			return renderArchitecture(view, onZone);
		}

		/**
		 * Which diagram nodes are legitimate destinations, and where they lead.
		 *
		 * THE BUG THIS FIXES (2026-11-16, user report: "功能图块点击跳转空白页"):
		 * every node was clickable and its key was passed straight to
		 * setView({kind:'zone', zone:key}). But only daily/functions/insights/dao/
		 * capabilities are real zones — `index`, `ctx`, `gate`, `sig` and the two
		 * source boxes are diagram concepts. For those, the zone page looked up
		 * {functions:…}[key] → undefined, so none of its branches matched and `main`
		 * stayed null: a blank page with no message and no way back.
		 *
		 * THE RULE: a node is clickable only if it maps to something that exists.
		 * `index` has a real page (the index view, zone ''), so it maps there —
		 * the rest are not links and must not pretend to be.
		 */
		const ARCH_NODE_TARGET = {
			daily: { kind: 'zone', zone: 'daily' },
			functions: { kind: 'zone', zone: 'functions' },
			insights: { kind: 'zone', zone: 'insights' },
			dao: { kind: 'zone', zone: 'dao' },
			capabilities: { kind: 'zone', zone: 'capabilities' },
			// The index node is the MEMORY.md registry. Its page is a zone view with an
			// EMPTY zone name (the panel's existing convention: zone '' === index), not
			// a `kind:'index'` view — that kind belongs to the Reader, not the router.
			index: { kind: 'zone', zone: '' },
			// src / sag / ctx / gate / sig are structure, not destinations.
		};

		function RuntimeSnapshot({ snapshot, current = false }) {
			const states = { ready: '可用', partial: '部分可用', disabled: '已禁用', unavailable: '不可用', missing: '缺失', error: '读取错误' };
			const state = snapshot == null ? '缺失' : states[snapshot?.state] ?? '未知';
			const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : null;
			const tasks = Array.isArray(snapshot?.registeredTasks?.taskIds) ? snapshot.registeredTasks.taskIds : null;
			const text = (value) => typeof value === 'string' && value ? value : '未知';
			const timestamp = (value) => Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : text(value);
			const truncated = (value, locallyTruncated) => value === true || locallyTruncated ? '已截断' : value === false ? '未截断' : '未知';
			return h('div', { className: 'dmo-inset', style: { marginTop: 8 }, 'data-dmo': 'runtime-snapshot' },
				h('div', { className: 'dmo-measure-l' }, current ? '当前运行时快照' : '周检历史运行时快照'),
				h('div', { className: 'dmo-measure-x' }, `状态：${state}`),
				typeof snapshot?.error === 'string' ? h('div', { className: 'dmo-measure-x' }, `错误：${snapshot.error}`) : null,
				h('div', { className: 'dmo-measure-x' }, `运行记录截断：${truncated(snapshot?.truncated, runs?.length > 50)}`),
				runs === null ? h('div', { className: 'dmo-measure-x' }, '运行记录：未知') : runs.length === 0 ? h('div', { className: 'dmo-measure-x' }, '快照中无运行记录') : runs.slice(0, 50).map((run, index) =>
					h('div', { key: index, className: 'dmo-measure-x' },
						`任务：${text(run?.taskId)} · 状态：${text(run?.status)} · 原因：${text(run?.reason)} · 注册：${run?.registered === true ? '是' : run?.registered === false ? '否' : '未知'}`,
						h('div', null, `创建：${timestamp(run?.createdAt)} · 更新：${timestamp(run?.updatedAt)}`),
						h('div', null, `未解决数量：${Number.isFinite(run?.unresolved?.count) ? run.unresolved.count : '未知'} · 首个尝试 ID：${text(run?.unresolved?.first?.attemptId)} · 尝试状态：${text(run?.unresolved?.first?.status)}`),
					),
				),
				h('div', { className: 'dmo-measure-x' }, `已注册任务截断：${truncated(snapshot?.registeredTasks?.truncated, tasks?.length > 50)}`),
				h('div', { className: 'dmo-measure-x' }, `已注册任务：${tasks === null ? '未知' : tasks.length === 0 ? '快照中无' : tasks.slice(0, 50).map(text).join('、')}`),
			);
		}

		function CycleCoverage({ coverage, patrolDelivery }) {
			const deliveryLabels = {
				starting: '正在启动', unavailable: '投递服务不可用', unknown: '未知：数据缺失或无法读取',
				unsupported_report: '报告格式不受支持', no_candidates: '没有待投递的候选',
				delivered: '已写入收件箱，不代表已读或已确认', retrying: '投递失败，正在重试',
			};
			const deliveryStatus = Object.hasOwn(deliveryLabels, patrolDelivery?.status) ? deliveryLabels[patrolDelivery.status] : deliveryLabels.unknown;
			const status = coverage?.status;
			const report = coverage?.report;
			const statusLabels = { observed: '已观察到历史证据', unknown: '未知', error: '读取错误', incomplete: '证据不完整' };
			const rows = [
				['定时投递', report?.micro_execution?.schedule_delivery],
				['执行结果', report?.micro_execution?.outcome],
				['记忆蒸馏', report?.memory?.distillation],
				['记忆索引', report?.memory?.index],
				['记忆召回', report?.memory?.recall],
				['治理决策', report?.governance?.decisions],
				['跨步骤关联', report?.cross_step_correlation],
			];
			const message = status === 'unavailable' ? '周检服务不可用，无法读取覆盖报告。'
				: status === 'missing' ? '最近一次周检没有覆盖报告。'
				: status === 'available' && report && typeof report === 'object' && !Array.isArray(report) ? null
				: '覆盖报告状态未知或无法读取。';
			return h(Card, { 'data-dmo': 'cycle-coverage' },
				h('div', { className: 'dmo-eyebrow' }, '自动周检 · 闭环证据覆盖'),
				h('div', { className: 'dmo-inset', 'data-dmo': 'patrol-delivery' },
					h('div', { className: 'dmo-measure-l' }, '周检候选投递'),
					h('div', { className: 'dmo-measure-x' }, `状态：${deliveryStatus}`),
					typeof patrolDelivery?.reason === 'string' ? h('div', { className: 'dmo-measure-x' }, `原因：${patrolDelivery.reason}`) : null,
					typeof patrolDelivery?.error === 'string' ? h('div', { className: 'dmo-measure-x' }, `错误：${patrolDelivery.error}`) : null,
					typeof patrolDelivery?.reportId === 'string' ? h('div', { className: 'dmo-measure-x' }, `报告 ID：${patrolDelivery.reportId}`) : null,
				),
				h('div', { className: 'dmo-measure-x' }, `周检时间：${typeof coverage?.at === 'string' ? coverage.at : '未知'} · ${coverage?.ok === false ? '周检失败' : coverage?.ok === true ? '周检报告执行成功' : '周检结果未知'}`),
				h('div', { className: 'dmo-measure-x' }, '各项是历史观测，单项证据不证明同一工作完成闭环。'),
				message ? h('div', { className: 'dmo-inset' }, message) : rows.map(([name, evidence]) => {
					const state = typeof evidence?.status === 'string' ? evidence.status : 'unknown';
					return h('div', { key: name, className: 'dmo-inset', style: { marginTop: 8 } },
						h('div', { className: 'dmo-measure-l' }, name),
						h('div', { className: 'dmo-measure-x' }, `状态：${statusLabels[state] ?? state}`),
						typeof evidence?.reason === 'string' ? h('div', { className: 'dmo-measure-x' }, `原因：${evidence.reason}`) : null,
						typeof evidence?.scope === 'string' ? h('div', { className: 'dmo-measure-x' }, `范围：${evidence.scope}`) : null,
						typeof evidence?.observed === 'boolean' ? h('div', { className: 'dmo-measure-x' }, `历史证据已观察：${evidence.observed ? '是' : '否'}`) : null,
						typeof evidence?.tracked_function_write_observed === 'boolean' ? h('div', { className: 'dmo-measure-x' }, `已观察到受追踪的功能域写入：${evidence.tracked_function_write_observed ? '是' : '否'}`) : null,
						typeof evidence?.note === 'string' ? h('div', { className: 'dmo-measure-x' }, evidence.note) : null,
					);
				}),
				!message ? h(RuntimeSnapshot, { snapshot: report?.micro_execution?.runtime_snapshot }) : null,
			);
		}

		function renderArchitecture(m, onZone) {
			const W = 1120;
			const H = 600;
			const stage = () => null;
			// Historical counts do not establish stage health.
			const tone = () => 'dmo-edge muted dashed';

			const node = (key, { x, y, w, h: bh, name, count, unit, role, tier, accent }) => {
				const cx = x + w / 2;
				// Clickable ONLY when the node has a real destination. A node with no
				// page must not look or behave like a link — that is what produced the
				// blank page and the dead-end feel (2026-11-16).
				const target = ARCH_NODE_TARGET[key];
				const canClick = Boolean(onZone) && Boolean(target);
				return h(
					'g',
					{
						key, className: `dmo-node${canClick ? ' clickable' : ''}${accent ? ' accent' : ''}`,
						'data-dmo': `arch-node-${key}`,
						'onClick': canClick ? () => onZone(target) : undefined,
						...(canClick ? { role: 'button', tabIndex: 0 } : {}),
					},
					h('title', null, `${name}${tier ? `（${tier}）` : ''}：${role ?? ''}`),
					h('rect', { x, y, width: w, height: bh, rx: 10, className: 'dmo-node-box' }),
					tier ? h('text', { x, y: y + 15, className: 'dmo-node-tier', textAnchor: 'middle' }, tier) : null,
					h('text', { x: cx, y: y + (tier ? 33 : 24), className: 'dmo-node-name', textAnchor: 'middle' }, name),
					count !== undefined
						? h('text', { x: cx, y: y + (tier ? 55 : 46), className: 'dmo-node-count', textAnchor: 'middle' }, [
								h('tspan', { key: 'n', className: 'dmo-count-n' }, String(displayCount(count))),
								unit ? h('tspan', { key: 'u', className: 'dmo-count-u', dx: 3 }, unit) : null,
							])
						: null,
					role ? h('text', { x: cx, y: y + bh - 10, className: 'dmo-node-role', textAnchor: 'middle' }, role.length > 16 ? `${role.slice(0, 15)}…` : role) : null,
				);
			};

			const label = (key, x, y, text) => h('text', { key, x, y, className: 'dmo-edge-label', textAnchor: 'middle' }, text);

			// The second channel's edge/marker must follow its real state. Unknown is
			// deliberately the muted style — an unreported channel is not evidence
			// that it works.
			const sagEdgeClass = () => {
				if (!m.sag.known) return 'dmo-edge muted dashed';
				if (m.sag.usable) return 'dmo-edge ok';
				if (m.sag.online === null || (m.sag.online && m.sag.authorized === null)) return 'dmo-edge muted dashed';
				if (m.sag.online === true && m.sag.authorized === false) return 'dmo-edge warn dashed';
				return 'dmo-edge danger dashed';
			};
			const sagMarker = () => {
				if (!m.sag.known) return 'url(#dmo-ah-m)';
				if (m.sag.usable) return 'url(#dmo-ah-ok)';
				if (m.sag.online === null || (m.sag.online && m.sag.authorized === null)) return 'url(#dmo-ah-m)';
				if (m.sag.online === true && m.sag.authorized === false) return 'url(#dmo-ah-m)';
				return 'url(#dmo-ah-d)';
			};

			const layers = Object.fromEntries(m.layers.map((l) => [l.key, l]));
			const nOf = (k) => layers[k]?.count ?? null;

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 14 } },
				h(
					'div',
					{ className: 'dmo-page-head' },
					h('h2', { className: 'dmo-page-title' }, '实时架构'),
					h('span', { className: 'dmo-page-sub' }, `${displayCount(m.activeLayers)} / ${m.layers.length} 层有内容 · 闭环未验证`),
					h(
						'span',
						{ className: 'dmo-page-tools' },
						// CHANNEL TRUTH: "live" means an SSE event actually arrived, not
						// that we opened a connection. Degraded shows the fallback cadence
						// so the reader knows how stale the numbers can be — a monitor that
						// claims realtime while polling is lying about its own freshness.
						h(
							'span',
							{ className: `dmo-dot ${m.liveMode ? 'ok' : 'warn'}`, 'data-dmo': 'arch-live-badge' },
							h('i'),
							m.liveMode
								? `实时推送${m.lastEventAge !== null ? ` · ${m.lastEventAge}s 前` : ''}`
								: '轮询降级（30s）',
						),
						h('span', { className: `dmo-dot ${m.health.fail > 0 ? 'fail' : m.health.warn > 0 ? 'warn' : m.health.fail === null || m.health.warn === null ? '' : 'ok'}` }, h('i'), m.health.fail > 0 ? `FAIL ${m.health.fail}` : m.health.warn > 0 ? `WARN ${m.health.warn}` : m.health.fail === null || m.health.warn === null ? '体检状态未知' : '体检正常'),
						h('span', { className: `dmo-dot ${m.captureOn === false ? 'warn' : ''}` }, h('i'), m.captureOn === true ? '采集已配置启用' : m.captureOn === false ? '采集未启用' : '采集状态未知'),
					),
				),
				h(
					'div',
					{ className: 'dmo-card', 'data-dmo': 'arch-canvas' },
					// The diagram itself.
					h(
						'svg',
						{ viewBox: `0 0 ${W} ${H}`, className: 'dmo-arch-svg', role: 'img', 'aria-label': '心智系统架构与数据流' },
						h('defs', null, [
							h('marker', { key: 'mb', id: 'dmo-ah-b', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-state-business-primary)' })),
							h('marker', { key: 'mo', id: 'dmo-ah-ok', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-state-success-primary)' })),
							h('marker', { key: 'md', id: 'dmo-ah-d', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-state-error-primary)' })),
							h('marker', { key: 'mm', id: 'dmo-ah-m', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '5', markerHeight: '5', orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--dsw-alias-label-dimmed)' })),
						]),
						// ---- edges first so nodes paint on top ----
						h('g', { key: 'edges', className: 'dmo-edges' }, [
							// 写入：来源 → 每日原始
							h('path', { key: 'e1', d: 'M180 82 L180 120 L125 120 L125 148', className: tone(stage('write')), markerEnd: 'url(#dmo-ah-m)' }),
							label('l1', 152, 112, '捕获'),
							// 蒸馏链
							h('path', { key: 'e2', d: 'M210 189 L248 189', className: tone(stage('write')), markerEnd: 'url(#dmo-ah-m)' }),
							h('path', { key: 'e3', d: 'M410 189 L448 189', className: tone(stage('distill')), markerEnd: 'url(#dmo-ah-m)' }),
							h('path', { key: 'e4', d: 'M610 189 L648 189', className: tone(stage('distill')), markerEnd: 'url(#dmo-ah-m)' }),
							label('l2', 229, 181, 'write'),
							label('l3', 429, 181, 'insight'),
							label('l4', 629, 181, 'dao'),
							// 各层收行进索引
							h('path', { key: 'e5', d: 'M125 228 L125 294', className: tone(stage('write'), 'ok'), markerEnd: 'url(#dmo-ah-m)' }),
							h('path', { key: 'e6', d: 'M330 228 L330 294', className: tone(stage('distill'), 'ok'), markerEnd: 'url(#dmo-ah-m)' }),
							h('path', { key: 'e7', d: 'M530 228 L530 294', className: tone(stage('distill'), 'ok'), markerEnd: 'url(#dmo-ah-m)' }),
							h('path', { key: 'e8', d: 'M715 228 L715 294', className: tone(stage('distill'), 'ok'), markerEnd: 'url(#dmo-ah-m)' }),
							h('path', { key: 'e9', d: 'M840 200 L800 200 L800 294', className: 'dmo-edge muted', markerEnd: 'url(#dmo-ah-m)' }),
							label('l5', 640, 268, 'memory_index 收行'),
							label('l9', 820, 192, '指针'),
							// 索引 → 召回准入 / 会话
							h('path', { key: 'e10', d: 'M520 366 L520 430', className: tone(stage('recall')), markerEnd: 'url(#dmo-ah-m)' }),
							h('path', { key: 'e11', d: 'M170 366 L170 430', className: 'dmo-edge muted', markerEnd: 'url(#dmo-ah-m)' }),
							label('l10', 552, 402, '召回读取索引'),
							label('l11', 150, 402, 'pre-step'),
							// 准入 → 会话（左向）
							h('path', { key: 'e12', d: 'M390 460 L312 460', className: tone(stage('recall')), markerEnd: 'url(#dmo-ah-m)' }),
							label('l12', 351, 452, '准入注入'),
							// 信号 → 准入（左向）
							h('path', { key: 'e13', d: 'M730 484 L652 484', className: tone(stage('feedback'), 'ok'), markerEnd: 'url(#dmo-ah-m)' }),
							label('l13', 691, 476, '校准阈值'),
							// 会话 → 信号：走底部回流弧（第四段，闭环）
							h('path', { key: 'e14', d: 'M175 512 L175 540 L905 540 L905 514', className: tone(stage('feedback'), 'ok'), markerEnd: 'url(#dmo-ah-m)' }),
							label('l14', 540, 532, '反馈回流方向 · 未验证'),
							// 外部知识库 → 召回准入（右廊道下行，不穿任何节点）
							//
							// Tone reflects the channel's REAL state, not a decoration:
							// usable → solid business edge; online-but-unauthorized → dashed
							// warning; down → dashed danger; not reported → muted (unknown,
							// never drawn as working).
							h('path', { key: 'e15', d: 'M1080 51 L1098 51 L1098 412 L660 412 L660 430', className: sagEdgeClass(), markerEnd: sagMarker() }),
							label('l15', 900, 404, m.sag.usable ? 'fast 档只读召回 · 可用' : m.sag.online === false || m.sag.authorized === false ? '第二通道未接通（见下方状态）' : '第二通道状态未知'),
						]),
						// ---- nodes ----
						h('g', { key: 'nodes' }, [
							node('src', { x: 40, y: 20, w: 280, h: 62, name: '会话 / 插件 / 用户', role: '写入与召回都发生在这里' }),
							node('sag', {
								x: 800, y: 20, w: 280, h: 62,
								name: '外部知识库 SAG-Wiki',
								// The role line carries the REAL channel state so the node is not
								// a permanent "experimental, read-only" caption that looks the
								// same whether the channel works or is dead.
								role: !m.sag.known ? '状态未上报' : m.sag.usable ? '第二通道 · 可用' : m.sag.online === true ? (m.sag.authorized === false ? '在线但未授权' : '在线 · 鉴权未知') : m.sag.online === false ? '不可达' : '状态未知',
							}),
							node('daily', { x: 40, y: 150, w: 170, h: 78, name: '每日原始记录', count: nOf('daily'), unit: '份', role: layers.daily?.role, tier: 'L0' }),
							node('functions', { x: 248, y: 150, w: 162, h: 78, name: '功能域', count: nOf('functions'), unit: '个', role: layers.functions?.role, tier: 'L2' }),
							node('insights', { x: 448, y: 150, w: 162, h: 78, name: '思想', count: nOf('insights'), unit: '条', role: layers.insights?.role, tier: 'L1' }),
							node('dao', { x: 648, y: 150, w: 142, h: 78, name: '道', count: nOf('dao'), unit: '条', role: layers.dao?.role, tier: 'L0d' }),
							node('capabilities', { x: 840, y: 150, w: 240, h: 78, name: '能力台账 / 技能库', count: nOf('capabilities'), unit: '项', role: '外部工具与技能包索引', tier: 'L2c' }),
							node('index', { x: 40, y: 294, w: 800, h: 72, name: 'MEMORY.md 索引', count: m.indexRows, unit: '行', role: '派生物：各层收行于此，召回只读它', accent: true }),
							node('ctx', { x: 40, y: 430, w: 272, h: 74, name: '下一轮会话上下文', role: '注入点：决定未来知道什么' }),
							node('gate', { x: 390, y: 430, w: 262, h: 74, name: '召回准入', role: '预算 / 分层 / 阀门规则' }),
							node('sig', { x: 730, y: 430, w: 350, h: 74, name: '召回曝光（未去重）', count: m.recallEvents, unit: '条', role: `总事件 ${displayCount(m.signals)} · 正向/纠正 ${displayCount(m.verdicts)}` }),
						]),
						// legend
						h('g', { key: 'legend' }, [
							h('line', { key: 'k1', x1: 40, y1: 578, x2: 84, y2: 578, className: 'dmo-edge business', markerEnd: 'url(#dmo-ah-b)' }),
							h('text', { key: 'k2', x: 92, y: 582, className: 'dmo-edge-label', textAnchor: 'start' }, '通道可用（SAG）'),
							h('line', { key: 'k3', x1: 236, y1: 578, x2: 280, y2: 578, className: 'dmo-edge ok', markerEnd: 'url(#dmo-ah-ok)' }),
							h('text', { key: 'k4', x: 288, y: 582, className: 'dmo-edge-label', textAnchor: 'start' }, '结构方向'),
							h('line', { key: 'k5', x1: 430, y1: 578, x2: 474, y2: 578, className: 'dmo-edge danger', markerEnd: 'url(#dmo-ah-d)' }),
							h('text', { key: 'k6', x: 482, y: 582, className: 'dmo-edge-label', textAnchor: 'start' }, '通道不可达（SAG）'),
							h('line', { key: 'k7', x1: 590, y1: 578, x2: 634, y2: 578, className: 'dmo-edge muted dashed', markerEnd: 'url(#dmo-ah-m)' }),
							h('text', { key: 'k8', x: 642, y: 582, className: 'dmo-edge-label', textAnchor: 'start' }, '运行未验证'),
						]),
					),
				),
				// Loop stages as measurable chips (same facts as the diagram's edges).
				h(
					'div',
					{ className: 'dmo-arch-loop', 'data-dmo': 'arch-loop' },
					m.loop.map((s, i) => [
						h(
							'div',
							{ key: s.key, className: `dmo-arch-step${s.ok ? ' on' : ''}`, 'data-dmo': `arch-step-${s.key}` },
							h('span', { className: 'dmo-arch-step-n' }, String(i + 1)),
							h('span', { className: 'dmo-arch-step-name' }, s.name),
							h('span', { className: 'dmo-arch-step-d' }, s.detail),
						),
						i === m.loop.length - 1
							? h('span', { key: 'cyc', className: `dmo-arch-cycle${m.loopClosed ? ' closed' : ''}` }, '↺ 闭环未验证')
							: null,
					]),
				),
				// Storage + capacity: server-resolved paths and the real index level.
				h(
					'div',
					{ className: 'dmo-bento' },
					h(
						Card,
						{ className: 'dmo-span-7', 'data-dmo': 'arch-roots' },
						h('div', { className: 'dmo-eyebrow' }, '存储根'),
						m.roots.map((r) =>
							h(
								'div',
								{ key: r.key, className: 'dmo-inset', style: { marginBottom: 8 } },
								h('div', { className: 'dmo-measure-l' }, r.name),
								h('div', { className: 'dmo-mono', style: { fontSize: 12, lineHeight: '18px', wordBreak: 'break-all', color: r.active ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)' } }, r.path || '（服务器未返回路径）'),
							),
						),
					),
					h(
						Card,
						{ className: 'dmo-span-5', 'data-dmo': 'arch-caps' },
						h('div', { className: 'dmo-eyebrow' }, '索引容量'),
						h('div', { className: 'dmo-measure' },
							h('div', { className: 'dmo-measure-v' }, m.indexBytes !== null && m.indexComfort > 0 ? `${Math.round((m.indexBytes / m.indexComfort) * 100)}%` : '—'),
							h('div', { className: 'dmo-measure-l' }, '占舒适线'),
							h('div', { className: 'dmo-measure-x' }, m.indexBytes !== null && m.indexComfort > 0 ? `${fmtBytes(m.indexBytes)} / ${fmtBytes(m.indexComfort)}` : '索引体积或舒适线未知'),
						),
						m.indexBytes !== null && m.indexComfort > 0
							? h('div', { className: 'dmo-meter', style: { width: '100%', height: 8, marginTop: 12, borderRadius: 999 } },
									h('i', { className: `dmo-meter-fill${m.indexBytes > m.indexComfort ? ' over' : ''}`, style: { width: `${Math.min(100, Math.round((m.indexBytes / Math.max(1, m.indexComfort)) * 100))}%` } }))
							: null,
					),
				),
				h(Card, { 'data-dmo': 'current-runtime' },
					h(RuntimeSnapshot, { snapshot: m.runtimeSnapshot, current: true }),
				),
				h(CycleCoverage, { coverage: m.cycleCoverage, patrolDelivery: m.patrolDelivery }),
				// Second recall channel: three facts, three rows. They fail independently
				// (no key / service down / key rejected) and each has its own fix, so a
				// single "unavailable" line would hide which one is broken.
				h(
					Card,
					{ className: 'dmo-span-12', 'data-dmo': 'arch-sag' },
					h('div', { className: 'dmo-eyebrow' }, '第二召回通道 · SAG-Wiki'),
					!m.sag.known
						? h('div', { className: 'dmo-measure-x' }, '服务器未上报 SAG 状态（可能是旧版 server 半）——按未知处理，不当作可用。')
						: h(
								'div',
								{ style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 4 } },
								[
									{ key: 'configured', name: '已配置密钥', ok: m.sag.configured, bad: '无 key：设 SAG_API_KEY 或写 <sag>/api-key' },
									{ key: 'online', name: '服务在线', ok: m.sag.online, bad: '不可达：sag api start' },
									{ key: 'authorized', name: '鉴权通过', ok: m.sag.authorized, bad: '被拒：重新签发 key' },
								].map((f) =>
									h(
										'div',
										{ key: f.key, className: 'dmo-inset', 'data-dmo': `sag-${f.key}` },
										h('div', { className: 'dmo-measure-l' }, f.name),
										h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 } },
											h('span', { className: `dmo-dot ${f.ok === true ? 'ok' : f.ok === false ? 'fail' : ''}` }, h('i')),
											h('span', { style: { fontSize: 13, color: f.ok === true ? 'var(--dsw-alias-state-success-primary)' : f.ok === false ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' } }, f.ok === true ? '正常' : f.ok === false ? '不通' : '未知'),
										),
										f.ok === false ? h('div', { className: 'dmo-measure-x', style: { marginTop: 4 } }, f.bad) : null,
									),
								),
							),
					h('div', { className: 'dmo-measure-x', style: { marginTop: 10 } },
						m.sag.endpoint
							? `端点 ${m.sag.endpoint} · 工具 memory_sag · 取正文用（不替代索引召回做门禁）`
							: '工具 memory_sag · 取正文用（不替代索引召回做门禁）',
					),
				),
			);
		}

		function Overview({ health, counts, timeline, usage, env, capture, prose, preview, previewQ, setPreviewQ, onOpen, onZone, onNavigate }) {
			const problems = Array.isArray(health?.results) ? health.results : [];
			const healthKnown = knownCount(health?.failCount) !== null && knownCount(health?.warnCount) !== null;
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
				{ className: 'dmo-bento', 'data-dmo': 'bento' },
				// Hero band: the five zone stocks as one card each, uneven spans so
				// the top row reads as a bento rather than a table of equal boxes.
				// `functions` and `insights` are the two that actually decide what a
				// future session knows, so they get the wider cells.
				h(
					Card,
					{ className: 'dmo-span-3 dmo-hero-card', 'data-dmo': 'measure-functions' },
					h('div', { className: 'dmo-eyebrow' }, '功能'),
					h('div', { className: 'dmo-measure' },
						h('div', { className: 'dmo-measure-v' }, String(displayCount(counts.functions))),
						h('div', { className: 'dmo-measure-l' }, '功能域'),
						h('div', { className: 'dmo-measure-x' }, '可复跑的操作'),
					),
					h('button', { type: 'button', className: 'dmo-link', onClick: () => onZone('functions'), 'data-dmo': 'growth-card' }, '打开 →'),
				),
				h(
					Card,
					{ className: 'dmo-span-3 dmo-hero-card', 'data-dmo': 'measure-insights' },
					h('div', { className: 'dmo-eyebrow' }, '思想'),
					h('div', { className: 'dmo-measure' },
						h('div', { className: 'dmo-measure-v' }, String(displayCount(counts.insights))),
						h('div', { className: 'dmo-measure-l' }, '创新优化思想'),
						h('div', { className: 'dmo-measure-x' }, '可重套的原则'),
					),
					h('button', { type: 'button', className: 'dmo-link', onClick: () => onZone('insights'), 'data-dmo': 'growth-card' }, '打开 →'),
				),
				h(
					Card,
					{ className: 'dmo-span-3 dmo-hero-card', 'data-dmo': 'measure-capabilities' },
					h('div', { className: 'dmo-eyebrow' }, '能力'),
					h('div', { className: 'dmo-measure' },
						h('div', { className: 'dmo-measure-v' }, String(displayCount(counts.capabilities))),
						h('div', { className: 'dmo-measure-l' }, '能力台账'),
						h('div', { className: 'dmo-measure-x' }, '外部工具索引'),
					),
					h('button', { type: 'button', className: 'dmo-link', onClick: () => onZone('capabilities'), 'data-dmo': 'growth-card' }, '打开 →'),
				),
				h(
					Card,
					{ className: 'dmo-span-3 dmo-hero-card', 'data-dmo': 'measure-skills' },
					h('div', { className: 'dmo-eyebrow' }, '技能'),
					h('div', { className: 'dmo-measure' },
						h('div', { className: 'dmo-measure-v' }, String(displayCount(counts.skills))),
						h('div', { className: 'dmo-measure-l' }, '技能库'),
						h('div', { className: 'dmo-measure-x' }, '已验证的程序'),
					),
					h('button', { type: 'button', className: 'dmo-link', onClick: () => onZone('skills'), 'data-dmo': 'growth-card' }, '打开 →'),
				),
				// Second band: the health verdict gets the eye, the problem list sits
				// in a recessed panel inside it.
				h(
					Card,
					{ className: 'dmo-span-5', 'data-dmo': 'health-card' },
					h('div', { className: 'dmo-eyebrow' }, '体检'),
					h('div', { className: 'dmo-measure' },
						h('div', { className: 'dmo-measure-v' }, problems.length ? String(problems.length) : healthKnown ? String(health.failCount + health.warnCount) : '未知'),
						h('div', { className: 'dmo-measure-l' }, problems.length || (healthKnown && health.failCount + health.warnCount > 0) ? '条待处理问题' : healthKnown ? '体检全通过' : '体检状态未知'),
					),
					h(
						'div',
						{ className: 'dmo-chips', style: { marginTop: 10 } },
						h(Chip, { tone: health?.failCount > 0 ? 'fail' : knownCount(health?.failCount) === null ? null : 'ok' }, knownCount(health?.failCount) === null ? 'FAIL 未知' : health.failCount > 0 ? `FAIL ${health.failCount}` : '无 FAIL'),
						h(Chip, { tone: health?.warnCount > 0 ? 'warn' : null }, knownCount(health?.warnCount) === null ? 'WARN 未知' : health.warnCount > 0 ? `WARN ${health.warnCount}` : '无 WARN'),
						cold.length ? h(Chip, { tone: 'warn' }, `❄ 冷记忆 ${cold.length}`) : null,
					),
					problems.length
						? h('ul', { className: 'dmo-probs dmo-inset', style: { marginTop: 12 } }, problems.slice(0, 12).map((p, i) => h('li', { key: i }, `[${p.level}] ${p.rule}: ${p.message}`)))
						: h('div', { className: 'dmo-inset dmo-meta', style: { marginTop: 12 } }, healthKnown && health.failCount === 0 && health.warnCount === 0 ? '索引体积、摘要、反向链接、日期顺序、死链、冷记忆均正常。' : '体检结果详情未提供。'),
				),
				h('div', { className: 'dmo-span-4', 'data-dmo': 'capture-slot' }, h(CaptureStatus, { capture })),
				// Daily stock gets a sparkline of the last days actually on disk.
				h(
					Card,
					{ className: 'dmo-span-3', 'data-dmo': 'measure-daily' },
					h('div', { className: 'dmo-eyebrow' }, '每日'),
					h('div', { className: 'dmo-measure' },
						h('div', { className: 'dmo-measure-v' }, String(displayCount(counts.daily))),
						h('div', { className: 'dmo-measure-l' }, '日线索 / 月归档'),
					),
					(() => {
						const days = (timeline ?? []).filter((t) => t.zone === 'daily').slice(0, 12).reverse();
						if (!days.length) return null;
						const peak = Math.max(1, ...days.map((d) => d.bytes ?? 0));
						return h('div', { className: 'dmo-spark', 'data-dmo': 'daily-spark', title: '最近日线索的条目体积（真实字节数）' },
							days.map((d, i) => h('b', { key: i, style: { height: `${Math.max(8, Math.round(((d.bytes ?? 0) / peak) * 100))}%` } })),
						);
					})(),
					h('button', { type: 'button', className: 'dmo-link', onClick: () => onZone('daily'), 'data-dmo': 'growth-card' }, '打开 →'),
				),
				// Consensus + environment constants: the two prose blocks of
			// MEMORY.md that the index tables do not carry. They answer "what
			// did we agree across features" and "which machine path is real",
			// which is exactly what a future session needs before acting.
			prose && (prose.consensus.length || prose.env.length)
				? h(
						Card,
						{ className: 'dmo-span-6', 'data-dmo': 'prose-card' },
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
					? h(Card, { className: 'dmo-span-6', 'data-dmo': 'env-card' }, h(CardTitle, null, '运行环境'), envRow)
					: null,
				h(
					Card,
					{ className: 'dmo-span-6', 'data-dmo': 'usage-card' },
					h(CardTitle, null, '使用信号'),
					knownCount(usage?.signalCount) === null
						? h('div', { className: 'dmo-meta' }, '使用信号数量未知。')
						: !hasSignals
						? h('div', { className: 'dmo-meta' }, '还没有使用信号。召回命中与 memory_read 会自动记录；纠正/认可用 memory_usage(record) 记一笔。')
						: h(
								'div',
								{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
								h(
									'div',
									{ className: 'dmo-chips', 'data-dmo': 'usage-layers' },
									h(Chip, null, `实验 ${displayCount(usageLayer['实验'])}`),
									h(Chip, { tone: 'ok' }, `专项 ${displayCount(usageLayer['专项'])}`),
									h(Chip, { tone: 'ok' }, `通用 ${displayCount(usageLayer['通用'])}`),
									// 口径必须标清：signalCount 里绝大部分是插件自己写的
									// recall 曝光（同一文件会重复几百次），不是"被使用"，
									// 更不是索引规模。索引规模看 memory_index 的行数。
									h('span', { className: 'dmo-meta' }, `30 天 ${usage.signalCount} 条事件（含 ${displayCount(usage.recallEvents)} 条召回曝光）· 正向/纠正 ${displayCount(usage.verdictEvents)} 次 · 覆盖 ${displayCount(usage.distinctHrefs)} 个文件`),
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
					? h('div', { className: 'dmo-span-6', 'data-dmo': 'preview-slot' }, h(RecallPreviewCard, { res: preview, q: previewQ, setQ: setPreviewQ, onNavigate }))
					: null,
				h(
					Card,
					{ className: 'dmo-span-6', 'data-dmo': 'timeline-card' },
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

		/**
		 * Daily month/week grouping (2026-11 月/周折叠方案).
		 *
		 * Daily threads keep accumulating forever; a flat list stops being
		 * scannable. Rows group as 月组 → 周子组 → 日叶子: each month (YYYY-MM)
		 * carries a fold toggle and — when the month was archived — a button that
		 * opens the month archive file (YYYY-MM.md, same /file?zone=daily route).
		 * Inside a month, days group into ISO-week subgroups labeled
		 * `周 YYYY-Www（MM-DD ~ MM-DD）`. Pure, so the UI test asserts the
		 * grouping without a browser.
		 */
		const pad2n = (n) => String(n).padStart(2, '0');
		const localDateOf = (d) => `${d.getFullYear()}-${pad2n(d.getMonth() + 1)}-${pad2n(d.getDate())}`;
		function isoWeekOf(dateStr) {
			const [y, m, d] = dateStr.split('-').map(Number);
			const date = new Date(Date.UTC(y, m - 1, d));
			const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
			const monday = new Date(date);
			monday.setUTCDate(monday.getUTCDate() - dayNum);
			// ISO week = the ordinal of this week's Thursday within its ISO year.
			const thursday = new Date(monday);
			thursday.setUTCDate(thursday.getUTCDate() + 3);
			const isoYear = thursday.getUTCFullYear();
			const jan4 = new Date(Date.UTC(isoYear, 0, 4));
			const firstThu = new Date(jan4);
			firstThu.setUTCDate(firstThu.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
			const week = 1 + Math.round((thursday - firstThu) / (7 * 86_400_000));
			const sunday = new Date(monday);
			sunday.setUTCDate(sunday.getUTCDate() + 6);
			const iso = (dt) => dt.toISOString().slice(0, 10);
			return { year: isoYear, week, monday: iso(monday), sunday: iso(sunday) };
		}
		function weekLabelOf(dateStr) {
			const w = isoWeekOf(dateStr);
			return `周 ${w.year}-W${pad2n(w.week)}（${w.monday.slice(5)} ~ ${w.sunday.slice(5)}）`;
		}
		function dailyMonthGroups(rows) {
			const byMonth = new Map();
			for (const f of rows) {
				const month = String(f.name).slice(0, 7);
				if (!byMonth.has(month)) byMonth.set(month, { month, archive: null, days: [] });
				const g = byMonth.get(month);
				if (f.isArchive) g.archive = f;
				else g.days.push(f);
			}
			return [...byMonth.keys()].sort((a, b) => b.localeCompare(a)).map((m) => {
				const g = byMonth.get(m);
				const weeks = new Map();
				for (const f of g.days.slice().sort((a, b) => b.name.localeCompare(a.name))) {
					const d = f.name.slice(0, 10);
					const key = `${isoWeekOf(d).year}-W${pad2n(isoWeekOf(d).week)}`;
					if (!weeks.has(key)) weeks.set(key, { key, label: weekLabelOf(d), days: [] });
					weeks.get(key).days.push(f);
				}
				return { month: m, archive: g.archive, days: g.days, weeks: [...weeks.values()].sort((a, b) => b.key.localeCompare(a.key)) };
			});
		}

		function ZoneList({ zone, rows, sort, setSort, filter, setFilter, onOpen, daoView, setDaoView, candidates, candidateState, onOpenCandidate, onRetry, candidateAction, candBusy, actMsg, onDeleteDao, today, openArchive, onToggleArchive, archiveDays }) {
			const label = ZONE_LABEL[zone] ?? zone;
			// 道层的两个视图（2026-11-10 用户要求）：正式道 / 候选公理。
			// 候选不是"另一种道"，它还没生效——所以用**筛选标签**分开，
			// 而不是混在同一个列表里让人分不清哪些已经在参与判断。
			const isDao = zone === 'dao';
			const showCandidates = isDao && daoView === 'candidates';
			const candList = Array.isArray(candidates) ? candidates : [];
			const candidateQuery = filter.trim().toLowerCase();
			const filteredCandidates = candList.filter((c) => !candidateQuery || `${c.name ?? ''} ${c.proposition ?? ''}`.toLowerCase().includes(candidateQuery));
			const shown = showCandidates ? filteredCandidates : rows;
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 10 } },
				h(
					'div',
					{ className: 'dmo-page-head' },
					h('h2', { className: 'dmo-page-title' }, label),
					h('span', { className: 'dmo-page-sub' }, `${shown.length} 项`),
					// 候选标签：只有道层有。数字直接放在标签上——待决策的东西
					// 不该要求用户主动点开才知道有几条。
					isDao
						? h(
								'span',
								{ style: { display: 'inline-flex', gap: 6 } },
								h(Btn, { sm: true, tone: daoView === 'active' ? undefined : 'outline', onClick: () => setDaoView('active'), title: '已生效的道' }, `正式 ${rows.length}`),
								h(Btn, { sm: true, tone: daoView === 'candidates' ? undefined : 'outline', onClick: () => setDaoView('candidates'), title: '等待你确认的候选公理', 'data-dmo': 'dao-cand-tab' }, `候选 ${candidateState?.error || (candidateState?.loading && !candidateState?.data) ? '—' : candList.length}`),
							)
						: null,
					h('span', { className: 'dmo-page-tools' },
						zone !== 'daily' && !showCandidates ? h(Btn, { sm: true, tone: 'outline', onClick: () => setSort(sort === 'time' ? 'name' : 'time'), title: '切换排序' }, sort === 'time' ? '按时间 ↓' : '按名称 ↑') : null,
						h('input', { className: 'dmo-filter', style: { width: 180 }, placeholder: zone === 'daily' ? '过滤日期…' : '按名称或摘要过滤…', value: filter, onChange: (e) => setFilter(e.target.value) }),
					),
				),
				actMsg ? h('div', { className: 'dmo-meta', 'data-dmo': 'dao-act-msg' }, actMsg) : null,
				showCandidates
					? candidateState?.error
						? h('div', { className: 'dmo-empty', role: 'alert' }, `候选读取失败：${candidateState.error} `, h(Btn, { sm: true, tone: 'outline', onClick: onRetry }, '重试'))
						: candidateState?.loading && !candidateState?.data
						? h('div', { className: 'dmo-empty' }, '正在读取候选…')
						: filteredCandidates.length === 0
						? h('div', { className: 'dmo-empty' }, candidateQuery ? '没有匹配的候选。' : '没有待决策的候选公理。')
						: h(
								'div',
								{ className: 'dmo-rows', 'data-dmo': 'dao-candidates' },
								filteredCandidates.map((c) =>
									h(
										'div',
										{ key: c.name, className: 'dmo-group', style: { padding: '10px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' } },
										h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
											h('span', { style: { fontWeight: 600, fontSize: 13 } }, c.name),
											h('span', { className: 'dmo-meta' }, `${c.source_count ?? 0} 条法`),
											h('span', { className: 'grow' }),
											h(Btn, { sm: true, tone: 'outline', disabled: candBusy === c.name, onClick: () => onOpenCandidate(c.name) }, '查看正文'),
										),
										c.proposition ? h('div', { style: { fontSize: 12, lineHeight: 1.6, marginTop: 6, color: 'var(--dsw-alias-label-secondary)' } }, c.proposition) : h('div', { className: 'dmo-meta' }, '(命题读取失败)'),
										h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
											h(Btn, { sm: true, disabled: candBusy === c.name, 'data-dmo': 'dao-confirm', onClick: () => { if (window.confirm(`确认将候选「${c.name}」转为正式道？请先查看正文及来源。`)) candidateAction('confirm', c.name); } }, '确认转正'),
											h(Btn, { sm: true, tone: 'outline', disabled: candBusy === c.name, 'data-dmo': 'dao-reject', onClick: () => {
												const why = window.prompt(`否决候选「${c.name}」的理由（必填：否则同一命题会原样再提一遍）`);
												if (why && why.trim()) candidateAction('reject', c.name, why.trim());
											} }, '否决'),
											h(Btn, { sm: true, tone: 'outline', disabled: candBusy === c.name, 'data-dmo': 'dao-delete', onClick: () => {
												if (window.confirm(`彻底删除候选「${c.name}」？\n\n删除与"否决"的区别：否决会留档作为反例证据，删除是"这条根本不该出现"（误写/重复）。`)) candidateAction('delete', c.name);
											} }, '删除'),
										),
									),
								),
							)
					: null,
				!showCandidates && rows.length && zone !== 'daily'
					? h(
							'div',
							{ className: 'dmo-rows' },
							rows.map((f, i) => {
								return h(
									'div',
									{ key: f.name, className: 'dmo-group', style: { display: 'flex', alignItems: 'stretch', gap: 6 } },
									h(
										'button',
										{ key: 'r', type: 'button', className: 'dmo-row', style: { flex: 1, minWidth: 0 }, onClick: () => onOpen(zone, f.name), title: f.name, 'data-dmo': 'row' },
										h(
											'div',
											{ className: 'dmo-row-top' },
											h('span', { className: 'dmo-row-name' }, f.name.replace(/\.md$/, '')),
											h('span', { className: 'dmo-row-meta' }, `${relTime(f.mtime)} · ${fmtBytes(f.bytes)}`),
										),
										f.summary ? h('div', { className: 'dmo-row-sum' }, f.summary) : null,
									),
									// 正式道的删除（2026-11-10 用户要求）。放在行**外面**而不是里面：
									// 行本身是 <button>，button 不能嵌套 button（HTML 非法，点击会双触发）。
									// 只有道层出这个按钮——其它层的删除没有对应留档语义，不该顺手加。
									zone === 'dao' && onDeleteDao
										? h(Btn, {
												sm: true, tone: 'outline', 'data-dmo': 'dao-del',
												disabled: candBusy === f.name,
												title: '删除这条道（会留档到 dao/_deleted/）',
												onClick: () => onDeleteDao(f.name.replace(/\.md$/, '')),
											}, '删除')
										: null,
								);
							}),
						)
					: null,
				// 每日分区（2026-11 月/周折叠方案）：月组 → 周子组 → 日叶子。
				// 月折叠默认展开当月；周折叠默认展开当周。「今天」可注入（缺省本地时区），
				// 测试与宿主都能固定锚点。
				!showCandidates && zone === 'daily'
					? rows.length
						? h(DailyMonthList, { rows, onOpen, filter, today, openArchive, onToggleArchive, archiveDays })
						: h('div', { className: 'dmo-empty' }, filter ? '没有匹配的日期。' : '每日区还没有文件。')
					: null,
				!showCandidates && !rows.length && zone !== 'daily' ? h('div', { className: 'dmo-empty' }, filter ? '没有匹配的条目。' : `${label}区还没有文件。`) : null,
			);
		}

		/**
		 * Daily month/week fold list. Folding state lives in TWO maps (per-month,
		 * per-week); the defaults are computed from `today` (injected, local-time
		 * fallback) — only the CURRENT month and CURRENT week start expanded.
		 */
		function DailyMonthList({ rows, onOpen, filter, today, openArchive, onToggleArchive, archiveDays }) {
			const todayStr = (() => {
				if (typeof today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(today)) return today;
				if (today instanceof Date && !Number.isNaN(today.getTime())) return localDateOf(today);
				return localDateOf(new Date());
			})();
			const groups = dailyMonthGroups(rows);
			const [monthFold, setMonthFold] = useState(() => Object.fromEntries(groups.map((g) => [g.month, g.month === todayStr.slice(0, 7)])));
			const [weekFold, setWeekFold] = useState(() => Object.fromEntries(groups.flatMap((g) => g.weeks.map((w) => [`${g.month}/${w.key}`, g.month === todayStr.slice(0, 7) && w.key === `${isoWeekOf(todayStr).year}-W${pad2n(isoWeekOf(todayStr).week)}`]))));
			const q = String(filter ?? '').trim().toLowerCase();
			// 过滤时不强制折叠：搜索命中应该全部可见，藏起来等于没搜到。
			const monthOpen = (m) => (q ? true : monthFold[m] !== false);
			const weekOpen = (k) => (q ? true : weekFold[k] !== false);
			const dayRow = (f) =>
				h(
					'button',
					{ key: f.name, type: 'button', className: 'dmo-row', style: { flex: 1, minWidth: 0 }, onClick: () => onOpen('daily', f.name), title: f.name, 'data-dmo': 'row' },
					h(
						'div',
						{ className: 'dmo-row-top' },
						h('span', { className: 'dmo-row-name' }, f.name.replace(/\.md$/, '')),
						h('span', { className: 'dmo-row-meta' }, `${relTime(f.mtime)} · ${fmtBytes(f.bytes)}`),
					),
					f.summary ? h('div', { className: 'dmo-row-sum' }, f.summary) : null,
				);
			// 月归档的日线索（按需）：展开归档时才请求 /daily-days（只解析标题行），
			// 点开某一天走 /file?zone=daily 读整份归档——内容请求发生在点击时。
			const archiveDayCount = (g) => {
				if (archiveDays?.data?.name === g.archive?.name) return archiveDays.data.days?.length ?? 0;
				return g.archive?.dayCount ?? 0;
			};
			const archiveSection = (g) => {
				if (openArchive !== g.archive.name) return null;
				const res = archiveDays;
				if (res?.loading) return h('div', { className: 'dmo-meta', style: { padding: '2px 8px 6px' } }, '读取归档日线索…');
				if (res?.error) return h('div', { className: 'dmo-empty', style: { padding: '2px 8px 6px' } }, `归档日线索读取失败：${res.error}`);
				const days = res?.data?.name === g.archive.name ? (res.data.days ?? []) : null;
				if (days === null) return null;
				if (!days.length) return h('div', { className: 'dmo-meta', style: { padding: '2px 8px 6px' } }, '这份归档没有 ### [日期] 日标题。');
				return h(
					'div',
					{ style: { display: 'flex', flexDirection: 'column' }, 'data-dmo': 'archive-days' },
					days.map((d) =>
						h(
							'button',
							{
								key: d.date, type: 'button', className: 'dmo-row', style: { padding: '6px 8px' },
								onClick: () => onOpen('daily', g.archive.name), title: `${g.archive.name} 里的 ${d.date}`,
								'data-dmo': 'archive-day',
							},
							h(
								'div',
								{ className: 'dmo-row-top' },
								h('span', { className: 'dmo-row-name' }, d.date),
								d.title ? h('span', { className: 'dmo-row-sum' }, d.title) : null,
							),
						),
					),
				);
			};
			return h(
				'div',
				{ className: 'dmo-rows', 'data-dmo': 'daily-months' },
				groups.map((g) => {
					const open = monthOpen(g.month);
					const dayCount = (g.days?.length ?? 0) + (g.archive ? archiveDayCount(g) : 0);
					return h(
						'div',
						{ key: g.month, className: 'dmo-group' },
						h(
							'div',
							{ className: 'dmo-month-row', style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 } },
							h(
								'button',
								{
									type: 'button', className: 'dmo-month dmo-chip btn', style: { margin: 0 },
									onClick: () => setMonthFold((m) => ({ ...m, [g.month]: !open })),
									title: open ? '收起这个月' : '展开这个月', 'data-dmo': 'month-fold',
								},
								`${open ? '▾' : '▸'} ${g.month}`,
							),
							g.archive
								? h(
										Btn,
										{
											sm: true, tone: 'outline',
											// 月归档是**展开开关**，不是直接打开整份文件：展开后按需
											// 拉日线索，点具体一天才请求内容。只读展示，无任何写入口。
											onClick: () => onToggleArchive?.(g.archive.name),
											title: openArchive === g.archive.name ? `收起 ${g.archive.name} 的日线索` : `展开 ${g.archive.name} 的日线索`,
											'data-dmo': 'month-archive',
										},
										`${openArchive === g.archive.name ? '▾' : '▸'} 月归档`,
									)
								: null,
							h('span', { className: 'grow' }),
							h('span', { className: 'dmo-meta' }, `${dayCount} 日`),
						),
						g.archive ? archiveSection(g) : null,
						open
							? h(
									'div',
									{ style: { display: 'flex', flexDirection: 'column', gap: 2 } },
									g.weeks.map((w) => {
										const wk = `${g.month}/${w.key}`;
										const wOpen = weekOpen(wk);
										return h(
											'div',
											{ key: w.key, className: 'dmo-group' },
											h(
												'button',
												{
													type: 'button', className: 'dmo-week-head', style: { display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '4px 8px', border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' },
													onClick: () => setWeekFold((m) => ({ ...m, [wk]: !wOpen })),
													title: wOpen ? '收起这一周' : '展开这一周', 'data-dmo': 'week-fold',
												},
												h('span', { className: 'dmo-meta' }, wOpen ? '▾' : '▸'),
												h('span', { className: 'dmo-meta', style: { fontWeight: 600 } }, w.label),
												h('span', { className: 'grow' }),
												h('span', { className: 'dmo-meta' }, `${w.days?.length ?? 0} 日`),
											),
											wOpen ? h('div', { style: { display: 'flex', flexDirection: 'column' } }, w.days.map(dayRow)) : null,
										);
									}),
								)
							: null,
					);
				}),
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
					{ className: 'dmo-page-head' },
					h('h2', { className: 'dmo-page-title' }, '技能库'),
					h(
						'div',
						{ className: 'dmo-chips' },
						h('button', { type: 'button', className: `dmo-chip btn${tab === 'memory' ? ' active' : ''}`, 'data-dmo': 'skill-tab', onClick: () => onTab('memory') }, `结晶技能 ${mem.length}`),
						h('button', { type: 'button', className: `dmo-chip btn${tab === 'host' ? ' active' : ''}`, 'data-dmo': 'skill-tab', onClick: () => onTab('host') }, `系统技能 ${host.length}`),
					),
					h('span', { className: 'dmo-page-tools' },
						h('input', { className: 'dmo-filter', style: { width: 180 }, placeholder: '按名称或描述过滤…', value: filter, onChange: (e) => setFilter(e.target.value), 'data-dmo': 'skill-filter' }),
					),
				),
				data?.hostDegraded && tab === 'host'
					? h('div', { className: 'dmo-empty' }, '宿主技能根不可读，系统技能暂不可列；结晶技能不受影响。')
					: null,
				actMsg ? h('div', { className: 'dmo-card tight', role: 'status', 'data-dmo': 'skill-actmsg' }, actMsg) : null,
				error
					? h('div', { className: 'dmo-empty' }, `读取技能库失败：${error}`)
					: loading && !data
						? h('div', { className: 'dmo-empty' }, '读取技能库…')
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
			const [writeError, setWriteError] = useState('');
			// 二次确认：正在等确认的 fingerprint。删除不可逆，误点代价大，
			// 故第一次点只把按钮变成"确认删除"，第二次点才真删。
			const [confirming, setConfirming] = useState(null);
			const total = counts.open + counts.acknowledged + counts.resolved;

			/** 统一走 /inbox-action：payload 决定是改状态还是删除。 */
			const write = (fingerprint, payload) => {
				setBusy(fingerprint);
				setWriteError('');
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
					.catch((e) => setWriteError(`操作失败：${String(e?.message ?? e)}`))
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
				{ className: 'dmo-page-head' },
				h('h2', { className: 'dmo-page-title' }, '问题收件箱'),
				h('span', { className: 'dmo-page-sub' }, `共 ${total} 条`),
				h('span', { className: 'dmo-page-tools' }, h('div', { className: 'dmo-chips' }, chips)),
			);

			if (res.error) return h('div', { className: 'dmo-empty', role: 'alert' }, `收件箱读取失败：${res.error} `, h(Btn, { tone: 'outline', onClick: onStateChange }, '重试'));
			if (res.loading && !data) return h('div', { className: 'dmo-empty' }, '正在读取收件箱…');
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

			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, head, writeError ? h('div', { className: 'dmo-card tight', role: 'alert' }, writeError) : null, ...rows);
		}

		function SearchPane({ res, q, zone, setZone, onOpen }) {
			const hits = res.data?.hits ?? [];
			const zones = [
				{ key: 'all', label: '全部' },
				{ key: 'index', label: '索引' },
				{ key: 'functions', label: '功能' },
				{ key: 'insights', label: '思想' },
				{ key: 'dao', label: '道' },
				{ key: 'capabilities', label: '能力' },
				{ key: 'skills', label: '技能' },
				{ key: 'daily', label: '每日' },
			];
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', gap: 8 } },
				h(
					'div',
					{ className: 'dmo-page-head' },
					h('h2', { className: 'dmo-page-title' }, `搜索“${q}”`),
					h('span', { className: 'dmo-page-sub' }, `${hits.length} 处命中`),
					setZone
						? h(
								'div',
								{ className: 'dmo-page-tools' },
								h('div', { className: 'dmo-chips' }, zones.map((z) =>
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
								)),
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

		/**
		 * The panel shell.
		 *
		 * This is deliberately ONE component with ~440 lines rather than a set of
		 * extracted modules, and the reason is mechanical, not laziness:
		 *   · the file is loaded by the host's module loader in the BROWSER, so a
		 *     relative import is a new loading contract, not a free refactor;
		 *   · the build copies this file verbatim and rewrites its registration id,
		 *     so every extra file needs its own rewrite entry or the panel white-
		 *     screens on the next deploy;
		 *   · the bulk is React hooks (16 useState + 12 useApi + 2 useEffect) which
		 *     MUST run unconditionally in the same order; extracting them into
		 *     custom hooks moves 3-4 lines each while adding 6-argument plumbing —
		 *     net MORE complexity, not less.
		 *
		 * So the lines below are grouped into five labelled sections. Read them as
		 * sections: state → remote reads → actions → derived data → render.
		 */
		function MemoryPanel(props) {
			// ── 1. state ───────────────────────────────────────────────────────
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

			// ── 2. remote reads (one useApi per source; url=null means idle) ───
			// NOTE: overview stays a DIRECT useApi call. Wrapping it in a helper that
			// itself calls useApi changed the hook/effect stream the production
			// fake-React harness observes, and broke five real-panel tests
			// (2026-11-16). The SSE channel therefore upgrades `tick` instead of
			// intercepting the fetch: one pushed event -> one tick bump -> every read
			// refreshes, which is hook-order neutral and needs no new hook slot.
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
			// 月归档的日线索按需取（月/周折叠方案 2026-11）：展开某份归档时才请求
			// /daily-days（服务端只解析 ### [YYYY-MM-DD] 标题行）；点开具体一天走
			// 既有 /file?zone=daily 读正文。url=null 即空闲态，hooks 保持无条件。
			const [archiveOpenName, setArchiveOpenName] = useState(null);
			const archiveDays = useApi(archiveOpenName ? `${API}/daily-days?name=${enc(archiveOpenName)}&v=${tick}` : null, fixtures);
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
			// 道层视图（2026-11-10）：正式道 / 候选公理。候选默认不显示——
			// 它们还没生效，混进列表会让人分不清哪些已在参与判断。
			const [daoView, setDaoView] = useState('active');
			const [candBusy, setCandBusy] = useState('');
			// Per-row pending (5.27.0): the switch has no optimistic state — it
			// refetches after the write — so a double click fires two lifecycle
			// requests and the second lands as "已是 active" noise. The button is
			// disabled while ITS skill's action is in flight.
			const [toggleBusy, setToggleBusy] = useState('');
			// ── 3. actions (every write goes through a guarded channel) ────────
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
			// —— 候选公理（2026-11-10 用户要求）——
			// 面板是**人工闸门的入口**：用户在这里点确认，就是候选转正的唯一来源。
			// 所以这些按钮直接打 POST /axiom-action，而不是走 agent 的 tool——
			// 让人的动作留在人手里。
			const candRes = useApi(`${API}/axiom-candidates?v=${tick}`, fixtures);
			const candidateDetail = useApi(view.kind === 'candidate' ? `${API}/axiom-candidates?name=${enc(view.name)}&v=${tick}` : null, fixtures);
			const candidateAction = async (action, name, reason) => {
				setActMsg('');
				setCandBusy(name);
				try {
					const resp = await fetch(`${API}/axiom-action`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action, name, ...(reason ? { reason } : {}) }),
					});
					const r = await resp.json().catch(() => ({}));
					if (!resp.ok) {
						setActMsg(`${resp.status >= 500 ? '操作结果未知' : '操作未确认'}：${r.error || `HTTP ${resp.status}`}（列表将刷新，请核对后再操作）`);
						setTick((n) => n + 1);
						return null;
					}
					setActMsg(r?.message ?? '完成');
					// 写完后重取：列表与「正式 N / 候选 N」两个计数都要跟着变，
					// 否则用户点完确认会看到候选还挂在那里。
					setTick((n) => n + 1);
					return r;
				} catch (e) {
					setActMsg(`操作结果未知：无法接收回执，操作可能已发生；请刷新后核对，不要盲目重试。${String(e?.message ?? e)}`);
					setTick((n) => n + 1);
					return null;
				} finally {
					setCandBusy('');
				}
			};
			const search = useApi(live.length >= 2 ? `${API}/search?q=${enc(live)}${searchZone !== 'all' ? `&zone=${searchZone}` : ''}` : null, fixtures);

			// 删除正式道（2026-11-10 用户要求）。与候选删除分开：道已经参与判断、
			// 可能被召回引用过，所以后端**留档到 dao/_deleted/**，并提醒索引行需手工删。
			const deleteDao = async (name) => {
				if (!window.confirm(`删除道「${name}」？\n\n它会留档到 dao/_deleted/（可回查），但 MEMORY.md 里的道层索引行需要你手工删除——面板不改索引。`)) return null;
				setActMsg('');
				setCandBusy(name);
				try {
					const resp = await fetch(`${API}/dao-action`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ action: 'delete', name }),
					});
					const r = await resp.json().catch(() => ({}));
					if (!resp.ok) { setActMsg(`${resp.status >= 500 ? '操作结果未知' : '操作未确认'}：${r.error || `HTTP ${resp.status}`}（列表将刷新，请核对后再操作）`); setTick((n) => n + 1); return null; }
					setActMsg(`${r.message}${r.note ? ` —— ${r.note}` : ''}`);
					setTick((n) => n + 1);
					return r;
				} catch (e) {
					setActMsg(`操作结果未知：无法接收回执，操作可能已发生；请刷新后核对，不要盲目重试。${String(e?.message ?? e)}`);
					setTick((n) => n + 1);
					return null;
				} finally {
					setCandBusy('');
				}
			};

			// ── 4. derived data ────────────────────────────────────────────────
			const ws = overview.data?.[0];
			const counts = ws?.counts ?? {};
			// The panel API answers with `results` (see runHealthCheck); accept the
			// older `problems` spelling too so a stale server half cannot blank the
			// health chips silently.
			const health = ws ? { initialized: ws.initialized, failCount: ws.failCount, warnCount: ws.warnCount, results: ws.results ?? ws.problems ?? null } : null;
			const indexText = indexFile.data?.text ?? '';
			const tables = parseIndexTables(indexText);
			const lists = { functions: funcs.data?.files ?? [], insights: insights.data?.files ?? [], dao: daos.data?.files ?? [], capabilities: caps.data?.files ?? [], skills: skills.data?.files ?? [], daily: dailies.data?.files ?? [] };
			// 月/周折叠方案（2026-11）：/list?zone=daily 额外返回月归档（YYYY-MM.md）。
			// 归档行并入 daily 行集（打同一个 /file?zone=daily 接口），旧布局只有
			// files 时行为一分不变。
			const dailyArchive = dailies.data?.archive ?? [];

			useEffect(() => {
				const t = setTimeout(() => setLive(query.trim()), 350);
				return () => clearTimeout(t);
			}, [query]);
			useEffect(() => {
				const t = setInterval(() => setTick((n) => n + 1), 30_000);
				return () => clearInterval(t);
			}, []);
			// SSE channel (2026-11-16): push instead of waiting for the 30s tick.
			// Kept as its OWN effect with no deps so it registers once; receiving an
			// event stores the payload in `sseRef` and bumps `tick`, and every useApi
			// re-reads because `tick` is in its URL. The 30s poll above stays as the
			// floor: if the stream dies, the panel keeps moving (slower, but never
			// frozen) — a monitor that silently stops is worse than a stale one.
			useEffect(() => {
				if (typeof window === 'undefined' || typeof window.EventSource !== 'function') return undefined;
				let es = null;
				let closed = false;
				try {
					es = new window.EventSource(`${API}/stream`);
				} catch {
					return undefined;
				}
				es.addEventListener('overview', (ev) => {
					if (closed) return;
					try {
						const payload = JSON.parse(ev.data);
						SSE_BOX.payload = payload; SSE_BOX.lastEventAt = Date.now();
						// One bump per pushed change: the panel refreshes exactly once.
						setTick((n) => n + 1);
					} catch {
						/* malformed frame: keep the last good payload */
					}
				});
				es.addEventListener('error', () => {
					// Degraded, not dead: stop claiming live. The 30s poll carries on.
					if (!closed) SSE_BOX.lastEventAt = null;
				});
				return () => {
					closed = true;
					try { es?.close(); } catch { /* already closed */ }
				};
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
				// daily 并入月归档行：归档行带 isArchive 标记，ZoneList 据此分进月组。
				let rows = lists[zone].map((f) => ({ ...f, summary: summaryOf(zone, f.name) }));
				if (zone === 'daily') rows = rows.concat(dailyArchive.map((f) => ({ ...f, summary: summaryOf(zone, f.name), isArchive: true })));
				if (q) rows = rows.filter((f) => f.name.toLowerCase().includes(q) || (f.summary ?? '').toLowerCase().includes(q));
				if (zone !== 'daily' && sort === 'name') rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
				else rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
				return rows;
			};

			let timeline = [];
			for (const zone of ['functions', 'insights', 'dao', 'capabilities', 'skills', 'daily'])
				for (const f of zone === 'daily' ? lists[zone].concat(dailyArchive) : lists[zone]) timeline.push({ zone, name: f.name, bytes: f.bytes, mtime: f.mtime, summary: summaryOf(zone, f.name) });
			timeline.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
			timeline = timeline.slice(0, 12);

			const openFile = (zone, name) => {
				if (zone === 'skills' && typeof name === 'string' && name.includes('/')) {
					setView({ kind: 'bundle', name: name.split('/')[0], tab: 'memory' });
				} else {
					setView({ kind: 'file', zone: zone ?? '', name: name ?? null });
				}
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
				if (view.kind === 'candidate') { setDaoView('candidates'); setView({ kind: 'zone', zone: 'dao' }); }
				else if (view.kind === 'file' && view.zone) setView({ kind: 'zone', zone: view.zone });
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

			const activeKey = view.kind === 'overview' ? 'overview' : view.kind === 'arch' ? 'arch' : view.kind === 'inbox' ? 'inbox' : view.kind === 'candidate' ? 'dao' : view.kind === 'zone' ? view.zone : view.kind === 'bundle' ? 'skills' : view.zone === '' ? 'index' : view.zone;

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

			// ── 5. render: pick the view, then the shell ───────────────────────
			let main = null;
			if (live.length >= 2) main = h(SearchPane, { res: search, q: live, zone: searchZone, setZone: setSearchZone, onOpen: openFile });
			else if (!ws && overview.loading) main = h('div', { className: 'dmo-empty' }, '读取记忆体检…');
			else if (overview.error) main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, h('div', { className: 'dmo-empty' }, '总览 API 不可用。'), h(CaptureStatus, { capture: null }));
			else if (!ws) main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, h('div', { className: 'dmo-empty' }, '没有已注册的 workspace。'), h(CaptureStatus, { capture: null }));
			else if (!health?.initialized) main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, h('div', { className: 'dmo-empty' }, '记忆还没有建立。'), h(CaptureStatus, { capture: ws.capture }));
			else if (view.kind === 'inbox') main = h(InboxPane, { res: inboxRes, statusFilter: inboxFilter, setStatusFilter: setInboxFilter, onStateChange: () => setTick((n) => n + 1) });
			// 架构图独用一个 view.kind：它不是"分区列表"，是跨层的结构视图。
			else if (view.kind === 'arch')
				main = h(Architecture, {
					model: buildArchitecture({ counts, usage: overview.data?.[0]?.usage, capture: overview.data?.[0]?.capture, env: overview.data?.[0]?.env, health, sag: overview.data?.[0]?.sag, cycleCoverage: overview.data?.[0]?.cycleCoverage, runtimeSnapshot: overview.data?.[0]?.runtimeSnapshot, patrolDelivery: overview.data?.[0]?.patrolDelivery }),
					// Freshness is read here (not stored in a hook) so the badge always
					// reflects the channel's real state at render time.
					live: sseFreshness().live,
					lastEventAt: SSE_BOX.lastEventAt,
					fallback: !sseFreshness().live,
					// The node passes its resolved TARGET (not a bare key), so a node
					// without a destination can never navigate anywhere.
					onZone: (target) => setView(target),
				});
			else if (view.kind === 'overview') main = h(Overview, { health, counts, timeline, usage: overview.data?.[0]?.usage, env: overview.data?.[0]?.env, capture: overview.data?.[0]?.capture, prose: parseProseSections(indexText), preview, previewQ, setPreviewQ, onOpen: openFile, onZone: (z) => setView({ kind: 'zone', zone: z }), onNavigate: navigate });
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
			else if (view.kind === 'zone') {
				// INDEX PAGE: zone '' is the MEMORY.md registry (its own renderer, and
				// the one place the panel shows index blocks). It has no /list source,
				// so it must be handled BEFORE the zone lookups or it looks unknown.
				if (view.zone === '') {
					main = h(Reader, { view: { zone: '', name: 'MEMORY.md' }, text: indexText, meta: fileMeta, kind: 'index', root: ws.root, onBack: back, onNavigate: navigate });
				} else {
				const zoneRes = { functions: funcs, insights, dao: daos, capabilities: caps, daily: dailies }[view.zone];
				if (zoneRes?.error) main = h('div', { className: 'dmo-empty', role: 'alert' }, `读取分区失败：${zoneRes.error} `, h(Btn, { tone: 'outline', onClick: () => setTick((n) => n + 1) }, '重试'));
				else if (zoneRes?.loading && !zoneRes.data) main = h('div', { className: 'dmo-empty' }, '正在读取分区…');
				// GUARD (2026-11-16): an unknown zone used to fall through with `main`
				// still null — a blank page with no message and no way back. Never leave
				// the reader with nothing: say what happened and offer the way out.
				else if (!zoneRes) {
					main = h(
						'div',
						{ className: 'dmo-empty', role: 'alert', 'data-dmo': 'zone-unknown' },
						`没有这个分区：${String(view.zone ?? '(空)')}。`,
						h(Btn, { tone: 'outline', onClick: () => setView({ kind: 'overview' }) }, '返回总览'),
					);
				}
				else main = h(ZoneList, { zone: view.zone, rows: rowsOf(view.zone), sort, setSort, filter, setFilter, onOpen: openFile, daoView, setDaoView, candidates: candRes.data?.candidates ?? [], candidateState: candRes, onOpenCandidate: (name) => setView({ kind: 'candidate', name }), onRetry: () => setTick((n) => n + 1), candidateAction, candBusy, actMsg, onDeleteDao: deleteDao, openArchive: archiveOpenName, onToggleArchive: (name) => setArchiveOpenName((cur) => (cur === name ? null : name)), archiveDays });
				}
			}
			else if (view.kind === 'candidate') {
				if (candidateDetail.error) main = h('div', { className: 'dmo-empty', role: 'alert' }, `候选正文读取失败：${candidateDetail.error} `, h(Btn, { tone: 'outline', onClick: () => setTick((n) => n + 1) }, '重试'), h(Btn, { onClick: back }, '返回'));
				else if (candidateDetail.data?.text !== undefined) main = h(Reader, { view: { zone: 'dao', name: `${view.name}.md`, candidate: true }, text: candidateDetail.data.text, meta: null, kind: 'dao', root: ws.root, onBack: back, onNavigate: navigate });
				else main = h('div', { className: 'dmo-empty' }, '正在读取候选正文…');
			}
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
					h(
						'div',
						{ className: 'dmo-hero' },
						h(
							'div',
							{ className: 'dmo-hero-eyebrow' },
							h('span', { className: 'dmo-pill' }, `v${ws?.env?.version || '—'}`),
							h('span', null, '心智系统'),
						),
						h('h1', { className: 'dmo-title' }, '心智管理'),
						h('p', { className: 'dmo-sub' }, `${displayCount(counts.functions)} 功能 · ${displayCount(counts.insights)} 思想 · ${displayCount(counts.dao)} 道 · ${displayCount(counts.capabilities)} 能力 · ${displayCount(counts.skills)} 技能 · ${displayCount(counts.daily)} 日线索`),
					),
					h(
						'div',
						{ className: 'dmo-header-side' },
						h(
							'div',
							{ className: 'dmo-statusbar', 'data-dmo': 'statusbar' },
							h('span', { className: knownCount(ws?.failCount) === null ? 'dmo-dot' : ws.failCount > 0 ? 'dmo-dot fail' : 'dmo-dot ok' }, h('i'), knownCount(ws?.failCount) === null ? 'FAIL 未知' : ws.failCount > 0 ? `FAIL ${ws.failCount}` : '无 FAIL'),
							h('span', { className: knownCount(ws?.warnCount) === null ? 'dmo-dot' : ws.warnCount > 0 ? 'dmo-dot warn' : 'dmo-dot ok' }, h('i'), knownCount(ws?.warnCount) === null ? 'WARN 未知' : ws.warnCount > 0 ? `WARN ${ws.warnCount}` : '无警告'),
							h('span', { className: 'dmo-dot' }, h('i'), `${displayCount(counts.functions)} 功能 / ${displayCount(counts.insights)} 思想 / ${displayCount(counts.dao)} 道`),
						),
						h(
							'div',
							{ className: 'dmo-hero-actions' },
							h(
								'label',
								{ className: 'dmo-search' },
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
									setReloadMsg('已启动重载，请稍后核验');
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
					),
				),
				h(
					'div',
					{ className: 'dmo-body' },
					h(
						'div',
						{ className: 'dmo-tabs', role: 'tablist' },
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
										: n.key === 'arch'
											? null
											: counts[n.key];
							return h(
								'button',
								{
									key: n.key, type: 'button', 'data-dmo': 'nav-item',
									className: `dmo-nav${activeKey === n.key ? ' active' : ''}`,
									onClick: () => { setFilter(''); setQuery(''); setLive(''); if (n.key === 'overview') setView({ kind: 'overview' }); else if (n.key === 'arch') setView({ kind: 'arch' }); else if (n.key === 'inbox') setView({ kind: 'inbox' }); else if (n.key === 'index') openFile('', null); else setView({ kind: 'zone', zone: n.key }); },
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
						{ name: 'sidebar.panellist', id: 'memory-panel', order: 50, label: '心智管理' },
						MemoryIcon,
					),
				);
				ctx.slots.inject('main', () =>
					ctx.slots.register({ name: 'main', key: 'memory-panel' }, MemoryPanel),
				);
			},
			// Pure view logic, exposed so ui-test.mjs can assert the panel's
			// parsing/folding behaviour without a browser.
			__internalsForTest: { relTime, plain, parseIndexTables, parseProseSections, splitSections, subTablesOf, resolveHref, defaultOpen, SearchPane, RecallPreviewCard, reverseBullets, highlight, tokenizeCode, ZoneList, SkillLibrary, dailyMonthGroups, weekLabelOf, isoWeekOf, DailyMonthList, Architecture, buildArchitecture },
		};
	},
});
