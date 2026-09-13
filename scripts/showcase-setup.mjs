import { localEnvPath } from './showcase-local-env.mjs'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

if (fs.existsSync(localEnvPath)) {
  console.log('Existing external local configuration retained. Edit your local configuration manually if needed.')
} else {
  const databasePassword = randomBytes(24).toString('hex')
  let example = fs.readFileSync('.env.example', 'utf8')
  example = example.replace('showcase_app:CHANGE_ME@', `showcase_app:${databasePassword}@`)
    .replace('MYSQL_PASSWORD=CHANGE_ME', `MYSQL_PASSWORD=${databasePassword}`)
    .replace('MYSQL_ROOT_PASSWORD=CHANGE_ME', `MYSQL_ROOT_PASSWORD=${randomBytes(32).toString('hex')}`)
    .replace('JWT_SECRET=GENERATE_A_RANDOM_VALUE_AT_LEAST_32_CHARACTERS', `JWT_SECRET=${randomBytes(48).toString('hex')}`)
  fs.writeFileSync(localEnvPath, example, { flag: 'wx', mode: 0o600 })
  console.log('Created external local configuration with newly generated local secrets. No values printed.')
}
for (const directory of ['uploads', 'output']) fs.mkdirSync(directory, { recursive: true })
