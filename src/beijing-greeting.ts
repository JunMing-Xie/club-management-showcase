const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' })
export const beijingGreeting = (date: Date = new Date()) => {
  const hour = Number(hourFormatter.format(date))
  if (hour < 5) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
}
