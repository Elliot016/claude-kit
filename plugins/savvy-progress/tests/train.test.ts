import { expect, test } from 'claude-code/testing'

const PROPS = { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120 } as never

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the train carries its label inside the track (${surface})`, async ($, on) => {
    on('session.start', async () => ({ cwd: '/tmp/project' }) as never)
    on('env.get', async () => ({ value: undefined }) as never)
    on('settings.read', async () => ({ value: {} }) as never)
    await $.session.start({ source: 'startup', cwd: '/tmp/project' } as never)
    await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Recipe import', total: 5, done: 2, phase: 'delegate' } as never)
    const band = await $.ui.mount({ plugin: 'savvy-progress', surface, component: 'AbovePrompt', props: PROPS })
    if (surface === 'terminal') {
      const label = await band.find({ type: 'Text', text: 'Tasks 2/5 · 40%' })
      expect(label).toBeDefined()
      const engine = await band.find({ type: 'Text', text: '▶' })
      expect(engine).toBeDefined()
    } else {
      const row = await band.find({ type: 'Svg' })
      expect(row).toBeDefined()
      const source = String((row as unknown as { props: { source: string } }).props.source)
      expect(source.includes('Tasks 2/5 · 40%')).toBe(true)
      expect(source.includes('c-lead')).toBe(true)
    }
  })
}

test('a finished flow puts the label on the cars', async ($, on) => {
  on('session.start', async () => ({ cwd: '/tmp/project' }) as never)
    on('env.get', async () => ({ value: undefined }) as never)
    on('settings.read', async () => ({ value: {} }) as never)
  await $.session.start({ source: 'startup', cwd: '/tmp/project' } as never)
  await $.tool.call({ tool: 'mcp__savvy-progress__progress', title: 'Recipe import', total: 5, done: 5, finished: true } as never)
  const band = await $.ui.mount({ plugin: 'savvy-progress', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await band.find({ type: 'Text', text: 'Done · 100%' })).toBeDefined()
})
