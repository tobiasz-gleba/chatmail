import { expect, test } from 'bun:test'
import { assignTopicAccents } from './topic-accents'

test('the first five colliding topic IDs keep distinct colors across partial history loads', () => {
  const ids = ['a', 'f', 'k', 'p', 'u']
  let assigned = assignTopicAccents(new Map(), new Set(ids.slice(0, 2)))
  const firstColor = assigned.get('a')
  assigned = assignTopicAccents(assigned, new Set(['k']))
  assigned = assignTopicAccents(assigned, new Set(ids.toReversed()))
  expect(new Set(assigned.values()).size).toBe(5)
  expect(assigned.get('a')).toBe(firstColor)

  const withSixth = assignTopicAccents(assigned, new Set([...ids, 'z']))
  expect(withSixth.has('z')).toBe(true)
  expect(new Set(withSixth.values()).size).toBe(5)
  for (const id of ids) expect(withSixth.get(id)).toBe(assigned.get(id))
})
