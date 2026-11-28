import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArchiveBoundaries } from './daily-archive.js';

const AREA_MODULES = {
	'memory-manager': /(?:\bmemory_(?:read|write|index|insight|dao|capability|check|fold|rename|usage|federation|skill|inbox|sag|search)\b|MEMORY\.md|回忆|召回|索引行|蒸馏|体检|面板|usage|漏判)/i,
	'dsh插件开发': /(cordis|inject|ctx\.get|healthProbe|宿主契约|插件(?:开发|装载)|apply\s*\(|webServer)/i,
	'心智编排层': /(mind-system|五成员|valve_check|valve_confirm|valve_nominate|valve_govern|候选公理|UPGRADE-PLAN|主线|阶段\s*[IVX]+)/i,
	'clis因果分层系统': /(\bCLIS\b|clis_classify|clis_run|clis_plan|因果结构|介入)/i,
	'批印坊工程加固': /(批印坊|printpress)/i,
	'dsh视频工坊': /(视频工坊|video-studio|openfilm)/i,
	'宣传片制作': /(宣传片|视频管线|出片|ffmpeg|逐帧渲染|成片)/i,
	'学习模式插件': /(学习模式|掌握式|课程页)/i,
	'purrge与系统管理': /(purrge|空间管家)/i,
	'meta框架契约包': /(meta-framework|契约包)/i,
};
const matchesArea = (area, body) => {
	if (body.includes(area.name)) return true;
	return Object.hasOwn(AREA_MODULES, area.name) && AREA_MODULES[area.name].test(body);
};

const LIMITS = { maxEntries: 16384, maxFiles: 2048, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024, maxReferences: 8192 };
const validDay = day => {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
};

function* sections(raw, firstLine) {
  let start = 0, line = firstLine, startLine = line, fence;
  for (const match of raw.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) break;
    const text = match[0].trimEnd();
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) fence = marker[1];
    else if (/^##\s+\S/.test(text) && match.index > start) {
      yield { raw: raw.slice(start, match.index), startLine, endLine: line - 1 };
      start = match.index; startLine = line;
    }
    line++;
  }
  if (start < raw.length) yield { raw: raw.slice(start), startLine, endLine: line - 1 };
}

