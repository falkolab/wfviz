// Integration, agent tokens (P2): bin/wfviz.mjs as a child process with the REAL source, model and server on the saved fixture runs.
// The served Run has Agent.usage, totals.usage and totals.byModel (the hand anchors of the guide), and --offline makes GET /api/prices a 503
// "offline" without any fetch. No test here asks for the prices without --offline: nothing in this suite touches the network.

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { FIXTURES, assertRunShape, eventually, getJson, startWfviz } from './helpers.mjs';

const ROOT = path.join(FIXTURES, 'claude-projects');
const RUN_A = 'wf_26eb8d70-5c4'; // repeated transcript records (4 records of 2 messages in one agent)
const RUN_B = 'wf_6509ce25-20a';
const AGENT = 'a66894b94f6da9868';

describe('bin/wfviz.mjs --offline on the fixture runs', { timeout: 120_000 }, () => {
  let bin;
  let port;

  before(async () => {
    bin = startWfviz(['--no-open', '--root', ROOT, '--idle', '0', '--port', '0', '--since', 'Infinity', '--offline']);
    ({ port } = await bin.ready);
  });

  after(() => bin?.kill('SIGKILL'));

  it('GET /api/prices is a 503 { error: "offline" }, as often as it is asked; another path under it is a 404', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await getJson(port, '/api/prices');
      assert.equal(res.status, 503);
      assert.deepEqual(res.json, { error: 'offline' });
    }
    assert.equal((await getJson(port, '/api/prices/x')).status, 404);
  });

  it('a Run carries usage per agent, in the run and by model: inferred, with the numbers worked out by hand from the transcripts', async () => {
    const { a, b } = await eventually(async () => {
      const a = (await getJson(port, `/api/runs/${RUN_A}`)).json;
      const b = (await getJson(port, `/api/runs/${RUN_B}`)).json;
      assert.equal(a.agents[AGENT]?.usage?.prov, 'inferred');
      assert.ok(Object.keys(b.agents).length === 5);
      return { a, b };
    });
    assertRunShape(a, RUN_A);
    assertRunShape(b, RUN_B);
    assert.deepEqual(a.agents[AGENT].usage.value, { input: 4, output: 310, cacheRead: 56181, cacheWrite: 58639 });
    assert.match(a.agents[AGENT].usage.method, /^sum-over-unique-message-id \(2 messages in 3 records the source delivers; /, 'the method says the sum covers the records the source delivers');
    assert.deepEqual(a.agents[AGENT].byModel.value, { 'claude-haiku-5-5': { input: 4, output: 310, cacheRead: 56181, cacheWrite: 58639 } });
    assert.match(a.totals.usage.method, /^sum-of-agent-usage \(6 of 6 agents; records the source delivers only: /);
    assert.deepEqual(a.totals.usage.value, { input: 14, output: 840, cacheRead: 250741, cacheWrite: 144816 });
    assert.deepEqual(a.totals.byModel.value, { 'claude-haiku-5-5': { input: 14, output: 840, cacheRead: 250741, cacheWrite: 144816 } });
    assert.deepEqual(b.totals.usage.value, { input: 10, output: 656, cacheRead: 117046, cacheWrite: 163685 });
    // Agent.tokens and totals.tokens are as they were: the final file's own numbers, a different quantity
    assert.equal(a.totals.tokens.prov, 'final');
    assert.notEqual(a.totals.tokens.value, 14 + 840 + 250741 + 144816);
    // no cost anywhere in the Run: it is computed in the page
    assert.doesNotMatch(JSON.stringify(a), /"(cost|usd|price)/i);
  });

  it('the list does not need the whole Run: GET /api/runs answers every run with its summary fields only', async () => {
    const list = (await getJson(port, '/api/runs')).json;
    assert.deepEqual(list.map((r) => r.id).sort(), [RUN_A, RUN_B].sort());
    for (const item of list) {
      assert.deepEqual(Object.keys(item).sort(), ['agents', 'id', 'loaded', 'name', 'project', 'running', 'source', 'startedAt', 'status']);
      assert.equal(item.loaded, true);
    }
  });
});
