// test/index.js: entry point for `node --test test/` (package.json "test").
//
// Node >= 21 no longer expands a directory argument of `node --test`: it runs the directory as a module
// path, which Node resolves to this index.js. Node 20 expands the directory recursively and runs every
// file in it by itself, so there this file must stay empty or the suites would run twice.
//
// Each suite folder has its own index.js for the same reason; this file loads them all in one process.
// Explicit patterns work on every version and do not need this file:
//   node --test test/source/ test/model/ test/server/ test/demo/ test/integration/ test/plugin/ "test/workflows/*.test.mjs"

const major = Number(process.versions.node.split('.')[0]);

if (major >= 21) {
  for (const suite of ['source', 'model', 'server', 'demo', 'integration', 'workflows', 'plugin']) {
    await import(new URL(`./${suite}/index.js`, import.meta.url).href);
  }
}
