# Node guide: agents plural (unit agents-plural, L2)

Read with docs/guides/common.md; [weak-test], [stale-test], [stale-doc], [guide-defect] apply. ASCII only, in this guide and in every line you add (web/lib.js has other non-ASCII lines: leave them alone). Start wfviz only with --no-open and stop it only by `kill <pid>`; no browser pane. No test touches the network.

## Rules that bind
- Spec: web only; in the run cost text "for k of n agents" the word follows n ("of 1 agent", "of 2 agents"), in the text and in the method, by agentsNote's rule; no second plural helper; tests for n = 1 and n = 2 in test/server/web-tokens.test.mjs; the existing "0 of 2" test stays; nothing else changes.
- AGENTS.md, Hard rules: "Never invent data" and "Do not add handling for formats not observed". The counts k and n come from Run.agents (agentCount in web/lib.js); do not read them from any text, and invent no case for n = 0 (agentCount returns null then, and never says "0 of 0").
- AGENTS.md, Hard rules: "wfviz is universal ... no role, phase, label, node code, file name or result shape of our method may be required or hard-coded". The new words are only "agent" and "agents"; the text names no role, label, engine or cause. test/integration/universal.test.mjs scans web/ code lines.
- docs/contract.md section 2 (Agent.usage, "Cost is never in the Run: it is computed in the UI") and section 4 (GET /api/prices): the contract says nothing about this wording, so it does not change and this node does not edit docs/.
- AGENTS.md, Development method: "Never weaken a gate to pass". A test is never loosened to accept both wordings.

## Files you own
- Own: web/ and test/server/. In fact only web/lib.js (lines 280-283: agentsText, agentsNote) and test/server/web-tokens.test.mjs change. web/app.js is not touched: it draws the text through costHtml and fact() and has no wording of its own, so its pinned counts (setInterval 1, setTimeout 5, `new EventSource(` 1, localStorage 3, one `.innerHTML =` line; web-lib.test.mjs around lines 1053-1060) stay as they are. Add no timer, no listener, no storage; lib.js is pure.
- Not yours: src/, docs/, test/model/, test/integration/, test/index.js. No new test file, so test/index.js needs no edit.

