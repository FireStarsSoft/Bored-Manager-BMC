import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ModuleManifest } from '@shared/modules'
import type { ActionSpec, AttentionWhen, Block, DataSource, PageSpec, SubnavBlock, WidgetSpec } from '@shared/module-ui'

/**
 * The layout conventions this module inherits from OpenWRT and Services.
 *
 * They are repetitive, they are invisible in a diff, and they are only ever
 * noticed by somebody using the page: a table with no `emptyText` that renders
 * as a blank rectangle, an explanation put in `FormField.help` where the hints
 * switch cannot reach it, a warning banner wrapped in the hints conditional so
 * that turning explanations off also turns off "this is broken", a page that
 * draws fleet figures before it has been told the module can read anything.
 *
 * None of that fails `specProblems`, none of it fails a typecheck, and all of
 * it is one careless edit away. So the conventions are asserted here, and the
 * language stays coherent because CI says so rather than because whoever edits
 * a page next happens to remember.
 */

const ID = 'bmc'
const ROOT = join(process.cwd(), ID)
const manifest = JSON.parse(readFileSync(join(ROOT, 'module.json'), 'utf8')) as ModuleManifest

/** A page and a widget are the same tree; only the file they live in differs. */
type Spec = PageSpec | WidgetSpec

function specNamed(file: string): Spec {
  return JSON.parse(readFileSync(join(ROOT, 'ui', file), 'utf8')) as Spec
}

const PAGE_IDS = (manifest.pages ?? []).map((entry) => entry.id)
const WIDGET_IDS = (manifest.widgets ?? []).map((entry) => entry.id)
const SPEC_FILES = [
  ...PAGE_IDS.map((id) => `pages/${id}.json`),
  ...WIDGET_IDS.map((id) => `widgets/${id}.json`)
]

const page = (id: string): Spec => specNamed(`pages/${id}.json`)
const widget = (id: string): Spec => specNamed(`widgets/${id}.json`)

/** One block, plus what the walk had to go through to reach it. */
interface Visited {
  block: Block
  /** Every block enclosing it, outermost first. */
  ancestors: Block[]
  /** True when it was reached through a `rowDetail` array - i.e. it only exists inside an open drawer. */
  drawer: boolean
}

/**
 * Every block in a spec, however deeply nested.
 *
 * The four ways a block holds other blocks are `blocks`, a conditional's
 * `else`, a table/statusCards `rowDetail`, and a subnav item's own `blocks` -
 * a walk that misses any one of them silently passes whole pages.
 */
function walk(blocks: readonly Block[] | undefined, ancestors: Block[] = [], drawer = false): Visited[] {
  const out: Visited[] = []
  for (const block of blocks ?? []) {
    out.push({ block, ancestors, drawer })
    const inside = [...ancestors, block]
    if (block.type === 'section' || block.type === 'conditional') {
      out.push(...walk(block.blocks, inside, drawer))
    }
    if (block.type === 'conditional') out.push(...walk(block.else, inside, drawer))
    if (block.type === 'table' || block.type === 'statusCards') {
      out.push(...walk(block.rowDetail, inside, true))
    }
    if (block.type === 'subnav') {
      for (const item of block.items) out.push(...walk(item.blocks, inside, drawer))
    }
  }
  return out
}

function visitedIn(spec: Spec): Visited[] {
  return walk(spec.blocks)
}

function blocksOf(spec: Spec): Block[] {
  return visitedIn(spec).map((entry) => entry.block)
}

/** Does this conditional decide what to show from the readiness stream? */
function isCapabilityGate(block: Block): boolean {
  if (block.type !== 'conditional') return false
  const source = block.when.source
  return source.kind === 'stream' && source.event === 'capabilities'
}

/** Does this conditional decide what to show from the hints switch? */
function isHintsGate(block: Block): boolean {
  if (block.type !== 'conditional') return false
  const source = block.when.source
  if (source.kind !== 'stream' || source.event !== 'ui') return false
  // The dot-path may sit on the source or on the `when`; both resolve the same.
  return source.path === 'hintsOn' || block.when.path === 'hintsOn'
}

/** Blocks that draw a number the module claims to have read off something. */
const FIGURE_TYPES: ReadonlyArray<Block['type']> = [
  'stat',
  'meter',
  'chart',
  'pie',
  'keyValue',
  'list',
  'table',
  'statusCards'
]

