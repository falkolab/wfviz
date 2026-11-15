import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScriptMeta } from '../../src/source/script-meta.mjs';
import { parseScriptMeta as reExported } from '../../src/source/claude-fs.mjs';

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

function findFiles(dir, re, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) findFiles(p, re, out);
    else if (re.test(ent.name)) out.push(p);
  }
  return out.sort();
}

test('claude-fs.mjs re-exports parseScriptMeta (contract section 5)', () => {
  assert.equal(reExported, parseScriptMeta);
});

test('parses the meta of the real probe scripts in fixtures/claude-projects', () => {
  const scripts = findFiles(path.join(FIXTURES, 'claude-projects'), /-wf_.+\.js$/);
  assert.equal(scripts.length, 2);
  const byName = Object.fromEntries(scripts.map((f) => [path.basename(f), parseScriptMeta(fs.readFileSync(f, 'utf8'))]));

  const probe1 = byName['probe-event-format-wf_6509ce25-20a.js'];
  assert.deepEqual(probe1, {
    name: 'probe-event-format',
    description: 'Tiny probe: 2 parallel agents, then a dependent judge, then a 2-round loop; checks what files appear during a run',
    phases: [{ title: 'Fanout', detail: 'two independent reviewers' }, { title: 'Judge' }, { title: 'Loop' }],
  });

  const probe2 = byName['probe-edge-cases-wf_26eb8d70-5c4.js'];
  assert.equal(probe2.name, 'probe-edge-cases');
  assert.match(probe2.description, /^Probe 2: pipeline overlap/);
  assert.deepEqual(probe2.phases, [{ title: 'Pipe' }, { title: 'Errors' }]);
});

test('parses the meta of the synthetic legacy script', () => {
  const [file] = findFiles(path.join(FIXTURES, 'synthetic', 'legacy-2.1.206'), /-wf_.+\.js$/);
  assert.deepEqual(parseScriptMeta(fs.readFileSync(file, 'utf8')), {
    name: 'legacy-demo',
    description: 'Synthetic run shaped like Claude Code 2.1.206 output',
    phases: [{ title: 'Sweep' }, { title: 'Synthesize' }],
  });
});

test('parses the meta of this project\'s own workflow script when present', { skip: !fs.existsSync(new URL('../../workflows/dev-graph.js', import.meta.url)) }, () => {
  const meta = parseScriptMeta(fs.readFileSync(new URL('../../workflows/dev-graph.js', import.meta.url), 'utf8'));
  assert.equal(meta.name, 'wfviz-dev-graph');
  assert.ok(Array.isArray(meta.phases) && meta.phases.length >= 5);
  assert.ok(meta.phases.every((p) => typeof p.title === 'string'));
});

test('accepts the literal subset: quotes, template, comments, trailing commas, unquoted and quoted keys, numbers, booleans, null', () => {
  const text = `
// leading comment
'use strict'
/* block */ export const meta = {
  name: "double", // trailing comment
  'description': \`template
with newline\`,
  /* inside */ phases: [
    { title: 'A\\'s', detail: 'tab\\there', },
    { title: "B" },
  ],
  retries: 3, ratio: -1.5e2, hex: 0x1f, flag: true, off: false, nothing: null,
  "quoted-key": 'v', 7: 'seven',
}
const x = 1
`;
  const meta = parseScriptMeta(text);
  assert.deepEqual(meta, {
    name: 'double',
    description: 'template\nwith newline',
    phases: [{ title: "A's", detail: 'tab\there' }, { title: 'B' }],
    retries: 3, ratio: -150, hex: 31, flag: true, off: false, nothing: null,
    'quoted-key': 'v', 7: 'seven',
  });
});

test('works without `export` and with no spaces around =', () => {
  assert.deepEqual(parseScriptMeta("const meta={name:'n'}"), { name: 'n' });
});

