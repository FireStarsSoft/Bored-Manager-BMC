import { describe, expect, it, vi } from 'vitest'
import type { ModuleCheckLevel } from '@shared/modules'
import type { ModuleCheckReport } from '@shared/check'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { RulesEditor } from '../../bmc/main/rules'
import {
  ConfigStore,
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  type BmcConfig,
  type BmcSettings
} from '../../bmc/main/store'

/**
 * The four numbers that change how the sweep behaves, edited through the
 * check/apply protocol.
 *
 * Two properties carry most of the weight here. The first is that an empty
 * field means "leave this one alone": three of the four tunables accept 0 as a
 * legal value, so a blank read as zero would quietly switch sensor health off
 * instead of leaving it be. The second is that nothing is written without the
 * token from the report the user actually read.
 */

function settingsDoc(over: Partial<BmcSettings> = {}, hintsOn = true): BmcConfig {
  return {
    version: 2,
    machines: [],
    settings: { ...DEFAULT_SETTINGS, ...over },
    hintsOn
  }
}

function editor(seed: BmcConfig = settingsDoc()) {
  const config = sharedModuleConfig(seed)
  const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }), { config })
  const store = new ConfigStore(harness.ctx)
  const onApplied = vi.fn()
  return { config, store, onApplied, rules: new RulesEditor(harness.ctx, store, onApplied) }
}

function labels(report: ModuleCheckReport, level: ModuleCheckLevel): string[] {
  return report.findings.filter((finding) => finding.level === level).map((finding) => finding.label)
}

/** The "x becomes y" lines - one per field the report says would actually move. */
function changeLines(report: ModuleCheckReport): string[] {
  return report.findings.map((finding) => finding.label).filter((label) => label.includes('becomes'))
}

describe('RulesEditor.effective', () => {
  it('hands back the four tunables as numbers a form can prefill', () => {
    const { rules } = editor(settingsDoc({ sweepConcurrency: 8, selFetchCount: 250 }))

    expect(rules.effective()).toMatchObject({
      sweepConcurrency: 8,
      sensorEverySweeps: DEFAULT_SETTINGS.sensorEverySweeps,
      selFetchCount: 250,
      identifySeconds: DEFAULT_SETTINGS.identifySeconds
    })
  })

  it('spells out what the sensor cadence means, because the bare number does not', () => {
    // 0 is not "off by accident" and 1 is not "3 but faster" - the same field
    // covers three different behaviours, so it gets a sentence per behaviour.
    const off = editor(settingsDoc({ sensorEverySweeps: 0 })).rules.effective().sensorNote
    const every = editor(settingsDoc({ sensorEverySweeps: 1 })).rules.effective().sensorNote
    const third = editor(settingsDoc({ sensorEverySweeps: 3 })).rules.effective().sensorNote

    expect(off).toMatch(/not read/i)
    expect(off).toMatch(/power state/i)
    expect(every).toMatch(/every sweep/i)
    expect(third).toMatch(/every 3rd sweep/)
    expect(new Set([off, every, third]).size).toBe(3)
  })
})

/**
 * The suffix on the cadence sentence, which is prose a user reads rather than
 * a number a machine parses.
 *
 * It was built by appending a literal "th", so the default of 3 rendered
 * "every 3th sweep" - the first line on the Behaviour page of a fresh install.
 * The suffixes below are written out by hand on purpose: a test that derives
 * them the same way the source does would agree with the source about the
 * wrong answer too.
 */
const ORDINAL_SUFFIXES: Readonly<Record<number, string>> = {
  2: 'nd',
  3: 'rd',
  4: 'th',
  5: 'th',
  6: 'th',
  7: 'th',
  8: 'th',
  9: 'th',
  10: 'th',
  11: 'th',
  12: 'th',
  13: 'th',
  14: 'th',
  15: 'th',
  16: 'th',
  17: 'th',
  18: 'th',
  19: 'th',
  20: 'th'
}

