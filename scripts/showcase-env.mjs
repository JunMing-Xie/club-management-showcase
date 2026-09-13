import dotenv from 'dotenv'
import { spawn } from 'node:child_process'
import { localEnvPath } from './showcase-local-env.mjs'
const result = dotenv.config({ path: localEnvPath, quiet: true })
if (result.error) throw Error('Run npm run demo:setup first')
const child = spawn(process.execPath, process.argv.slice(2), { env: process.env, stdio: 'inherit', windowsHide: true })
child.on('error', () => { console.error('Local command could not start'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
process.on('SIGINT', () => child.kill()); process.on('SIGTERM', () => child.kill())
