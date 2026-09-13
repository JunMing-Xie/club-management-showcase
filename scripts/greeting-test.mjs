import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { beijingGreeting } from '../src/beijing-greeting.ts'

const examples = [['06:00','早上好'],['12:30','中午好'],['16:00','下午好'],['18:30','晚上好'],['02:00','夜深了'],['04:59','夜深了'],['05:00','早上好'],['11:59','早上好'],['12:00','中午好'],['13:59','中午好'],['14:00','下午好'],['17:59','下午好'],['18:00','晚上好'],['23:59','晚上好'],['00:00','夜深了']]
for (const [time, expected] of examples) assert.equal(beijingGreeting(new Date(`2026-09-11T${time}:00+08:00`)), expected)
if (!process.env.GREETING_CHILD) {
  for (const zone of ['UTC','America/Los_Angeles','Asia/Tokyo']) {
    const child = spawnSync(process.execPath, ['--import','tsx','scripts/greeting-test.mjs'], { env: { ...process.env, TZ: zone, GREETING_CHILD: '1' }, encoding: 'utf8', windowsHide: true })
    assert.equal(child.status, 0, 'Timezone boundary test failed: ' + zone)
  }
  console.log(JSON.stringify({ greeting: 'PASS', boundaryCases: examples.length, hostTimezones: ['UTC','America/Los_Angeles','Asia/Tokyo'] }))
}
