// Module-resolution hook of the integration tests (not a test file): appends the URL of every module
// the child process resolves to the file named by WFVIZ_TEST_LOADLOG. Loaded by load-log-register.mjs.
import { appendFileSync } from 'node:fs';

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const log = process.env.WFVIZ_TEST_LOADLOG;
  if (log) appendFileSync(log, `${result.url}\n`);
  return result;
}
