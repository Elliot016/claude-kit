import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PROPS = { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120 } as never

// Stands in for the engine at session start; `env` is the environment the mod reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const start = async ($: any, on: On, env: Record<string, string> = {}, calls: string[] = []) => {
  on('session.start', async () => ({ cwd: '/tmp/project' }) as never)
  on('env.get', async (_$, e) => ({ value: env[e.name] }) as never)
  on('settings.read', async () => ({ value: {} }) as never)
  on('clock.now', async () => ({ value: 100_000 }) as never)
  on('clock.every', async () => ({ value: undefined }) as never)
  on('ui.open', async () => {
    calls.push('open')
    return { value: undefined } as never
  })
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  await $.session.start({ source: 'startup', cwd: '/tmp/project' } as never)
}

const report = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__savvy-progress__progress', ...input } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the train carries its label inside the track (${surface})`, async ($, on) => {
    await start($, on)
    await report($, { title: 'Recipe import', total: 5, done: 2, phase: 'delegate' })
    const band = await $.ui.mount({ plugin: 'savvy-progress', surface, component: 'AbovePrompt', props: PROPS })
    if (surface === 'terminal') {
      expect(await band.find({ type: 'Text', text: 'Tasks 2/5 · 40%' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '▶' })).toBeDefined()
      expect(await band.find({ type: 'Image' })).toBeUndefined()
    } else {
      const row = await band.find({ type: 'Svg' })
      const source = String((row as unknown as { props: { source: string } }).props.source)
      expect(source.includes('Tasks 2/5 · 40%')).toBe(true)
      expect(source.includes('c-lead')).toBe(true)
    }
  })
}

test('in Ghostty the engine is a picture and the label stays text', async ($, on) => {
  await start($, on, { TERM_PROGRAM: 'ghostty' })
  await report($, { title: 'Recipe import', total: 5, done: 2, phase: 'delegate' })
  const band = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const engine = await band.find({ type: 'Image' })
  expect(engine).toBeDefined()
  const props = (engine as unknown as { props: { columns: number; rows: number; source: { width: number; height: number } } }).props
  expect([props.columns, props.rows]).toEqual([6, 2])
  expect([props.source.width, props.source.height]).toEqual([216, 180])
  expect(await band.find({ type: 'Text', text: 'Tasks 2/5 · 40%' })).toBeDefined()
})

test('inside tmux it keeps the text train', async ($, on) => {
  await start($, on, { TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-501/default,1,0' })
  await report($, { title: 'Recipe import', total: 5, done: 2 })
  const band = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ type: 'Image' })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: '▶' })).toBeDefined()
})

test('a finished flow shows its label at the right, not on the train, and the terminal band has no buttons', async ($, on) => {
  await start($, on)
  await report($, { title: 'Recipe import', total: 5, done: 5, finished: true })
  const band = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const labels = await band.findAll({ type: 'Text', text: 'Done · 100%' })
  expect(labels.length).toBe(1)
  expect(await band.findAll({ type: 'Button' })).toEqual([])
})

test('in Ghostty each worker row in the panel leads with its conductor crab', async ($, on) => {
  on('agent.spawn', async () => ({ agentId: 'a1', model: 'claude-sonnet-5-5' }) as never)
  await start($, on, { TERM_PROGRAM: 'ghostty' })
  await $.agent.spawn({ subagentType: 'savvy-careful', description: 'Refactor the plan import', tool_use_id: 't1', prompt: 'brief' } as never)
  const pane = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: { title: 'Agents' } as never })
  const crab = await pane.find({ type: 'Image' })
  expect(crab).toBeDefined()
  const props = (crab as unknown as { props: { columns: number; rows: number } }).props
  expect([props.columns, props.rows]).toEqual([4, 2])
  expect(await pane.find({ type: 'Text', text: 'Refactor the plan import' })).toBeDefined()
  for (const label of ['Cost', 'Tokens', 'Time']) expect(await pane.find({ type: 'Text', text: label })).toBeDefined()
})

test('/agents-info opens a pane that waits undrawn instead of closing it', async ($, on) => {
  const calls: string[] = []
  on('ui.panes', async () => ({ value: [{ id: 'savvy-agents', title: 'Agents', isShown: false, isFocused: false, isPlaced: false }] }) as never)
  on('ui.close', async () => {
    calls.push('close')
    return {} as never
  })
  await start($, on, {}, calls)
  const result = await $.command.run({ command: 'agents-info', args: '' } as never)
  expect(calls).toEqual(['open'])
  expect(JSON.stringify(result)).toContain('opened')
})