/** Blocks whose body is a variable-length collection, so it can come back empty. */
function emptyTextOf(block: Block): string | undefined | null {
  switch (block.type) {
    case 'table':
    case 'list':
    case 'statusCards':
    // A pie of zero slices is as blank as a table of zero rows.
    case 'pie':
      return block.emptyText ?? null
    default:
      return undefined
  }
}

/** Every button that calls a method, wherever a block hangs one. */
function actionsIn(block: Block): ActionSpec[] {
  switch (block.type) {
    case 'actions':
      return block.actions
    case 'form':
      return [block.submit]
    case 'table':
      return [...(block.rowActions ?? []), ...(block.bulkActions ?? [])]
    case 'statusCards':
      return block.rowActions ?? []
    default:
      return []
  }
}

/**
 * The icon names the app will actually draw - `MODULE_ICON_NAMES` in
 * shared/module-ui.ts, which is not exported, so it is restated here. A name
 * outside it renders as nothing at all: the rail item keeps its label and
 * loses its picture, which reads as a rendering bug rather than a typo.
 */
const MODULE_ICONS: ReadonlySet<string> = new Set([
  'Activity',
  'Boxes',
  'Cable',
  'Container',
  'Cpu',
  'FileText',
  'FolderTree',
  'Gauge',
  'HardDrive',
  'Info',
  'Layers',
  'ListTree',
  'Network',
  'Server',
  'Settings2',
  'Sparkles',
  'Tag',
  'Thermometer',
  'Zap'
])

const DECLARED_STREAMS = new Set((manifest.streams ?? []).map((stream) => stream.event))
const DECLARED_METHODS = new Set(manifest.methods ?? [])
const DECLARED_HISTORY = new Set(manifest.storage?.history?.streams ?? [])
/** The app's own streams; a module may read these without declaring anything. */
const CORE_STREAMS = new Set(['system', 'top', 'services'])

/** Why this source cannot resolve, or null when the manifest backs it. */
function sourceProblem(source: DataSource | undefined): string | null {
  if (source == null || typeof source !== 'object') return 'has no source'
  switch (source.kind) {
    case 'stream':
      return DECLARED_STREAMS.has(source.event) ? null : `reads undeclared stream "${source.event}"`
    case 'invoke':
      return DECLARED_METHODS.has(source.method) ? null : `calls undeclared method "${source.method}"`
    case 'history':
      return DECLARED_HISTORY.has(source.stream) ? null : `reads undeclared history "${source.stream}"`
    case 'core':
      return CORE_STREAMS.has(source.stream) ? null : `reads unknown core stream "${source.stream}"`
    default:
      return `has an unknown source kind "${String((source as { kind?: unknown }).kind)}"`
  }
}

/** The `attention` clause a `stat`, `meter` or `pie` may carry. */
function attentionOf(block: Block): AttentionWhen | undefined {
  switch (block.type) {
    case 'stat':
    case 'meter':
    case 'pie':
      return block.attention
    default:
      return undefined
  }
}

/** The one subnav on a page, and its items by id. */
function railOf(spec: Spec): SubnavBlock {
  const rails = blocksOf(spec).filter((block): block is SubnavBlock => block.type === 'subnav')
  if (rails.length !== 1) throw new Error(`expected exactly one subnav, found ${rails.length}`)
  return rails[0]
}

function tab(spec: Spec, id: string): SubnavBlock['items'][number] {
  const item = railOf(spec).items.find((entry) => entry.id === id)
  if (!item) {
    throw new Error(`no "${id}" tab; the rail has ${railOf(spec).items.map((e) => e.id).join(', ')}`)
  }
  return item
}

