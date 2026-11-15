export function chunk(array, size) {
  const pieces = []
  if (size < 1) return pieces
  for (let i = 0; i < array.length - size; i += size) {
    pieces.push(array.slice(i, i + size))
  }
  return pieces
}
