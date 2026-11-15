export const meta = {
  name: 'probe-edge-cases',
  description: 'Probe 2: pipeline overlap, slow agent with tool calls, a stage that throws, a thunk that throws, then a script error',
  phases: [{ title: 'Pipe' }, { title: 'Errors' }],
}
phase('Pipe')
log('probe2: pipeline of 3 items x 2 stages')
const items = ['alpha', 'beta', 'gamma']
const piped = await pipeline(items,
  (x, it, i) => agent(i === 0
    ? `Run these Bash commands one by one: "sleep 3; echo ${it}-1", then "sleep 3; echo ${it}-2". Then reply with the text "${it} slow done".`
    : `Reply with plain text "${it} fast done". No tools.`, { label: `stage1:${it}`, phase: 'Pipe', model: 'haiku', effort: 'low' }),
  (prev, it) => {
    if (it === 'beta') throw new Error('probe: stage2 throws for beta')
    return agent(`Previous stage said: ${prev}. Reply with plain text "${it} stage2 done". No tools.`, { label: `stage2:${it}`, phase: 'Pipe', model: 'haiku', effort: 'low' })
  })
phase('Errors')
const par = await parallel([
  () => agent('Reply with plain text "ok". No tools.', { label: 'errors:ok', phase: 'Errors', model: 'haiku', effort: 'low' }),
  () => { throw new Error('probe: thunk throws') },
])
log(`probe2: piped=${JSON.stringify(piped)} par=${JSON.stringify(par)}`)
throw new Error('probe2: deliberate script failure at the end')