/** Every string anywhere in a spec - a label, a note line, a placeholder. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) strings(item, out)
    return out
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) strings(child, out)
  }
  return out
}

describe('every page opens with the readiness gate', () => {
  it.each(PAGE_IDS)('%s has one root block and it is the capabilities gate', (id) => {
    // A page that drew a fleet figure beside the gate would be drawing one it
    // had not been told: until `capabilities` says ipmitool is there, every
    // number on the page is either stale or invented.
    const spec = page(id)
    expect(spec.blocks, id).toHaveLength(1)
    const root = spec.blocks[0]
    expect(root.type, id).toBe('conditional')
    expect(isCapabilityGate(root), `${id}: root conditional does not read the capabilities stream`).toBe(
      true
    )
  })
})

describe('every page is one rail', () => {
  it.each(PAGE_IDS)('%s groups its content into exactly one subnav', (id) => {
    const rails = visitedIn(page(id)).filter((entry) => entry.block.type === 'subnav')
    expect(rails, id).toHaveLength(1)
  })

  it.each(PAGE_IDS)('%s keeps that subnav out of the row drawers', (id) => {
    // A rail inside a drawer is a second navigation the user has to discover by
    // opening a card, and it disappears the moment the drawer closes.
    const rails = visitedIn(page(id)).filter((entry) => entry.block.type === 'subnav')
    expect(rails.map((entry) => entry.drawer), id).toEqual(rails.map(() => false))
  })

  it.each(PAGE_IDS)('%s names a real lucide icon on every rail item', (id) => {
    for (const block of blocksOf(page(id))) {
      if (block.type !== 'subnav') continue
      for (const item of block.items) {
        // The renderer looks the name up in the app's allowed lucide set; a
        // lowercase or empty name resolves to nothing and the item draws blank.
        expect(item.icon, `${id}: rail item ${item.id}`).toMatch(/^[A-Z][A-Za-z0-9]*$/)
      }
    }
  })

  it.each(PAGE_IDS)('%s picks every rail icon out of the set the app can draw', (id) => {
    // Shape is not enough: `Thermostat` and `Lightning` are both well-formed
    // and neither is in the map, so both render as an empty square beside a
    // label - which looks like the app failing rather than the spec being wrong.
    for (const item of railOf(page(id)).items) {
      expect([...MODULE_ICONS], `${id}: rail item ${item.id} asks for "${item.icon}"`).toContain(
        item.icon
      )
    }
  })
})

describe('prose lives in notes, not in field help', () => {
  it.each(PAGE_IDS)('%s never uses FormField.help', (id) => {
    // `help` renders as an always-on line under its field: the hints switch
    // cannot gate it and it cannot be more than a line. Both of those are
    // things this module's explanations need, so they live in `note` blocks.
    for (const block of blocksOf(page(id))) {
      if (block.type !== 'form' && block.type !== 'checkForm') continue
      for (const field of block.fields) {
        expect(field.help, `${id}: field ${field.key}`).toBeUndefined()
      }
    }
  })

  it.each(PAGE_IDS)('%s carries at least one note the hints switch can hide', (id) => {
    const notes = blocksOf(page(id)).filter((block) => block.type === 'note')
    expect(notes.length, id).toBeGreaterThan(0)
  })
})

describe('nothing renders as a blank rectangle', () => {
  it.each(SPEC_FILES)('%s gives every collection an emptyText', (file) => {
    for (const block of blocksOf(specNamed(file))) {
      const text = emptyTextOf(block)
      if (text === undefined) continue
      expect(text, `${file}: a ${block.type} with no emptyText`).toBeTruthy()
    }
  })

  it.each(SPEC_FILES)('%s writes every emptyText as a sentence, not as "No data"', (file) => {
    const LAZY = ['no data', 'none', 'empty']
    for (const block of blocksOf(specNamed(file))) {
      const text = emptyTextOf(block)
      if (typeof text !== 'string') continue
      // Long enough to answer "why is this empty, and what do I do next" -
      // which is the only question a reader looking at an empty box has.
      expect(text.length, `${file}: ${block.type} says "${text}"`).toBeGreaterThan(20)
      expect(LAZY, `${file}: ${block.type} says "${text}"`).not.toContain(text.trim().toLowerCase())
    }
  })
})

describe('destructive buttons say so before they are pressed', () => {
  it.each(PAGE_IDS)('%s marks every destroying action danger and confirms it', (id) => {
    for (const block of blocksOf(page(id))) {
      for (const action of actionsIn(block)) {
        if (!/Delete|Clear|Reset|Forget|Uninstall/i.test(action.method)) continue
        // Red button *and* a question. The colour alone is a convention the
        // user may not know; the dialog alone lets it be pressed by accident.
        expect(action.kind, `${id}: ${action.method} ("${action.label}")`).toBe('danger')
        expect(typeof action.confirm, `${id}: ${action.method} ("${action.label}")`).toBe('string')
        expect(action.confirm?.length ?? 0, `${id}: ${action.method}`).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * The two tabs 2.0.0 added to Management, and the conventions they brought
 * with them.
 *
 * Attention is a fleet-wide list of everything the last sweep found outside
 * its thresholds; Bulk power runs one power action against every ticked row.
 * They are checked by name rather than only by the sweeping rules above
 * because each one is the only thing on the page that reaches its method: a
 * tab quietly dropped in an edit takes `attentionRows` or `powerBulk` out of
 * the UI entirely, and every remaining rule would still pass.
 */