## Where the old wording is asserted (grep of test/ done 2026-11-15)
- test/server/web-tokens.test.mjs line 396 asserts `.text.includes('for 0 of 1 agents')`: it goes red on the new wording and is yours to edit (you own it). Rewrite it, same intent, and say so in the note.
- Same file, line 350: `NOT_SUM = /for \d+ of \d+ agents|no usage in the run files/`. Widen the first part to `agents?`, or the "no sentence in the text" guards (lines 380-386 and 412-426) stop catching the singular text. Same intent; say so in the note.
- Lines 358, 369, 373, 376, 405, 433, 446 assert "of 2 agents", "of 3 agents", "of 12 agents" and the method sentences: they hold unchanged (n >= 2) and are the proof that nothing else changed. Do not edit them.
- Not about this text, do not edit: "sum-of-agent-usage (1 of 1 agents)" in web-tokens lines 31, 271, 398, 403 and in web-u4.test.mjs 2604, 2631, 2993, and `sum-of-agent-tokens (1 of 2 agents)` in test/model/ and test/integration/. That wording comes from src/model/reduce.mjs line 863 (the usage Fact's own method) and is out of scope, though it also says "1 of 1 agents". Do not change it; one low note in the report is enough. web-u4.test.mjs 3004 and 3018 ("1 of 3", "2 of 3") are unaffected.

## Traps
1. The noun follows n (`all`), not k and not left-out. "for 1 of 2 agents" stays plural although k is 1. agentsNote's test is `all - known === 1` (the left-out count) and decides "the other agent ... it" against "the other N agents ... they"; agentsText must use the same test, `=== 1`, on `all`. Never `Intl.PluralRules`, never `all < 2`, never a locale.
2. Reuse the rule, add no second helper: write the same ternary inline in agentsText, or one tiny noun expression that agentsNote also uses. `grep -n "plural\|Plural\|Word" web/lib.js` must show no new function or constant that only agentsText uses. agentsNote's output stays byte for byte.
3. The method needs no change of wording. It holds no "k of n"; its only count is agentsNote's. For n = 1 (k must be 0) it already says "the other agent has no usage in the run files, so it is not priced" ("the other" is odd with one agent in all, but the spec says nothing else changes: do not reword it). For n = 2: k = 0 gives "the other 2 agents ... they", k = 1 gives "the other agent ... it". The tests pin this, so the spec's "and its method" is met by a test, not by an edit.
4. n = 1 with k = 1 is "every agent has a usage": agentCount returns null, so no "of n" text at all. Do not add "1 of 1 agent". With n = 0 or no agents object the same holds. Only 0 of 1 exists.
5. Weak test: `includes('for 0 of 1 agent')` is also true on the old text ("agents" starts with "agent"). Assert the whole text (`~ $0.0210 for 0 of 1 agent (OpenRouter prices, fetched ${CLOCK})`) or the string with the closing " (" or ", ". Check each new test is red on the old line (see "How to check", item 5).
6. Leftover tokens: the text is "for k of n agent, without N tokens ..." in the same place (lib.js line 366); keep that order and add one case with n = 1 and tokens left out.
7. Escaping: both strings are built from `String(number)` and fixed words; no run data (agent id, label, reason) may enter them. Keep it so; the existing `__proto__`/markup test (line 428) must stay green.
8. The cost of one agent (agentCostView) never says "of n"; leave it.

## How to check by hand (from the repo root)
1. Print the four texts and the method tail:
   `node --input-type=module -e "import {runCostView} from './web/lib.js'; const P={source:'openrouter',url:'u',fetchedAt:1,models:{'anthropic/claude-haiku-5.5':{input:1e-7,output:5e-7,cacheRead:1e-8,cacheWrite:1.25e-7}}}; const U={value:{input:14,output:840,cacheRead:250741,cacheWrite:144816},prov:'inferred',method:'m'}; const k={value:null,prov:'unknown',reason:'r'}; const mk=(...us)=>({totals:{usage:U,byModel:{value:{'claude-haiku-5-5':U.value},prov:'inferred',method:'m'}},agents:Object.fromEntries(us.map((u,i)=>['a'+i,{usage:u}]))}); for (const us of [[k],[k,k],[U,k],[U,k,k],[U],[]]) { const v=runCostView(mk(...us),{phase:'ok',data:P}); console.log(v.text,'|',v.fact.method.split('; ').pop()); }"`
   Expected: "for 0 of 1 agent" with the sentence "the other agent ... it"; "for 0 of 2 agents" with "the other 2 agents ... they"; "for 1 of 2 agents" with "the other agent ... it"; "for 1 of 3 agents" with "the other 2 agents ... they"; the last two (all known, no agents) with no "of n" and no sentence.
2. `git diff -U0 -- web/ | grep '^[-+]'`: only agentsText (and, if you chose the shared expression, agentsNote's noun) changed; nothing in web/app.js, web/index.html, web/style.css.
3. `node --test test/server/` while you work; `grep -n "of 1 agent\b\|of 2 agents" test/server/web-tokens.test.mjs` shows the new n = 1 and n = 2 tests.
4. `LC_ALL=C grep -n '[^ -~]' test/server/web-tokens.test.mjs` prints nothing, and the lines you added to web/lib.js are ASCII.
5. Mutation, two runs, each with Edit and a restore. (a) Put the old line back (`agents` after `${String(all)}`) and run `node --test test/server/web-tokens.test.mjs`: the new n = 1 test and the edited line-396 assertion fail; the n = 2 tests and the "0 of 2" test pass, because "of 2 agents" was already right (they guard against over-fixing). (b) Make the rule wrong the other way (`all <= 2` or `known === 1` as the singular test): the n = 2 tests ("for 1 of 2 agents", "for 0 of 2 agents") must fail. A new test that stays green under its mutation is vacuous: rewrite it. Restore the real line and re-run.
6. Last, `npm test` once: exit 0, fail 0, skipped 0, todo 0, pass count above the baseline by exactly the number of new tests (the new cases are added inside existing or new `test(` blocks of web-tokens.test.mjs; say how many).

## Closing line
With the new tests added and web/lib.js unchanged, exactly these fail: the new n = 1 test(s) and the edited line-396 assertion (both say "of 1 agent"); the n = 2 tests and every other test pass. After the change `node --test test/server/` and `npm test` pass with 0 skipped, 0 todo.
