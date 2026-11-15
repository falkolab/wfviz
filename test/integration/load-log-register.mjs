// Preload for a child process (node --import <this file>): appends the URL of every module the process
// resolves to the file named by WFVIZ_TEST_LOADLOG. Not a test file.
//
// module.registerHooks() (synchronous, in-thread) where Node has it (v22.15 / v23.5 and later);
// module.register() with an off-thread hooks file before that. The second is deprecated from Node 25 on and
// prints a warning, so it is only the fallback.
//
// The namespace import is deliberate: `import { registerHooks } from 'node:module'` is a link-time SyntaxError
// on a Node that lacks the export, and then not even the fallback below would get to run.
import { appendFileSync } from 'node:fs';
import * as nodeModule from 'node:module';

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (process.env.WFVIZ_TEST_LOADLOG) appendFileSync(process.env.WFVIZ_TEST_LOADLOG, `${result.url}\n`);
      return result;
    },
  });
} else if (typeof nodeModule.register === 'function') {
  nodeModule.register('./load-log-hooks.mjs', import.meta.url);
}
// Neither exists before Node 20.6: nothing is logged, and the tests that read the log are skipped there
// (CAN_LOG_MODULE_LOADS in helpers.mjs); the static checks of the launcher source still run.
