const tails = new Map<string, Promise<unknown>>()

// One operation per phone at a time (PGW-4).
export function runOnDevice<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) || Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  tails.set(key, next)
  next.finally(() => {
    if (tails.get(key) === next) tails.delete(key)
  }).catch(() => undefined)
  return next
}
