export const meta = {
  name: 'probe-event-format',
  description: 'Tiny probe: 2 parallel agents, then a dependent judge, then a 2-round loop; checks what files appear during a run',
  phases: [{ title: 'Fanout', detail: 'two independent reviewers' }, { title: 'Judge' }, { title: 'Loop' }],
}
const V = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, note: { type: 'string' } }, required: ['verdict', 'note'] }
phase('Fanout')
log('probe: starting fanout')
const [a, b] = await parallel([
  () => agent('Reply with verdict "pass" and note "A saw x=1". Do not use any tools.', { label: 'reviewer:A', phase: 'Fanout', schema: V, model: 'haiku', effort: 'low' }),
  () => agent('Reply with verdict "fail" and note "B saw x=2". Do not use any tools.', { label: 'reviewer:B', phase: 'Fanout', schema: V, model: 'haiku', effort: 'low' }),
])
phase('Judge')
const j = await agent(`Two reviews: ${JSON.stringify([a, b])}. They disagree. Reply verdict "fail" with a one-line note. No tools.`, { label: 'judge', phase: 'Judge', schema: V, model: 'haiku', effort: 'low' })
phase('Loop')
let r = null
for (let round = 1; round <= 2; round++) {
  log(`probe: loop round ${round}`)
  r = await agent(`Round ${round}. Reply with plain text "round ${round} done". No tools.`, { label: `fixer:round${round}`, phase: 'Loop', model: 'haiku', effort: 'low' })
}
return { a, b, j, r }