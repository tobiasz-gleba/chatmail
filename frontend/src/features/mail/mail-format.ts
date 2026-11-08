const dayFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' })
const timeFormatter = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' })

export function initials(name: string) {
  const words = name.trim().split(/\s+/)
  return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
}

export function messageTime(sentAt: string) {
  return timeFormatter.format(new Date(sentAt))
}

function relativeDay(date: Date) {
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return 'Today'
  today.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Yesterday'
}

export function inboxDate(sentAt: string) {
  const date = new Date(sentAt)
  const day = relativeDay(date)
  return day === 'Today' ? messageTime(sentAt) : (day ?? dayFormatter.format(date))
}

export function timelineDate(date: Date) {
  const day = relativeDay(date)
  return day ? `${day}, ${dayFormatter.format(date)}` : dayFormatter.format(date)
}