export async function detectDistillationBacklog(root, opts = {}, options = {}) {
  const limit = Object.fromEntries(Object.entries(LIMITS).map(([key, max]) => [key, Number.isSafeInteger(options[key]) ? Math.max(1, Math.min(max, options[key])) : max]));
  const reasons = new Set(), issues = [], areas = [], groups = new Map();
  let readUnknown = 0, entries = 0, files = 0, bytesRead = 0, references = 0;
  function unknown(file, reason) {
    readUnknown++;
    if (issues.length < 20) issues.push({path:file, reason});
  }
  async function list(dir, regex) {
    const target = path.join(root, dir), names = [];
    try {
      if (!(await lstat(target)).isDirectory()) throw Object.assign(Error(), {code:'ENOTDIR'});
      const stream = await opendir(target);
      for await (const entry of stream) {
        if (++entries > limit.maxEntries) { reasons.add('maxEntries'); break; }
        if (regex.test(entry.name)) names.push(entry.name);
      }
    } catch (err) { if (err.code !== 'ENOENT' || !dir) throw Object.assign(err,{scanDir:dir}); }
    return names.sort();
  }
  async function load(file) {
    if (++files > limit.maxFiles) { reasons.add('maxFiles'); return; }
    const p = path.join(root, file);
    let handle;
    try {
      const stat = await lstat(p);
      if (!stat.isFile() || await realpath(p) !== p) throw Error('non_regular_path');
      if (stat.size > limit.maxFileBytes) { reasons.add('maxFileBytes'); return; }
      if (bytesRead + stat.size + 1 > limit.maxTotalBytes) { reasons.add('maxTotalBytes'); return; }
      handle = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw Error('changed_file');
      const buf = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buf.length) {
        const result = await handle.read(buf, offset, buf.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      bytesRead += offset;
      if (offset !== stat.size || (await handle.stat()).mtimeMs !== stat.mtimeMs) throw Error('changed_file');
      return new TextDecoder('utf-8', {fatal:true,ignoreBOM:true}).decode(buf.subarray(0,offset));
    } catch (err) { unknown(file, err.code ?? err.message); } finally { await handle?.close(); }
  }
  const material = new Map();
  try {
    root = await realpath(root);
    for (const f of await list('functions', /\.md$/)) {
      const text = await load(`functions/${f}`);
      if (text === undefined) continue;
      const dates = [...text.matchAll(/^##\s*\[(\d{4}-\d{2}-\d{2})/gm)].map(m => m[1]).sort();
      areas.push({ name:f.slice(0,-3), newestBlock:dates.at(-1) ?? null });
    }
    const daily = await list('', /^\d{4}-\d{2}-\d{2}\.md$/);
    const top = new Set(daily.map(f => f.slice(0,-3)));
    for (const f of daily) {
      const day = f.slice(0,-3);
      if (!validDay(day)) { unknown(f,'invalid_date'); continue; }
      const raw = await load(f);
      if (raw !== undefined) material.set(day,{raw,path:f,firstLine:1});
    }
    for (const f of await list('daily', /^\d{4}-\d{2}\.md$/)) {
      const file = `daily/${f}`, text = await load(file);
      if (text === undefined) continue;
      const parsed = parseArchiveBoundaries(text);
      if (parsed.status !== 'parsed' || !parsed.boundaries.some(b=>b.day)) { unknown(file, parsed.reason ?? 'no_day_sections'); continue; }
      for (const [i,b] of parsed.boundaries.entries()) {
        if (!b.day) continue;
        if (!validDay(b.day) || b.day.slice(0,7) !== f.slice(0,7)) { unknown(file,`invalid_archive_date:${b.day}`); continue; }
        if (top.has(b.day)) continue;
        const end = parsed.boundaries[i+1]?.line ?? parsed.lines.length;
        const raw = parsed.lines.slice(b.line+1,end).join('\n') + (end < parsed.lines.length ? '\n' : '');
        material.set(b.day,{raw,path:file,firstLine:b.line+2});
      }
    }
  } catch (err) { return { due:[], orphan:[], skipped:`${err.scanDir ?? 'memory'} 枚举失败（${err.code ?? 'unknown'}）` }; }
  let days = [...material.keys()].sort();
  if (Number.isSafeInteger(options.windowDays) && options.windowDays > 0 && days.length > options.windowDays) {
    days = days.slice(-options.windowDays); reasons.add('windowDays');
  }
  groupLoop: for (const day of days) {
    const m = material.get(day);
    for (const section of sections(m.raw,m.firstLine)) {
      if (!section.raw.trim() || /^\s*# [^\n]+\s*$/.test(section.raw)) continue;
      const hits = areas.filter(area => matchesArea(area,section.raw));
      const digest = createHash('sha256').update(section.raw).digest('hex');
      const ref = {day,path:m.path,startLine:section.startLine,endLine:section.endLine};
      for (const area of hits.length ? hits : [null]) {
        if (++references > limit.maxReferences) { reasons.add('maxReferences'); break groupLoop; }
        const name = area?.name ?? null;
        if (!groups.has(name)) groups.set(name,{hash:createHash('sha256').update(JSON.stringify(['distill-material-v1',name])),days:new Set(),bytes:0,sections:[],area});
        const g = groups.get(name);
        g.hash.update(JSON.stringify([day,digest]));
        g.days.add(day); g.bytes += Buffer.byteLength(section.raw); g.sections.push(ref);
      }
    }
  }
  const due = [], orphan = [];
  for (const g of groups.values()) {
    if (g.days.size < (options.minDays ?? 3) || g.bytes < (options.minBytes ?? 400)) continue;
    const fields = {days:[...g.days],bytes:g.bytes,sections:g.sections,materialVersion:g.hash.digest('hex')};
    if (g.area) due.push({area:g.area.name,newestBlock:g.area.newestBlock,...fields});
    else orphan.push({topic:'未归属素材',...fields});
  }
  return {due,orphan,...(readUnknown ? {readUnknown,issues} : {}), truncated:reasons.size > 0, truncationReasons:[...reasons], daysScanned:days.length};
}
