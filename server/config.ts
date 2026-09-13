import 'dotenv/config'

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

const jwtSecret = process.env.JWT_SECRET?.trim() || ''
if (jwtSecret.length < 32) {
  throw new Error('请先运行 npm run demo:setup；环境必须配置长度不少于 32 位的随机 JWT_SECRET')
}

export const config = {
  host: process.env.HOST?.trim() || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'),
  port: numberFromEnv('PORT', 4000),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  jwtSecret,
  defaultCommissionRateBps: numberFromEnv('DEFAULT_COMMISSION_RATE_BPS', 3000),
}