describe('RulesEditor.effective: the sensor cadence reads as English', () => {
  it('covers the whole allowed cadence range, so no reachable value is left untested', () => {
    // The table above is written out to exactly this range. If the ceiling
    // moves past 20 the table has to grow with it - and 21 takes "st" again,
    // which nothing below would otherwise exercise.
    expect(SETTING_LIMITS.sensorEverySweeps).toEqual({ min: 0, max: 20 })
    expect(Object.keys(ORDINAL_SUFFIXES).map(Number)).toEqual(
      Array.from({ length: 19 }, (_, index) => index + 2)
    )
  })

  it('says sensors are off, and why the cards still have a colour, when the cadence is 0', () => {
    const note = editor(settingsDoc({ sensorEverySweeps: 0 })).rules.effective().sensorNote

    expect(note).toBe(
      'Sensors are not read during sweeps - machine health comes from the chassis power state alone.'
    )
  })

  it('says "every sweep" rather than "every 1st sweep" when the cadence is 1', () => {
    const note = editor(settingsDoc({ sensorEverySweeps: 1 })).rules.effective().sensorNote

    expect(note).toBe('Sensors are read on every sweep.')
  })

  for (const [sweeps, suffix] of Object.entries(ORDINAL_SUFFIXES)) {
    const value = Number(sweeps)
    it(`writes a real ordinal for a cadence of ${value}, not the number with "th" stuck on it`, () => {
      const note = editor(settingsDoc({ sensorEverySweeps: value })).rules.effective().sensorNote

      expect(note).toBe(`Sensors are read on every ${value}${suffix} sweep.`)
    })
  }

  it('renders the default cadence correctly, which is the sentence every fresh install opens on', () => {
    // 3 shipped as "every 3th sweep": the one value that had to be right.
    const note = editor().rules.effective().sensorNote

    expect(DEFAULT_SETTINGS.sensorEverySweeps).toBe(3)
    expect(note).toBe('Sensors are read on every 3rd sweep.')
  })

  it('never emits a malformed ordinal anywhere in the allowed range', () => {
    const notes = Array.from({ length: SETTING_LIMITS.sensorEverySweeps.max + 1 }, (_, sweeps) =>
      editor(settingsDoc({ sensorEverySweeps: sweeps })).rules.effective().sensorNote
    )

    for (const note of notes) {
      // "2th", "3th" - what a naive suffix produces. The lookbehind spares the
      // teens, where 11th, 12th and 13th are the correct forms.
      expect(note).not.toMatch(/(?<!1)[123]th\b/)
      expect(note).toMatch(/^Sensors are (not read during sweeps|read on every) .*[.]$/)
    }
    // Every cadence describes a different behaviour, so no two share a sentence.
    expect(new Set(notes).size).toBe(notes.length)
  })
})

describe('RulesEditor.check: an empty field means "leave this one alone"', () => {
  it('changes nothing at all when every field is submitted empty', () => {
    // Not the same as zero: 0 is a legal value for the sensor cadence and the
    // blink default, so reading a blank as 0 would switch sensor health off
    // for somebody who only came to raise the SEL fetch count.
    const { rules, store } = editor()

    const report = rules.check({
      sweepConcurrency: '',
      sensorEverySweeps: '',
      selFetchCount: '   ',
      identifySeconds: ''
    })

    expect(report.ok).toBe(true)
    expect(changeLines(report)).toEqual([])
    expect(labels(report, 'pass')).toContain('Nothing would change')
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
  })

  it('reports nothing would change for a submission with no fields in it at all', () => {
    const { rules } = editor()

    const report = rules.check({})

    expect(report.ok).toBe(true)
    expect(labels(report, 'pass')).toEqual(['Nothing would change'])
  })

  it('moves only the field that was filled in, and leaves the other three alone', () => {
    const { rules, store } = editor()
    const values = { selFetchCount: '250' }

    const report = rules.check(values)

    expect(changeLines(report)).toHaveLength(1)
    expect(changeLines(report)[0]).toContain('Event log entries fetched: 100 becomes 250 entries')

    rules.apply({ token: report.token, values })
    expect(store.settings()).toEqual({ ...DEFAULT_SETTINGS, selFetchCount: 250 })
  })

  it('says nothing would change when a field is filled in with the value it already has', () => {
    const { rules } = editor()

    const report = rules.check({ sweepConcurrency: String(DEFAULT_SETTINGS.sweepConcurrency) })

    expect(report.ok).toBe(true)
    expect(changeLines(report)).toEqual([])
    expect(labels(report, 'pass')).toContain('Nothing would change')
  })
})

describe('RulesEditor.check: values it refuses', () => {
  const rejected: Array<{ name: string; values: Record<string, string>; label: RegExp }> = [
    { name: 'a fraction', values: { sweepConcurrency: '2.5' }, label: /"2\.5" is not a whole number/ },
    { name: 'text', values: { selFetchCount: 'lots' }, label: /"lots" is not a whole number/ },
    { name: 'a value under the minimum', values: { selFetchCount: '5' }, label: /between 10 and 1000/ },
    { name: 'a value over the maximum', values: { sweepConcurrency: '99' }, label: /between 1 and 16/ },
    { name: 'a negative blink time', values: { identifySeconds: '-1' }, label: /between 0 and 255/ }
  ]

  for (const row of rejected) {
    it(`refuses ${row.name} with an error naming the allowed range, and issues no token`, () => {
      const { rules, store } = editor()

      const report = rules.check(row.values)

      expect(report.ok).toBe(false)
      expect(labels(report, 'error').join('\n')).toMatch(row.label)
      // No token means the form cannot apply what it was just told is wrong.
      expect(report.token).toBeUndefined()
      expect(store.settings()).toEqual(DEFAULT_SETTINGS)
    })
  }

  it('names the value the user typed in the detail of a range error', () => {
    const { rules } = editor()

    const report = rules.check({ selFetchCount: '5' })

    expect(report.findings.find((finding) => finding.level === 'error')?.detail).toBe('You entered 5.')
  })

  it('blocks the whole submission when one field is wrong, including the fields that were fine', () => {
    const { rules } = editor()

    const report = rules.check({ sweepConcurrency: '8', selFetchCount: '5' })

    expect(report.ok).toBe(false)
    expect(report.token).toBeUndefined()
    expect(changeLines(report)).toEqual([])
  })
})

