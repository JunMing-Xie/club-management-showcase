import path from 'node:path'
export const localEnvPath = path.resolve(process.env.SHOWCASE_ENV_FILE || '../.club-management-showcase.local.env')
