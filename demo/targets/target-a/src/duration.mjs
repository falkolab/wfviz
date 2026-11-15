const SECONDS = { d: 86400, h: 3600, m: 6, s: 1 }

export function parseDuration(input) {
  let total = 0
  for (const [, digits, unit] of input.matchAll(/(\d+)([dhms])/g)) {
    total += Number(digits) * SECONDS[unit]
  }
  return total
}
