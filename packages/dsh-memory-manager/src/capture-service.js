import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { localDateStr, writeText } from './util.js';
import { dailyTemplate } from './markdown.js';
import { redactSecrets } from './secrets.js';
import { hasCaptureMarker } from './capture-events.js';
import { withCaptureMutex } from './capture-mutex.js';
import { verifyCaptureBaseline } from './capture-baseline.js';
import { assertNoCaptureIntent, beginCaptureIntent, finishCaptureIntent } from './capture-intent.js';

/**
 * Persist selected messages under a cooperating cross-process mutex. Each
 * marker is only an event-deduplication hint; neither source.kind nor a marker
 * authenticates a producer. No automatic recovery is attempted. The caller
 * serializes its own process and observes the returned promise.
 */
export async function captureSelectedEvents(root, events) {
	return withCaptureMutex(root, async () => {
		await assertNoCaptureIntent(root);
		const day = localDateStr();
		const key = `${day}.md`;
		const file = path.join(root, key);
		let info;
		try { info = await lstat(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
		if (info && (!info.isFile() || info.nlink > 1)) throw Object.assign(new Error('每日记录不是独立普通文件'), { code: 'CAPTURE_UNSAFE_DAILY' });
		let before;
		if (info) {
			const bytes = await readFile(file);
			before = bytes.toString('utf8');
			if (!Buffer.from(before, 'utf8').equals(bytes)) throw Object.assign(new Error('每日记录不是可无损解码的 UTF-8'), { code: 'CAPTURE_HISTORY_ENCODING' });
		}
		await verifyCaptureBaseline(root, key, before);
		const current = before ?? dailyTemplate(day);
		const outcomes = [];
		const entries = [];
		for (const event of events) {
			if (hasCaptureMarker(current, event.marker)) { outcomes.push('duplicate'); continue; }
			// Flatten all newline forms and controls so a user cannot create a
			// standalone synthetic marker line via the captured text.
			const safeLine = event.text.replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim();
			entries.push(`- ${safeLine}\n${event.marker}\n`);
			outcomes.push('confirmed');
		}
		if (!entries.length) return outcomes;
		const next = `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${entries.join('')}`;
		const redacted = redactSecrets(next).text;
		if (redacted !== next) {
			const code = !redacted.startsWith(current) ? 'CAPTURE_HISTORY_REDACTION' : 'CAPTURE_INPUT_REDACTION';
			throw Object.assign(new Error('采集写入会改变既有正文或再触发脱敏，未修改每日记录'), { code });
		}
		const intent = await beginCaptureIntent(root, day);
		// On any uncertain/failed file or ledger acknowledgement, retain the
		// witness and refuse the next attempt; do not retry or auto-repair.
		await writeText(file, next, { memoryRoot: root });
		await finishCaptureIntent(intent);
		return outcomes;
	});
}
