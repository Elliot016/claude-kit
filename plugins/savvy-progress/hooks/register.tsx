import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Panel, Phase, PlannedTask } from '../types'

const flow = atom({ plugin: 'savvy-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'savvy-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)

const TOOL = 'mcp__savvy-progress__progress'
const STEP_TOOL = 'mcp__savvy-progress__step'
const PANE = 'savvy-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Russian.

type Lang = 'en' | 'ru'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'Agents panel opened.',
    closed: 'Agents panel closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isRussian(settings.language) ? 'ru' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isRussian(locale) ? 'ru' : 'en'
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && input.title.trim() !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: (t.tier ?? '').replace(/^savvy-/, '').trim().toLowerCase(),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// The row is one SVG: the desktop wraps sibling elements onto new lines, so the
// title, the track, the train, its conductor and the label live in one drawing;
// only the count and the dismiss are Buttons beside it.
const H = 26
const BAR_H = 16
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// What the bar says: the flow's label and its percent, inside the track.
const trackLabel = (f: Flow): string => `${label(f)} · ${Math.round(ratio(f) * 100)}%`

// The locomotive, drawn in track coordinates with its cab at x and its nose at
// x + LOCO_W. The cab rises above the track and seats the conductor; the stack
// puffs and the wheels turn while workers run.
const LOCO_W = 32
const LABEL_SIZE = 10.5

const locomotive = (x: number, color: string, isWorking: boolean): string => {
  const wheel = (cx: number, r: number) =>
    `<g transform="translate(${x + cx},13)"><circle class="w" r="${r}"/><g class="${isWorking ? 'sp' : ''}"><rect class="hub" x="-0.5" y="${-r + 0.6}" width="1" height="${2 * r - 1.2}"/></g><circle class="hub" r="0.7"/></g>`
  const puffs = isWorking
    ? [0, 1, 2].map(i => `<circle class="pf p${i}" cx="${x + 25.5}" cy="-7" r="${1.6 + i * 0.4}"/>`).join('')
    : ''
  return `${puffs}
<rect class="w" x="${x - 1}" y="-8" width="17" height="2"/>
${crab(x - 1, -10, 'lead', false, isWorking, 0.5)}
<rect class="w" x="${x}" y="-6" width="2" height="9"/><rect class="w" x="${x + 13}" y="-6" width="2" height="9"/>
<rect x="${x}" y="2" width="15" height="9" fill="${color}"/><rect x="${x + 3}" y="4" width="4" height="3" class="win"/>
<rect x="${x + 15}" y="1" width="14" height="10" rx="2" fill="${color}"/>
<rect x="${x + 19}" y="1" width="1" height="10" class="shade"/><rect x="${x + 24}" y="1" width="1" height="10" class="shade"/>
<rect x="${x + 18}" y="-1" width="4" height="2" rx="1" fill="${color}"/>
<rect class="w" x="${x + 24}" y="-5" width="3" height="6"/><rect class="w" x="${x + 23}" y="-6" width="5" height="1.5"/>
<rect x="${x + 29}" y="3" width="1.5" height="3" fill="#F5C542"/>
<path class="w" d="M${x + 29} 8h2.5l1 4h-3.5z"/>
<rect class="w" x="${x}" y="11" width="${LOCO_W - 1}" height="1.2"/>
${wheel(5, 2.6)}${wheel(11, 2.6)}${wheel(20, 2)}${wheel(26, 2)}`
}

// One car per accepted task, coupled behind the cab from the track's start.
const cars = (n: number, end: number, color: string, isWindowed: boolean): string => {
  if (n <= 0 || end < 10) return ''
  const pitch = (end - 1) / n
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const x = 1 + i * pitch
    const w = Math.max(4, pitch - 2)
    out.push(`<rect x="${x}" y="2" width="${w}" height="9" rx="1.5" fill="${color}"/><rect x="${x}" y="2" width="${w}" height="1.4" class="shade"/>`)
    if (isWindowed) for (let wx = x + 3; wx + 3 <= x + w - 2; wx += 5) out.push(`<rect x="${wx}" y="4.5" width="3" height="3" class="win"/>`)
    if (w >= 9) out.push(`<circle class="w" cx="${x + 3}" cy="13" r="1.7"/><circle class="w" cx="${x + w - 3}" cy="13" r="1.7"/>`)
    out.push(`<rect class="w" x="${x + w}" y="8" width="${pitch - w + 0.5}" height="1"/>`)
  }
  return out.join('')
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 35% of the row; the track takes the rest.
  const title = fitText(f.title, 13, Math.max(60, W * 0.35))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(LOCO_W + 40, W - BAR_X - 4)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = H - BAR_H - 1
  const run = BAR_W - LOCO_W - 3
  const cabX = 2 + Math.round(run * ratio(f))
  const noseX = cabX + LOCO_W

  // The label rides the open track ahead of the train while it fits there, then
  // moves onto the cars in white; at worst it is cut to the larger of the two.
  const text = trackLabel(f)
  const tw = textWidth(text, LABEL_SIZE)
  const aheadW = BAR_W - noseX - 12
  const carsW = cabX - 10
  const onCars = aheadW < tw && (carsW >= tw || carsW > aheadW)
  const shown = fitText(text, LABEL_SIZE, Math.max(10, onCars ? carsW : aheadW))
  const n = f.total ? f.done : f.isFinished ? Math.max(1, Math.round(cabX / 44)) : 0
  const sleepers: string[] = []
  for (let x = 4; x < BAR_W - 2; x += 6) sleepers.push(`<rect x="${x}" y="14.6" width="2" height="1.4"/>`)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#6b6b68}.k{fill:#ecebe8}.tk{fill:#c9c8c3}.w{fill:#3d3d40}.hub{fill:#b9b8b3}.win{fill:#ffffff;opacity:.55}.shade{fill:#000;opacity:.14}.pf{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#a8a8a4}.k{fill:#2a2a29}.tk{fill:#4a4a48}.w{fill:#a5a5aa}.hub{fill:#2a2a29}.pf{fill:#6a6a68}}
.sp{animation:spin .6s linear infinite;transform-box:fill-box;transform-origin:center}@keyframes spin{to{transform:rotate(360deg)}}
.pf{animation:puff 1.5s ease-out infinite;transform-box:fill-box;transform-origin:center;opacity:0}.p1{animation-delay:-.5s}.p2{animation-delay:-1s}
@keyframes puff{0%{opacity:.8;transform:translate(0,0) scale(.6)}100%{opacity:0;transform:translate(-9px,-4px) scale(1.6)}}
@media (prefers-reduced-motion: reduce){.sp,.pf{animation:none}.pf{opacity:.5}}
</style>${CRAB_CSS}
<circle cx="5" cy="${y0 + BAR_H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${y0 + BAR_H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="4"/>
<g class="tk">${sleepers.join('')}<rect x="2" y="14" width="${BAR_W - 4}" height="0.8"/></g>
${cars(n, cabX - 3, color, !onCars)}
${locomotive(cabX, color, isWorking && !f.isFinished)}
<text x="${onCars ? 6 : BAR_W - 8}" y="10" text-anchor="${onCars ? 'start' : 'end'}" font-family="${FONT}" font-size="${LABEL_SIZE}" font-weight="600" font-variant-numeric="tabular-nums" ${onCars ? 'fill="#ffffff"' : 'class="t"'}>${xml(shown)}</text>
</g>
</svg>`
}

// The terminal's train: cars as blocks behind the engine (a picture where the
// terminal shows images, else ▶), open track ahead, and the label inside, on the
// track while it fits there, then on the cars.
type Run = { text: string; kind: 'car' | 'carLabel' | 'track' | 'trackLabel' }

const trainRuns = (f: Flow, width: number, engineW: number): { behind: Run[]; ahead: Run[] } => {
  const room = Math.max(0, width - engineW)
  const behindN = Math.round(room * ratio(f))
  const aheadN = room - behindN
  const text = ` ${trackLabel(f)} `
  const onCars = aheadN < text.length && (behindN >= text.length || behindN > aheadN)
  const shown = clip(text, Math.max(0, onCars ? behindN : aheadN))
  const behind: Run['kind'][] = Array.from({ length: behindN }, (_, i) => (onCars && i < shown.length ? 'carLabel' : 'car'))
  const behindCh = Array.from({ length: behindN }, (_, i) => (onCars && i < shown.length ? (shown[i] ?? ' ') : (behindN - 1 - i) % 6 === 5 ? ' ' : '▆'))
  const lead = aheadN - shown.length
  const ahead: Run['kind'][] = Array.from({ length: aheadN }, (_, i) => (!onCars && i >= lead ? 'trackLabel' : 'track'))
  const aheadCh = Array.from({ length: aheadN }, (_, i) => (!onCars && i >= lead ? (shown[i - lead] ?? ' ') : '┄'))
  const join = (kinds: Run['kind'][], chars: string[]): Run[] => {
    const out: Run[] = []
    kinds.forEach((kind, i) => {
      const last = out[out.length - 1]
      if (last && last.kind === kind) last.text += chars[i] ?? ''
      else out.push({ text: chars[i] ?? '', kind })
    })
    return out
  }
  return { behind: join(behind, behindCh), ahead: join(ahead, aheadCh) }
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, string> = {
  fable: 'Fable · high',
  heavy: 'Opus · high',
  careful: 'Sonnet · high',
  medium: 'Sonnet · medium',
  light: 'Haiku',
}

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return t in TIER_COLOR && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks
// and swings its lantern.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.run .lamp{transform-origin:50% 0;animation:swing 1s ease-in-out infinite}
@keyframes swing{0%,100%{transform:rotate(9deg)}50%{transform:rotate(-9deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

// Every crab is a train conductor: a navy cap with a band in its tier's color and a
// gold badge, and a lantern with tier-colored glass in the raised front claw.
const conductor = (f: Fill, t: string): void => {
  crabBody(f, -4, 'lamp')
  stamp(f, 6, 5, ['....nnnnnnnnnn....', '..nnnnnnnggnnnnn..', '..nnnnnnnggnnnnn..', '..bbbbbbbbbbbbbb..', '..kkkkkkkkkkkkkkkkkk'], { n: '#2B3A55', g: '#F5C542', b: t, k: '#1A2233' })
  f(25, 14, 1, 1, '#55514C', 'lamp')
  f(24, 15, 3, 1, '#55514C', 'lamp')
  f(24, 16, 3, 3, t, 'lamp')
  f(25, 17, 1, 1, '#FFF6D5', 'lamp')
  f(24, 19, 3, 1, '#55514C', 'lamp')
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  conductor(f, costume === 'lead' ? ACCENT : colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

// ---------------------------------------------------------------------------
// Terminal pictures: the engine and the crabs as real pixels, for terminals that
// show images (kitty, Ghostty, iTerm2, WezTerm, foot; never through tmux). The
// drawings are painted into RGBA here, no DOM, and handed to the terminal's Image.

type Canvas = { w: number; h: number; data: Uint8Array }

const canvasOf = (w: number, h: number): Canvas => ({ w, h, data: new Uint8Array(w * h * 4) })

const rgbaOf = (c: string): [number, number, number, number] => {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(c)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Number(m[4]) * 255)]
  const h = c.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255]
}

// Paints one pixel over what is there (source-over), dimmed by `fade`.
const plot = (p: Canvas, x: number, y: number, [r, g, b, a]: [number, number, number, number], fade = 1): void => {
  if (x < 0 || y < 0 || x >= p.w || y >= p.h) return
  const i = (y * p.w + x) * 4
  const sa = (a / 255) * fade
  const da = (p.data[i + 3] ?? 0) / 255
  const oa = sa + da * (1 - sa)
  if (oa <= 0) return
  const mix = (s: number, d: number) => Math.round((s * sa + d * da * (1 - sa)) / oa)
  p.data[i] = mix(r, p.data[i] ?? 0)
  p.data[i + 1] = mix(g, p.data[i + 1] ?? 0)
  p.data[i + 2] = mix(b, p.data[i + 2] ?? 0)
  p.data[i + 3] = Math.round(oa * 255)
}

const box = (p: Canvas, x: number, y: number, w: number, h: number, c: string, fade = 1): void => {
  const col = rgbaOf(c)
  for (let yy = Math.round(y); yy < Math.round(y + h); yy++) for (let xx = Math.round(x); xx < Math.round(x + w); xx++) plot(p, xx, yy, col, fade)
}

const disc = (p: Canvas, cx: number, cy: number, r: number, c: string, fade = 1): void => {
  const col = rgbaOf(c)
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) plot(p, x, y, col, fade)
}

// A conductor crab at (ox, oy) in crab pixels. The frame moves what the CSS moves
// on the desktop: the leg pairs step in turn and the lantern swings.
const paintCrab = (p: Canvas, ox: number, oy: number, color: string, frame: number, isWorking: boolean, fade = 1): void => {
  conductor((x, y, w, h, c, cls = 'bd') => {
    const step = isWorking && ((cls === 'la' && frame === 0) || (cls === 'lb' && frame === 1)) ? -1 : 0
    const swing = isWorking && cls === 'lamp' && y >= 14 ? (frame === 0 ? 1 : -1) : 0
    box(p, ox + x + swing, oy + y + step, w, h, c, fade)
  }, color)
}

// The engine on a 72 x 60 grid, two pixels per unit of the desktop drawing. The
// terminal keeps a picture's proportions inside its box, and terminal cells run
// about 2.1 to 2.5 times taller than wide, so 6 columns by 2 rows lets the engine
// fill both rows instead of fitting by width.
const ENGINE_COLS = 6
const ENGINE_W = 72
const ENGINE_H = 60
const GREY = '#9a9aa0'
const HUB = '#2a2a29'

const paintEngine = (color: string, frame: number, isWorking: boolean): Canvas => {
  const p = canvasOf(ENGINE_W, ENGINE_H)
  const U = (v: number) => v * 2
  const X = (x: number) => U(x + 2)
  const Y = (y: number) => U(y + 11) + 4
  const r = (x: number, y: number, w: number, h: number, c: string, fade = 1) => box(p, X(x), Y(y), U(w), U(h), c, fade)
  if (isWorking) {
    const puffs = frame === 0 ? [[25.5, -7, 1.6], [22, -9, 2.2]] : [[24.5, -8, 2], [20, -9.5, 2.5]]
    for (const [x = 0, y = 0, rad = 0] of puffs) disc(p, X(x), Y(y), U(rad), '#8a8a88', 0.75)
  }
  r(-1, -8, 17, 2, GREY)
  paintCrab(p, X(-1), Y(-10), ACCENT, frame, isWorking)
  r(0, -6, 2, 9, GREY)
  r(13, -6, 2, 9, GREY)
  r(0, 2, 15, 9, color)
  r(3, 4, 4, 3, '#ffffff', 0.55)
  r(15, 1, 14, 10, color)
  r(19, 1, 1, 10, '#000000', 0.14)
  r(24, 1, 1, 10, '#000000', 0.14)
  r(18, -1, 4, 2, color)
  r(24, -5, 3, 6, GREY)
  r(23, -6, 5, 1.5, GREY)
  r(29, 3, 1.5, 3, '#F5C542')
  r(29, 8, 2.5, 2, GREY)
  r(29, 10, 3.5, 2, GREY)
  r(0, 11, 31, 1, GREY)
  for (const [cx, rad] of [[5, 2.6], [11, 2.6], [20, 2], [26, 2]] as const) {
    disc(p, X(cx), Y(13), U(rad), GREY)
    if (frame === 0) box(p, X(cx) - 1, Y(13) - U(rad) + 2, 2, U(rad) * 2 - 4, HUB)
    else box(p, X(cx) - U(rad) + 2, Y(13) - 1, U(rad) * 2 - 4, 2, HUB)
    disc(p, X(cx), Y(13), 1.4, HUB)
  }
  return p
}

// A crab on its own, padded to the 4 x 2 cell box the panel gives it.
const paintCrabTile = (color: string, frame: number, isWorking: boolean, fade: number): Canvas => {
  const p = canvasOf(30, 32)
  paintCrab(p, 0, 4, color, frame, isWorking, fade)
  return p
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Standard padded base64, what an Image's `rgba` takes.
const base64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

// Nearest-neighbour upscale, so the terminal's own scaling starts from crisp edges.
const toSource = (p: Canvas, k = 3) => {
  const out = new Uint8Array(p.w * k * p.h * k * 4)
  for (let y = 0; y < p.h * k; y++)
    for (let x = 0; x < p.w * k; x++) {
      const s = ((Math.floor(y / k) * p.w + Math.floor(x / k)) * 4)
      const d = (y * p.w * k + x) * 4
      out[d] = p.data[s] ?? 0
      out[d + 1] = p.data[s + 1] ?? 0
      out[d + 2] = p.data[s + 2] ?? 0
      out[d + 3] = p.data[s + 3] ?? 0
    }
  return { rgba: base64(out), width: p.w * k, height: p.h * k }
}

// Each picture is painted once per look and frame, then reused.
const pictures = new Map<string, ReturnType<typeof toSource>>()
const pictureOf = (key: string, paint: () => Canvas) => {
  const hit = pictures.get(key)
  if (hit) return hit
  const made = toSource(paint())
  pictures.set(key, made)
  return made
}
const engineImage = (color: string, frame: number, isWorking: boolean) =>
  pictureOf(`engine:${color}:${isWorking ? frame : 's'}`, () => paintEngine(color, frame, isWorking))
const crabImage = (color: string, frame: number, isWorking: boolean, isDim = false) =>
  pictureOf(`crab:${color}:${isWorking ? frame : 's'}:${isDim ? 'd' : ''}`, () => paintCrabTile(color, frame, isWorking, isDim ? 0.45 : 1))

// Whether this terminal shows images: set at session start from the environment,
// unless the `pictures` option says off.
let hasPictures = false

async function detectPictures($: EngineInterface, option: unknown): Promise<boolean> {
  if (option === 'off') return false
  if (await $.env.get('TMUX')) return false
  const program = (await $.env.get('TERM_PROGRAM')) ?? ''
  const term = (await $.env.get('TERM')) ?? ''
  return Boolean(await $.env.get('KITTY_WINDOW_ID')) || /ghostty|iterm|wezterm/i.test(program) || /kitty|ghostty|foot/i.test(term)
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const s = tr()
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" x="${i * (tw + gap) + 9}" y="${top + 16}" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + 9}" y="${top + 33}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, s.cost, '≈' + fmtCost(t.cost))}${tile(1, s.tokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const color = colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const stats = `ctx ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without reported steps the bar falls back to the context, drawn grey.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  return svg(
    W,
    66,
    `${crab(0, 14, costumeOf(a.type), false, a.status === 'running')}
<text class="t" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier === 'other' ? a.type : tier)}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" x="42" y="49" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" x="${42 + barW}" y="49" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
<rect class="k" x="42" y="55" width="${barW}" height="4" rx="2"/><rect${progress === null ? ' class="m"' : ''} x="42" y="55" width="${fillW}" height="4" rx="2"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [TIER_MODEL[tier] ?? '']
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${crab(0, 6, tier, true)}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier)}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: 'running', dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: a.status, dim: false })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'other', c: colorOf(p.tier), s: 'planned', dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => crab(i * 36, 0, ic.k, ic.dim, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: tr().pane })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: tr().pane })
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    hasPictures = await detectPictures($, options.pictures)
    await $.tool.register({
      name: 'progress',
      description:
        'Report /savvy-flow progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light'] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For savvy-flow workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: 'ok' }
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (e.subagentType.startsWith('savvy-')) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, planned, t)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
          {toggleCompact}
          {isEmpty && <Text dimColor>{s.empty}</Text>}
          {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
          {running.map(a => (
            <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isRunning}`} width={W} height={66} />
          ))}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            finished.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={66} />
            ))}
          {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
          {planned.map(pl => (
            <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
          ))}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    // Where the terminal shows images, each row leads with its conductor crab.
    const pictures = hasPictures && 'Image' in ui ? ui : null
    const frame = Math.floor(at / 1000) % 2
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const tier = tierOf(a.type)
      const color = colorOf(tier)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      const lines = (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            {!pictures && <Text color={color}>▣</Text>}
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {tier === 'other' ? a.type : tier} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
      return pictures ? (
        <Box key={a.id} flexDirection="row" gap={1} marginBottom={1}>
          <pictures.Image source={crabImage(color, frame, a.status === 'running')} columns={4} rows={2} alt="▣" />
          {lines}
        </Box>
      ) : (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          {lines}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(tierOf(a.type))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {tier} · {TIER_MODEL[tier] ?? ''}
                    {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (f === null || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const crew = list.length + plannedOf(f, list).length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="savvy-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="savvy-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    // The terminal's table answers `Svg` with an empty box, so it draws the text train.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
          {crewButton}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(14, Math.min(100, cols - titleW - 16))
    const color = f.isFinished ? DONE : ACCENT
    const moving = isWorking && !f.isFinished
    const frame = moving ? Math.floor((await read($, now)) / 1000) % 2 : 0
    const engineW = hasPictures && 'Image' in ui ? ENGINE_COLS : 1
    const { behind, ahead } = trainRuns(f, width, engineW)
    const runText = (r: Run, i: number, side: string) =>
      r.kind === 'carLabel' ? (
        <Text key={`${side}${i}`} color="#ffffff" backgroundColor={color} bold>{r.text}</Text>
      ) : r.kind === 'car' ? (
        <Text key={`${side}${i}`} color={color}>{r.text}</Text>
      ) : (
        <Text key={`${side}${i}`} bold={r.kind === 'trackLabel'} dimColor={r.kind === 'track'}>{r.text}</Text>
      )
    const engine =
      'Image' in ui && engineW === ENGINE_COLS ? (
        <ui.Image key="engine" source={engineImage(color, frame, moving)} columns={ENGINE_COLS} rows={2} alt="▶" />
      ) : (
        <Text key="engine" color={color}>▶</Text>
      )
    return (
      <Box flexDirection="row" gap={2} alignItems="flex-end">
        <Box width={titleW} flexShrink={0}>
          <Text color={color}>● </Text>
          <Text wrap="truncate-end">{f.title}</Text>
        </Box>
        <Box flexDirection="row" flexShrink={0} alignItems="flex-end">
          {behind.map((r, i) => runText(r, i, 'b'))}
          {engine}
          {ahead.map((r, i) => runText(r, i, 'a'))}
        </Box>
        <Box flexDirection="row" gap={2} alignSelf="flex-end">
          {crewButton}
          {dismiss}
        </Box>
      </Box>
    )
  })
}