test('string concatenation and escapes', () => {
  const meta = parseScriptMeta(`export const meta = { name: 'a' + "b" + \`c\`, description: 'x\\u0041\\x42\\u{1F600}\\\n y' }`);
  assert.equal(meta.name, 'abc');
  assert.equal(meta.description, 'xAB\u{1F600} y');
});

test('keeps unknown fields and does not invent missing ones', () => {
  const meta = parseScriptMeta("export const meta = { name: 'n', whenToUse: 'later', extra: { a: [1, 2] } }");
  assert.deepEqual(meta, { name: 'n', whenToUse: 'later', extra: { a: [1, 2] } });
  assert.equal('phases' in meta, false);
  assert.equal('description' in meta, false);
});

test('a "__proto__" key becomes an own property and does not touch the prototype', () => {
  const meta = parseScriptMeta("export const meta = { name: 'n', __proto__: { polluted: true } }");
  assert.equal(Object.getPrototypeOf(meta), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(meta.polluted, undefined);
  assert.deepEqual(Object.keys(meta), ['name', '__proto__']);
});

test('ignores look-alike declarations in comments, strings and templates; takes the first real one', () => {
  const text = `
// export const meta = { name: 'in line comment' }
/* export const meta = { name: 'in block comment' } */
const s = "export const meta = { name: 'in string' }"
const t = \`export const meta = { name: 'in template \${ 'nested \`const meta = {name:1}\`' } ' }\`
export const meta = { name: 'real' }
export const meta2 = { name: 'later' }
`;
  assert.deepEqual(parseScriptMeta(text), { name: 'real' });
});

test('never executes the script', () => {
  globalThis.__wfvizExecuted = false;
  const text = "globalThis.__wfvizExecuted = true\nexport const meta = { name: 'n', description: (globalThis.__wfvizExecuted = true, 'x') }";
  assert.equal(parseScriptMeta(text), null);
  assert.equal(globalThis.__wfvizExecuted, false);
  delete globalThis.__wfvizExecuted;
});

test('returns null when meta is missing or not a pure literal', () => {
  const nulls = {
    'no meta': "phase('x'); agent('y')",
    'empty text': '',
    'not a string': undefined,
    'identifier value': "const N = 'n'\nexport const meta = { name: N }",
    'function call': "export const meta = { name: String('n') }",
    'template interpolation': 'export const meta = { name: `a${1}` }',
    'spread': "const o = {}\nexport const meta = { ...o }",
    'computed key': "export const meta = { ['a']: 1 }",
    'shorthand': "const name = 1\nexport const meta = { name }",
    'method': 'export const meta = { name() {} }',
    'arrow function': 'export const meta = { name: () => 1 }',
    'array holes': 'export const meta = { phases: [,] }',
    'number plus string': "export const meta = { name: 1 + 'a' }",
    'undefined': 'export const meta = { name: undefined }',
    'unterminated object': "export const meta = { name: 'n'",
    'unterminated string': "export const meta = { name: 'n }",
    'unterminated comment': "export const meta = { name: 'n' /* ",
    'array root': 'export const meta = [1, 2]',
    'string root': "export const meta = 'x'",
    'null root': 'export const meta = null',
    'octal escape': "export const meta = { name: '\\12' }",
    'bad unicode escape': "export const meta = { name: '\\u12' }",
    'missing colon': "export const meta = { name 'n' }",
    'missing comma': "export const meta = { name: 'n' description: 'd' }",
  };
  for (const [what, text] of Object.entries(nulls)) assert.equal(parseScriptMeta(text), null, what);
});

test('deeply nested literals fail cleanly instead of overflowing the stack', () => {
  const deep = `export const meta = { a: ${'['.repeat(5000)}${']'.repeat(5000)} }`;
  assert.equal(parseScriptMeta(deep), null);
});

test('deeply nested template interpolations do not overflow the stack (the masking pass is not recursive)', () => {
  for (const levels of [5000, 20000, 100000]) {
    const nest = `${'`${'.repeat(levels)}${'}`'.repeat(levels)}`;
    assert.deepEqual(parseScriptMeta(`${nest}\nexport const meta = { name: 'x' }`), { name: 'x' }, `${levels} levels, balanced`);
    // never closed: not valid JavaScript, any answer will do, but no throw
    assert.doesNotThrow(() => parseScriptMeta(`${'`${'.repeat(levels)}\nexport const meta = { name: 'x' }`), `${levels} levels, unterminated`);
  }
  // the same depth of other brackets inside a template expression
  const braces = `\`\${${'{'.repeat(20000)}${'}'.repeat(20000)}}\``;
  assert.deepEqual(parseScriptMeta(`${braces}\nexport const meta = { name: 'y' }`), { name: 'y' });
});

test('regex literals are code: a backtick, quote, // or /* inside one does not mask the real meta', () => {
  const cases = {
    'backtick': 'const re = /`/;\nexport const meta = {name:"x"}\nconst s = `x`;',
    'slash-star in a class': 'const re = /[/*]/;\nexport const meta = {name:"x"}\n/* end */',
    'single quote': "const re = /'/;\nexport const meta = {name:'x'}\nconst s = 'a';",
    'double quote': 'const re = /"/g;\nexport const meta = {name:"x"}\nconst s = "a";',
    'double slash in a class': 'const re = /[/][/]/;\nexport const meta = {name:"x"}\nconst s = 1; // c',
    'escaped slash': 'const re = /a\\/`b/;\nexport const meta = {name:"x"}\nconst s = `x`;',
    'flags': 'const re = /`/gimsuy;\nexport const meta = {name:"x"}\nconst s = `x`;',
    'after return': 'function f() { return /`/ }\nexport const meta = {name:"x"}\nconst s = `x`;',
    'after an open paren and a comma': 'g(/`/, /\'/)\nexport const meta = {name:"x"}\nconst s = `x`;',
    'after a closing brace': 'if (a) { b() }\n/`/.test(c)\nexport const meta = {name:"x"}\nconst s = `x`;',
    'inside a template expression': 'const t = `a${ /`/.test(b) }c`;\nexport const meta = {name:"x"}\nconst s = `x`;',
  };
  for (const [what, text] of Object.entries(cases)) assert.deepEqual(parseScriptMeta(text), { name: 'x' }, what);
});

test('a division is not taken for a regex; a stray slash does not hide the meta', () => {
  const cases = {
    'two divisions on a line': 'const a = b / c / d;\nexport const meta = {name:"x"}\nconst s = `x`;',
    'division then a quote in a comment': "const a = b / 2; // it's\nexport const meta = {name:\"x\"}\nconst s = 'a';",
    'division after a paren': 'const a = (b) / 2, c = d[0] / 3;\nexport const meta = {name:"x"}',
    'division after a postfix operator': 'i++ / 2 / 3\nexport const meta = {name:"x"}',
    'division after a closing brace': 'const a = { b }/ 2;\nexport const meta = {name:"x"}',
  };
  for (const [what, text] of Object.entries(cases)) assert.deepEqual(parseScriptMeta(text), { name: 'x' }, what);
});

test('only a top-level declaration is the script\'s meta', () => {
  assert.deepEqual(parseScriptMeta("function f(){ const meta = { name: 'inner' } }\nexport const meta = { name: 'outer' }"), { name: 'outer' });
  assert.deepEqual(parseScriptMeta("const f = () => { const meta = { name: 'inner' }; return meta }\nexport const meta = { name: 'outer' }"), { name: 'outer' });
  assert.deepEqual(parseScriptMeta("{ const meta = { name: 'block' } }\nconst meta = { name: 'plain' }"), { name: 'plain' });
  assert.equal(parseScriptMeta("function f(){ const meta = { name: 'inner' } }"), null, 'a nested meta alone is no meta');
  assert.equal(parseScriptMeta("if (x) { export const meta = { name: 'block' } }"), null);
  assert.equal(parseScriptMeta("run(() => { const meta = { name: 'inner' } })"), null);
  assert.deepEqual(parseScriptMeta("const o = { a: [1, (2)] }\nexport const meta = { name: 'after brackets' }"), { name: 'after brackets' });
});

test('a template literal cooks CR LF and a lone CR to LF, like JavaScript', () => {
  assert.equal(parseScriptMeta('export const meta = { description: `a\r\nb` }').description, 'a\nb');
  assert.equal(parseScriptMeta('export const meta = { description: `a\rb\r\n\r\nc` }').description, 'a\nb\n\nc');
  assert.equal(parseScriptMeta('export const meta = { description: `a\\\r\nb` }').description, 'ab', 'a line continuation still joins the lines');
  assert.equal(parseScriptMeta('export const meta = {\r\n  name: "n",\r\n  description: `l1\r\nl2`,\r\n}\r\nphase("x")\r\n').description, 'l1\nl2');
  assert.equal(parseScriptMeta('export const meta = { description: `a b` }').description, 'a b', 'U+2028 stays');
});

test('the initializer must end at the literal: a member access, operator or call after it is not a pure literal', () => {
  const nulls = {
    'member access': 'export const meta = {name:"wrong"}.name',
    'logical and': 'export const meta = {name:"wrong"} && getMeta()',
    'logical or': 'export const meta = {name:"wrong"} || getMeta()',
    'nullish': 'export const meta = {name:"wrong"} ?? getMeta()',
    'ternary': 'export const meta = {name:"wrong"} ? a : b',
    'call': 'export const meta = {name:"wrong"}(1)',
    'index': 'export const meta = {name:"wrong"}[0]',
    'tagged template': 'export const meta = {name:"wrong"}`x`',
    'comparison': 'export const meta = {name:"wrong"} == 1',
    'in operator': 'export const meta = {name:"wrong"} in x',
    'instanceof': 'export const meta = {name:"wrong"} instanceof X',
    'two statements on a line': 'export const meta = {name:"wrong"} const y = 1',
    'a name on the same line': 'export const meta = {name:"wrong"} foo()',
    'a closing paren': 'export const meta = {name:"wrong"})',
    'dot on the next line': 'export const meta = {name:"wrong"}\n  .name',
    'call on the next line': 'export const meta = {name:"wrong"}\n(function () {})()',
    'index on the next line': 'export const meta = {name:"wrong"}\n[1].map(f)',
    'plus on the next line': "export const meta = {name:'wrong'}\n+ 'x'",
    'template on the next line': 'export const meta = {name:"wrong"}\n`x`',
    'operator after a comment': 'export const meta = {name:"wrong"} // c\n  && getMeta()',
    'operator after a block comment with a line break': 'export const meta = {name:"wrong"} /* a\n*/ && getMeta()',
    'in on the next line': 'export const meta = {name:"wrong"}\nin x',
    'not-equal on the next line': 'export const meta = {name:"wrong"}\n!= 1',
  };
  for (const [what, text] of Object.entries(nulls)) assert.equal(parseScriptMeta(text), null, what);

  const ok = {
    'end of text': 'export const meta = {name:"x"}',
    'semicolon': 'export const meta = {name:"x"};phase("a")',
    'next statement': 'export const meta = {name:"x"}\nphase("a")',
    'next declaration': 'export const meta = {name:"x"}\nconst y = 1',
    'next export': 'export const meta = {name:"x"}\nexport const other = 1',
    'comments in between': 'export const meta = {name:"x"} // c\n/* b */ phase("a")',
    'CRLF': 'export const meta = {name:"x"}\r\nphase("a")\r\n',
    'a name starting with in': 'export const meta = {name:"x"}\nindex = 1',
    'a prefix operator statement': 'export const meta = {name:"x"}\n!done',
    'next declarator': 'export const meta = {name:"x"}, other = 1',
    'a string statement': 'export const meta = {name:"x"}\n"use strict"',
    'a block': 'export const meta = {name:"x"}\n{ phase("a") }',
  };
  for (const [what, text] of Object.entries(ok)) assert.deepEqual(parseScriptMeta(text), { name: 'x' }, what);
});