describe('the Attention and Bulk power tabs', () => {
  it('puts both on the Management rail, each with a label and an icon the app can draw', () => {
    const attention = tab(page('management'), 'attention')
    const bulk = tab(page('management'), 'bulk')

    expect(attention.label).toBeTruthy()
    expect(bulk.label).toBeTruthy()
    expect([...MODULE_ICONS]).toContain(attention.icon)
    expect([...MODULE_ICONS]).toContain(bulk.icon)
  })

  it('reaches attentionRows from the Attention tab and powerBulk from the Bulk power one', () => {
    // Which tab a method hangs off is not arbitrary: `attentionRows` is a read
    // and `powerBulk` acts on hardware, and the page keeps them apart so a
    // click that cuts power is never one tab away from a click that does not.
    const methodsUnder = (id: string): string[] =>
      walk(tab(page('management'), id).blocks)
        .flatMap(({ block }) => [
          ...actionsIn(block).map((action) => action.method),
          block.type === 'table' && block.source.kind === 'invoke' ? block.source.method : ''
        ])
        .filter(Boolean)

    expect(methodsUnder('attention')).toContain('attentionRows')
    expect(methodsUnder('bulk')).toContain('powerBulk')
  })

  it('answers an empty attention table with a sentence saying the fleet is fine', () => {
    const tables = walk(tab(page('management'), 'attention').blocks)
      .map(({ block }) => block)
      .filter((block) => block.type === 'table')

    expect(tables).toHaveLength(1)
    // "No data" over a healthy rack is the one message this table must never
    // show: an empty attention list is the good outcome, and it has to read
    // like one rather than like a read that failed.
    const text = emptyTextOf(tables[0])
    expect(typeof text).toBe('string')
    expect((text as string).length).toBeGreaterThan(20)
  })
})

/**
 * A power action that does not ask first is the defect this module can least
 * afford: the machines on the other end are somebody's servers, and `off`,
 * `cycle` and `reset` all cut power with the operating system given no notice.
 *
 * The rule above catches destroying *methods* by name. These act through
 * `powerAction` and `powerBulk`, whose names say nothing - what makes one
 * destructive is the verb in its `args`.
 */
