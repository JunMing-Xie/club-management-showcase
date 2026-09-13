import { spawn } from 'node:child_process'
import { localEnvPath } from './showcase-local-env.mjs'
const actions = { start: ['up', '-d', 'mysql'], status: ['ps'], stop: ['stop', 'mysql'] }
const args = actions[process.argv[2]]
if (!args) throw Error('Unknown database action')
const child = spawn('docker', ['compose', '--env-file', localEnvPath, ...args], { stdio: 'inherit', windowsHide: true })
child.on('error', () => { console.error('Docker is unavailable'); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
