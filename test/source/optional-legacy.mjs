// Optional check against a real Claude Code 2.1.206 run, read in place and read-only. Kept out of
// `node --test test/source/` on purpose (no `.test.` in the file name, and index.js loads only
// *.test.mjs): the suite must not report a skipped test just because this machine has no such run.
// The synthetic legacy fixture is checked the same way in claude-fs-replay.test.mjs.
//
// Run it by hand with a run directory <session>/subagents/workflows/<runId>:
//   WFVIZ_LEGACY_RUN_DIR=/path/to/run node --test test/source/optional-legacy.mjs
import test from 'node:test';
import path from 'node:path';
import { checkRealRun } from './fixture-helpers.mjs';

const legacyDir = process.env.WFVIZ_LEGACY_RUN_DIR;

test('real legacy run from WFVIZ_LEGACY_RUN_DIR (read-only)', { skip: legacyDir ? false : 'WFVIZ_LEGACY_RUN_DIR is not set' }, async () => {
  await checkRealRun(path.resolve(legacyDir));
});