describe('a button that cuts power says so before it is pressed', () => {
  const CUTS_POWER = new Set(['off', 'cycle', 'reset'])

  it.each(PAGE_IDS)('%s marks every hard power action danger and confirms it', (id) => {
    for (const block of blocksOf(page(id))) {
      for (const action of actionsIn(block)) {
        if (!/^power/i.test(action.method)) continue
        if (!(action.args ?? []).some((arg) => CUTS_POWER.has(String(arg)))) continue
        expect(action.kind, `${id}: ${action.label}`).toBe('danger')
        expect(typeof action.confirm, `${id}: ${action.label}`).toBe('string')
        expect(action.confirm?.length ?? 0, `${id}: ${action.label}`).toBeGreaterThan(0)
      }
    }
  })

  it.each(PAGE_IDS)('%s confirms every bulk action, destructive or not', (id) => {
    for (const block of blocksOf(page(id))) {
      if (block.type !== 'table') continue
      for (const action of block.bulkActions ?? []) {
        // Even the gentle ones. A bulk button acts on however many rows happen
        // to be ticked, and the user cannot see that count on the button - so
        // the dialog is where "this is about to touch nineteen machines" gets
        // said, and there is nothing here that acts on one row.
        expect(typeof action.confirm, `${id}: bulk "${action.label}"`).toBe('string')
        expect(action.confirm?.length ?? 0, `${id}: bulk "${action.label}"`).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * A selection is a list of `rowKey` values, so a table that can be ticked has
 * to name a field that is unique per row. Left to the default - the first
 * column's key - a bulk power action on a rack where two machines share a
 * display name would act on rows nobody ticked.
 */
describe('a tickable table names the key its selection is made of', () => {
  it.each(SPEC_FILES)('%s gives every selectable table an explicit rowKey', (file) => {
    for (const block of blocksOf(specNamed(file))) {
      if (block.type !== 'table' || block.selectable !== true) continue
      expect(typeof block.rowKey, `${file}: a selectable table with no rowKey`).toBe('string')
      expect(block.rowKey?.length ?? 0, `${file}: a selectable table with an empty rowKey`).toBeGreaterThan(0)
    }
  })

  it.each(SPEC_FILES)('%s never hangs bulk actions off a table nothing can be ticked in', (file) => {
    for (const block of blocksOf(specNamed(file))) {
      if (block.type !== 'table' || (block.bulkActions ?? []).length === 0) continue
      // Without `selectable` there is no tick column and no toolbar, so the
      // buttons exist in the spec and appear nowhere on the page.
      expect(block.selectable, `${file}: bulkActions on a table that is not selectable`).toBe(true)
    }
  })
})

/**
 * The vocabulary 0.6.0 added: a block says *when* something is urgent and the
 * app decides what urgent looks like. Both halves of it are bindings, and a
 * binding that resolves to nothing fails silently - the block renders
 * perfectly, and the one card that should have been moving simply is not.
 * There is no error, no blank space and no way to notice by looking.
 */
describe('a block that asks for the reader’s eye binds to something real', () => {
  it.each(SPEC_FILES)('%s names a declared source in every attention clause', (file) => {
    for (const block of blocksOf(specNamed(file))) {
      const attention = attentionOf(block)
      if (!attention) continue
      expect(sourceProblem(attention.source), `${file}: ${block.type}.attention`).toBeNull()
      // Same three operators a `conditional` has; anything else is read as
      // "never urgent" rather than rejected.
      expect(['exists', 'eq', 'gt'], `${file}: ${block.type}.attention.op`).toContain(attention.op)
    }
  })

  it.each(SPEC_FILES)('%s gives every attentionKey a field name to read', (file) => {
    for (const block of blocksOf(specNamed(file))) {
      if (block.type !== 'statusCards' || block.attentionKey === undefined) continue
      expect(typeof block.attentionKey, `${file}: statusCards.attentionKey`).toBe('string')
      expect(block.attentionKey.length, `${file}: an empty statusCards.attentionKey`).toBeGreaterThan(0)
    }
  })
})

describe('charts offer more than one range', () => {
  it.each(PAGE_IDS)('%s never puts two charts on the same window', (id) => {
    const windows: number[] = []
    for (const block of blocksOf(page(id))) {
      if (block.type === 'chart' && typeof block.window === 'number') windows.push(block.window)
    }
    if (windows.length === 0) return
    // A pinned `window` overrides the range picker the app draws above the
    // page, so two charts sharing one is the same view drawn twice with no way
    // to zoom out of either.
    expect(new Set(windows).size, `${id}: windows ${windows.join(', ')}`).toBe(windows.length)
  })
})

describe('the Overview widget stays a card', () => {
  it.each(WIDGET_IDS)('%s contains no subnav', (id) => {
    // A rail inside a 300px box is a rail nobody can use.
    expect(blocksOf(widget(id)).some((block) => block.type === 'subnav')).toBe(false)
  })

  it.each(WIDGET_IDS)('%s gates on capabilities before it shows a figure', (id) => {
    const spec = widget(id)
    expect(spec.blocks, id).toHaveLength(1)
    expect(isCapabilityGate(spec.blocks[0]), `${id}: root block is not a capabilities gate`).toBe(true)
  })
})

describe('the conventions every spec in the module keeps', () => {
  it.each(SPEC_FILES)('%s draws no figure outside the capabilities gate', (file) => {
    for (const { block, ancestors } of visitedIn(specNamed(file))) {
      if (!FIGURE_TYPES.includes(block.type)) continue
      expect(
        ancestors.some(isCapabilityGate),
        `${file}: a ${block.type} renders without waiting for the readiness gate`
      ).toBe(true)
    }
  })

  it.each(SPEC_FILES)('%s never hides a warning behind the hints switch', (file) => {
    // The rule worth stating twice: a warning note says something is wrong, and
    // turning off explanations must never turn off "this is broken". Clear-text
    // passwords and a machine that cannot be swept are not hints.
    for (const { block, ancestors } of visitedIn(specNamed(file))) {
      if (block.type !== 'note' || block.tone !== 'warning') continue
      expect(ancestors.some(isHintsGate), `${file}: warning note "${block.title ?? block.lines[0]}"`).toBe(
        false
      )
    }
  })

  it.each(SPEC_FILES)('%s contains no URL anywhere', (file) => {
    // `specProblems` rejects a spec that names an off-app address, so a link
    // that got in here would take the whole page down rather than render.
    const offenders = strings(specNamed(file)).filter((value) => /https?:\/\//i.test(value))
    expect(offenders, file).toEqual([])
  })

  // Whether a spec names a method or a stream that exists is checked in
  // tests/unit/spec-contract.test.ts, and checked harder: it compares them
  // against the handlers the module actually registers, and separately proves
  // the registered set equals the declared one. Repeating a weaker form of it
  // here would give the same invariant two homes and one of them would drift.
})
