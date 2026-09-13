import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dispatchRange } from '../server/dispatch-statistics.ts'
const now = new Date('2026-01-01T00:30:00+08:00')
const cases = [
  ['today', '2025-12-31T16:00:00.000Z', '2026-01-01T16:00:00.000Z'],
  ['week', '2025-12-28T16:00:00.000Z', '2026-01-04T16:00:00.000Z'],
  ['lastWeek', '2025-12-21T16:00:00.000Z', '2025-12-28T16:00:00.000Z'],
  ['month', '2025-12-31T16:00:00.000Z', '2026-01-31T16:00:00.000Z'],
  ['lastMonth', '2025-11-30T16:00:00.000Z', '2025-12-31T16:00:00.000Z'],
]
for (const [period, from, to] of cases) { const range = dispatchRange({ period, page: 1 }, now); assert.equal(range.from.toISOString(), from); assert.equal(range.to.toISOString(), to) }
assert.throws(() => dispatchRange({ period: 'custom', from: '2026-02-30', to: '2026-03-01', page: 1 }))
assert.throws(() => dispatchRange({ period: 'custom', from: '2026-03-03', to: '2026-03-01', page: 1 }))
assert.equal(dispatchRange({ period: 'custom', from: '2024-02-29', to: '2024-02-29', page: 1 }).to.toISOString(), '2024-02-29T16:00:00.000Z')
if (!process.env.DISPATCH_CALENDAR_CHILD) {
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/dispatch-calendar-test.mjs'], { env: { ...process.env, TZ, DISPATCH_CALENDAR_CHILD: '1' }, encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 0, 'Calendar failed in ' + TZ)
  }
  console.log(JSON.stringify({ result: 'PASS', cases: cases.length + 3, timezones: ['UTC', 'America/Los_Angeles', 'Asia/Tokyo'] }))
}
