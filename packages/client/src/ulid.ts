import { randomFillSync } from 'node:crypto'

/** Crockford base32: no I, L, O or U, so an id survives being read aloud or retyped. */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RAND_CHARS = 16

let lastMs = -1
const rand = new Uint8Array(RAND_CHARS) // one 5-bit value per character

function reseed(): void {
  randomFillSync(rand)
  for (let i = 0; i < RAND_CHARS; i++) rand[i] &= 31
}

/** Increments the random part so ids minted in the same millisecond still sort by mint order. */
function increment(): void {
  for (let i = RAND_CHARS - 1; i >= 0; i--) {
    if (rand[i] < 31) {
      rand[i]++
      return
    }
    rand[i] = 0
  }
  reseed() // 80 bits exhausted inside one millisecond: a fresh draw beats repeating the last id
}

/**
 * A monotonic ULID: 48-bit millisecond timestamp then 80 bits of randomness, base32.
 * Lexicographic order is mint order, which is what the spool replays by.
 */
export function ulid(now: number = Date.now()): string {
  if (now === lastMs) increment()
  else {
    lastMs = now
    reseed()
  }
  let time = ''
  for (let t = now, i = 0; i < TIME_CHARS; i++, t = Math.floor(t / 32)) time = ENCODING[t % 32] + time
  let body = ''
  for (let i = 0; i < RAND_CHARS; i++) body += ENCODING[rand[i]]
  return time + body
}
