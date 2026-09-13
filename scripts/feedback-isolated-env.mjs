import { localEnvPath } from './showcase-local-env.mjs'
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

export const isolatedDatabase = 'club_management_showcase_test'
export const testEnvironment = () => {
  const config = dotenv.parse(fs.readFileSync(localEnvPath))
  const url = new URL(config.DATABASE_URL)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['/club_management_showcase', '/club_management_showcase_test'].includes(url.pathname)) throw new Error('Showcase test database only')
  url.pathname = '/' + isolatedDatabase
  return { ...process.env, ...config, DOTENV_CONFIG_OVERRIDE: '', DOTENV_CONFIG_PATH: localEnvPath, DATABASE_URL: url.toString(), PORT: '4210', CLIENT_ORIGIN: 'http://127.0.0.1:8280', BASE_URL: 'http://127.0.0.1:4210/api', TEST_PROXY_PORT: '8280', TEST_BACKEND_PORT: '4210', TEST_DIST_ROOT: path.resolve('dist') }
}
