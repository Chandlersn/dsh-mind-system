/**
 * The labelled case set shared by the DR-17 verdict and the vocabulary tuner.
 *
 * `needsHelp` answers one question: *would the runtime's assistance address this step?*
 * It is a judgement about the step, not about the detector, and it is not produced by running
 * anything. That is what makes it usable as an independent label.
 *
 * The text is the real failure message, phrased the way tools actually phrase it. Cases were
 * written WITHOUT consulting the detector's word list: an earlier version of this set made every
 * positive case contain a keyword and every negative case avoid them, which produced a perfect
 * score and measured nothing. Writing the text first and labelling the step second is the only
 * way the result says something about the detector.
 *
 * Negative cases fall into two groups on purpose:
 *   - ordinary mistakes the design explicitly ignores (typo, syntax, permission, missing arg)
 *   - failures that LOOK like detector vocabulary but are not recoverable steps
 *     (`timeout waiting for the language server`), which is where a keyword list can go wrong
 */
export const CASES = Object.freeze([
  // ---- genuinely runtime-shaped: the step failed in a way the runtime can address ----
  { id: 'artifact-mismatch', text: 'the produced artifact does not match what the task declared', needsHelp: true },
  { id: 'ledger-gap', text: 'the write landed on disk but no ledger row was recorded for it', needsHelp: true },
  { id: 'crash-midway', text: 'the process died with 3 of 7 files written', needsHelp: true },
  { id: 'stale-cursor', text: 'the checkpoint cursor no longer matches the journal entries', needsHelp: true },
  { id: 'deadline', text: 'killed after the deadline while the tool was still running', needsHelp: true },
  { id: 'cap-reached', text: 'attempts_used reached the per-run cap; no further attempt is allowed', needsHelp: true },
  { id: 'compensation-unsettled', text: 'the compensation step did not settle the target fact', needsHelp: true },
  { id: 'double-claim', text: 'two attempts claim the same fence token', needsHelp: true },
  { id: 'dispatch-vanished', text: 'dispatch entered but no executor recorded the call', needsHelp: true },
  { id: 'needs-rollback', text: 'the previous change must be undone before this task can proceed', needsHelp: true },
  { id: 'same-input-twice', text: 'the same command failed twice with an identical message', needsHelp: true },
  { id: 'tool-half-ran', text: 'the tool reported success but the output file is only half written', needsHelp: true },

  // ---- ordinary mistakes the design says to ignore ----
  { id: 'typo-path', text: 'cannot read "D:\\work\\src\\indxe.js": the file does not exist', needsHelp: false },
  { id: 'syntax-error', text: 'SyntaxError: Unexpected token } in the module body', needsHelp: false },
  { id: 'missing-arg', text: 'invalid arguments: missing required property "file_path"', needsHelp: false },
  { id: 'old-string', text: 'old_string was not found in the target file', needsHelp: false },
  { id: 'perm-denied', text: 'EACCES: permission denied writing to the profile directory', needsHelp: false },
  { id: 'net-down', text: 'Could not connect to server:443 after 21260 ms', needsHelp: false },
  { id: 'no-match', text: 'rg: no matches found for the pattern in the tree', needsHelp: false },
  { id: 'bad-flag', text: 'unknown option --frobnicate for this command', needsHelp: false },
  { id: 'enc-issue', text: 'the file is not valid UTF-8; decoding stopped at byte 12', needsHelp: false },
  { id: 'tool-missing', text: 'command not found: ffprobe is not on PATH', needsHelp: false },

  // ---- contains detector vocabulary but is not a recoverable step: the false-alarm traps ----
  { id: 'ls-timeout', text: 'timeout waiting for the language server to index the workspace', needsHelp: false },
  { id: 'lint-verification', text: 'verification step skipped: no linter configured for this file type', needsHelp: false },
  { id: 'user-retry', text: 'the user asked to retry the search with a narrower query', needsHelp: false },
  { id: 'git-partial', text: 'partial output shown: use --all to see the remaining entries', needsHelp: false },
]);
