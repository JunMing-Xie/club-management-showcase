import 'dotenv/config'
import { spawn } from 'node:child_process'
const children = [
  spawn(process.execPath, ['dist/server/index.js'], { stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, ['scripts/client-test-proxy.mjs'], { env: { ...process.env, TEST_DIST_ROOT: 'dist', TEST_PROXY_PORT: '5175', TEST_BACKEND_PORT: '4200' }, stdio: 'inherit', windowsHide: true }),
]
const stop = () => children.forEach(child => child.kill())
process.on('SIGINT', stop); process.on('SIGTERM', stop)
for (const child of children) child.on('exit', code => { if (code) { process.exitCode = code; stop() } })
console.log('Showcase: http://127.0.0.1:5175/admin/login and /workbench/login (local only)')