describe('RulesEditor.check: warnings that do not block', () => {
  it('warns that switching the sensor cadence to 0 takes machine colour back to power alone', () => {
    const { rules } = editor()

    const report = rules.check({ sensorEverySweeps: '0' })

    expect(report.ok).toBe(true)
    expect(report.token).toBeTruthy()
    expect(labels(report, 'warning')).toContain('Sensor health will be switched off')
    expect(
      report.findings.find((finding) => finding.level === 'warning')?.detail
    ).toMatch(/chassis power state/i)
  })

  it('does not repeat the sensor warning when the cadence was already 0', () => {
    const { rules } = editor(settingsDoc({ sensorEverySweeps: 0 }))

    const report = rules.check({ sensorEverySweeps: '0' })

    expect(labels(report, 'warning')).toEqual([])
  })

  it('warns when the sweep would run more ipmitool processes at once than it does now', () => {
    const { rules } = editor()

    const report = rules.check({ sweepConcurrency: '8' })

    expect(report.ok).toBe(true)
    expect(labels(report, 'warning')).toContain(
      'The connected machine will run more ipmitool processes at once'
    )
  })

  it('stays quiet when the concurrency goes down instead of up', () => {
    const { rules } = editor()

    const report = rules.check({ sweepConcurrency: '2' })

    expect(labels(report, 'warning')).toEqual([])
    expect(changeLines(report)).toHaveLength(1)
  })
})

