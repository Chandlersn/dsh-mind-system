import { defineTool } from './host.js';
import { reviewState, recordReview, readReceipt } from './distill-reviews.js';
import { withMemoryRootTransaction } from './root-transaction.js';

const text = { type: 'string' };
const integer = { type: 'integer' };
const object = properties => ({ type: 'object', additionalProperties: false, properties });
const section = object({ day: text, path: text, startLine: integer, endLine: integer });
const receiptFields = { candidate: text, materialVersion: text, reviewedAt: text, conclusion: text };
const receipt = object(receiptFields);
const candidateSchema = object({ ...receiptFields, reviewed: {type:'boolean'}, sectionCount: integer, sections: { type:'array', items: section } });
const publicReceipt = r => ({candidate:r.candidate, materialVersion:r.materialVersion, reviewedAt:r.reviewedAt, conclusion:r.conclusion});

export function distillReviewTool(root, scan, invalidate) {
  return defineTool({
    name: 'memory_distill_review',
    description: 'List R28 material versions and source line ranges. Review the cited original material, then record a conclusion for the exact current version. Matching versions suppress further reminders. A review is a caller declaration. An exact historical receipt can be read by candidate and version.',
    parameters: {
      action: { type:'string', required:true, enum:['list','review','receipt'] },
      candidate: { type:'string', description:'Exact candidate from list. Optional on list to focus source ranges.' },
      materialVersion: { type:'string', description:'Exact 64-hex version for review or receipt.' },
      conclusion: { type:'string', description:'For review, original conclusion with reasoning, 1–4000 characters.' },
      offset: { type:'integer', description:'Source range offset on list, default 0. Each candidate returns up to 24 ranges.' },
    },
    output: { schema: object({ complete:{type:'boolean'}, note:text, candidates:{ type:'array', items:candidateSchema }, receipt }),
      render: (_args,v) => [{ type:'text', text:JSON.stringify(v) }] },
    async execute(args) {
      if (args.action === 'receipt') {
        if (!args.candidate || !/^[a-f0-9]{64}$/.test(args.materialVersion ?? '')) throw Error('请指定候选与完整版本');
        const r = await readReceipt(root(), args.candidate, args.materialVersion);
        return r ? {receipt: publicReceipt(r)} : {note:'未找到该版本的回执'};
      }
      if (args.action === 'review') {
        const r = await withMemoryRootTransaction(root(), () => recordReview(root(), args.candidate, args.materialVersion, args.conclusion, scan));
        invalidate();
        return {receipt:publicReceipt(r)};
      }
      if (args.action !== 'list') throw Error('未知审阅操作');
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw Error('offset 须为非负整数');
      const state = await reviewState(root(), await scan());
      const rows = args.candidate ? state.list.filter(row => row.candidate === args.candidate) : state.list;
      return { complete:state.complete, ...(state.complete ? {} : {note:state.pending.skipped || '扫描截断或有来源无法读取，审阅暂不可提交'}), candidates: rows.map(row => ({
        candidate:row.candidate, materialVersion:row.materialVersion, reviewed:!!row.receipt, sectionCount:row.sections.length,
        sections:row.sections.slice(offset, offset+(args.candidate ? 24 : 1)), ...(row.receipt ? {conclusion:row.receipt.conclusion,reviewedAt:row.receipt.reviewedAt} : {})
      })) };
    },
  });
}