describe('RulesEditor.apply', () => {
  it('writes the checked values to the config document when handed the token from that report', () => {
    const { rules, store, config, onApplied } = editor()
    const values = { sweepConcurrency: '8', sensorEverySweeps: '1' }
    const report = rules.check(values)

    const result = rules.apply({ token: report.token, values })

    expect(result).toEqual({ ok: true })
    expect(store.settings()).toEqual({
      ...DEFAULT_SETTINGS,
      sweepConcurrency: 8,
      sensorEverySweeps: 1
    })
    expect((config.get() as BmcConfig).settings.sweepConcurrency).toBe(8)
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('refuses a token that was never issued, and writes nothing', () => {
    const { rules, store, config, onApplied } = editor()
    const values = { sweepConcurrency: '8' }
    rules.check(values)
    const before = JSON.stringify(config.get())

    const result = rules.apply({ token: 'chk_never_issued', values })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/expired|check again/i)
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
    expect(JSON.stringify(config.get())).toBe(before)
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('refuses a submission with no token at all', () => {
    const { rules, onApplied } = editor()

    expect(rules.apply({ values: { sweepConcurrency: '8' } }).ok).toBe(false)
    expect(rules.apply(null).ok).toBe(false)
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('refuses a token whose form was edited after the check, since that plan was never read', () => {
    const { rules, store, onApplied } = editor()
    const report = rules.check({ sweepConcurrency: '8' })

    const result = rules.apply({ token: report.token, values: { sweepConcurrency: '16' } })

    expect(result.ok).toBe(false)
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('spends a token once, so a double submit cannot write twice', () => {
    const { rules, onApplied } = editor()
    const values = { identifySeconds: '30' }
    const report = rules.check(values)

    expect(rules.apply({ token: report.token, values }).ok).toBe(true)
    expect(rules.apply({ token: report.token, values }).ok).toBe(false)
    expect(onApplied).toHaveBeenCalledTimes(1)
  })
})

describe('RulesEditor.reset', () => {
  it('puts every rule back to its default', () => {
    const { rules, store, onApplied } = editor(
      settingsDoc({ sweepConcurrency: 16, sensorEverySweeps: 0, selFetchCount: 1000, identifySeconds: 0 })
    )

    const result = rules.reset()

    expect(result.ok).toBe(true)
    expect(result.data).toBeTruthy()
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
    // A copy, not the frozen module-wide constant: the next edit mutates what
    // is in the store, and that must not rewrite everyone's defaults.
    expect(store.settings()).not.toBe(DEFAULT_SETTINGS)
    expect(onApplied).toHaveBeenCalledTimes(1)
  })
})

/**
 * The hints switch is a plain `form` block in bmc/ui/pages/settings.json, and
 * the app's FormBlock submits a form's fields POSITIONALLY - so the shipped
 * call is `hintsSet(true)`, one bare checkbox value, not the
 * `hintsSet({ hintsOn: true })` that a `checkForm` would send.
 *
 * Reading only the wrapped shape made the switch a one-way door: every save
 * resolved to `false`, so hints could be turned off and never turned back on.
 * The bare cases below are the ones that exercise the real renderer path; the
 * wrapped ones stay because the handler still accepts them and a future block
 * type may send them.
 */
describe('RulesEditor.hintsSet: the bare value the renderer actually sends', () => {
  it('turns hints off when handed the bare `false` a form block submits', () => {
    const { rules, store, onApplied } = editor(settingsDoc({}, true))

    expect(rules.hintsSet(false)).toEqual({ ok: true })

    expect(store.read().hintsOn).toBe(false)
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('turns hints back ON when handed the bare `true`, which is the half that was broken', () => {
    const { rules, store, onApplied } = editor(settingsDoc({}, false))

    expect(rules.hintsSet(true)).toEqual({ ok: true })

    expect(store.read().hintsOn).toBe(true)
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('survives a full on -> off -> on round trip, so the switch is not a one-way door', () => {
    // The assertion the old wrapped-only tests could not make: a switch that
    // always resolves to `false` passes "turns off" and fails only here.
    const { rules, store, onApplied } = editor(settingsDoc({}, true))

    rules.hintsSet(false)
    expect(store.read().hintsOn).toBe(false)

    rules.hintsSet(true)
    expect(store.read().hintsOn).toBe(true)

    rules.hintsSet(false)
    expect(store.read().hintsOn).toBe(false)

    rules.hintsSet(true)
    expect(store.read().hintsOn).toBe(true)
    expect(onApplied).toHaveBeenCalledTimes(4)
  })

  it('accepts the bare string "true" as well as the boolean, since not every input is a checkbox', () => {
    const { rules, store } = editor(settingsDoc({}, false))

    rules.hintsSet('true')

    expect(store.read().hintsOn).toBe(true)
  })
})

describe('RulesEditor.hintsSet: the wrapped shape a checkForm would send', () => {
  it('writes the flag and re-emits, since the pages read it from the ui stream', () => {
    const { rules, store, onApplied } = editor(settingsDoc({}, true))

    expect(rules.hintsSet({ hintsOn: false })).toEqual({ ok: true })

    expect(store.read().hintsOn).toBe(false)
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('accepts the boolean and the string "true" alike, because a form may send either', () => {
    const fromBoolean = editor(settingsDoc({}, false))
    fromBoolean.rules.hintsSet({ hintsOn: true })
    expect(fromBoolean.store.read().hintsOn).toBe(true)

    const fromText = editor(settingsDoc({}, false))
    fromText.rules.hintsSet({ hintsOn: 'true' })
    expect(fromText.store.read().hintsOn).toBe(true)
  })

  it('round trips on -> off -> on wrapped too, so neither shape is a one-way door', () => {
    const { rules, store } = editor(settingsDoc({}, true))

    rules.hintsSet({ hintsOn: false })
    expect(store.read().hintsOn).toBe(false)

    rules.hintsSet({ hintsOn: true })
    expect(store.read().hintsOn).toBe(true)

    rules.hintsSet({ hintsOn: false })
    expect(store.read().hintsOn).toBe(false)
  })
})

describe('RulesEditor.hintsSet: everything that is not an affirmative', () => {
  const notTrue: unknown[] = [
    { hintsOn: 'yes' },
    { hintsOn: '1' },
    { hintsOn: 1 },
    { hintsOn: 'false' },
    {},
    null,
    'yes',
    '1',
    1,
    0,
    'false',
    undefined
  ]

  for (const raw of notTrue) {
    it(`treats ${JSON.stringify(raw)} as off rather than as truthy`, () => {
      const { rules, store } = editor(settingsDoc({}, true))

      expect(rules.hintsSet(raw)).toEqual({ ok: true })

      expect(store.read().hintsOn).toBe(false)
    })
  }
})

describe('RulesEditor: the applied callback', () => {
  it('fires exactly once per write and never for a check, since it re-emits the ui and capabilities streams', () => {
    const { rules, onApplied } = editor()
    const values = { identifySeconds: '30' }

    const report = rules.check(values)
    expect(onApplied).not.toHaveBeenCalled()

    rules.apply({ token: report.token, values })
    expect(onApplied).toHaveBeenCalledTimes(1)

    rules.reset()
    expect(onApplied).toHaveBeenCalledTimes(2)

    // Bare, the way the settings page's `form` block submits it.
    rules.hintsSet(false)
    expect(onApplied).toHaveBeenCalledTimes(3)
  })
})
