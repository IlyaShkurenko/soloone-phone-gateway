const tails = new Map<string, Promise<unknown>>()
const held = new Map<string, { tag: string; leave: () => Promise<void>; timer: NodeJS.Timeout }>()

// An operation that does not touch the screen; a held screen stays held through it.
export const LEAVE_SCREEN_AS_IS = '*'

// One operation per phone at a time (PGW-4). A screen held open by the previous operation (PGW-37) is left
// first, unless this operation names it in `keep`; the task is told whether it got the screen as left.
export function runOnDevice<T>(key: string, task: (kept: boolean) => Promise<T>, keep?: string): Promise<T> {
  const previous = tails.get(key) || Promise.resolve()
  const next = previous.catch(() => undefined).then(async () => {
    if (keep === LEAVE_SCREEN_AS_IS) return task(held.has(key))
    const screen = held.get(key)
    held.delete(key)
    if (screen) clearTimeout(screen.timer)
    if (screen && screen.tag !== keep) await screen.leave().catch(() => undefined)
    return task(!!screen && screen.tag === keep)
  })
  tails.set(key, next)
  next.finally(() => {
    if (tails.get(key) === next) tails.delete(key)
  }).catch(() => undefined)
  return next
}

// Called from inside an operation: the screen stays as it is, and is left after `ms` unless an operation keeps it.
export function holdScreen(key: string, tag: string, leave: () => Promise<void>, ms: number): void {
  const timer = setTimeout(() => { void runOnDevice(key, async () => undefined).catch(() => undefined) }, ms)
  timer.unref?.()
  held.set(key, { tag, leave, timer })
}
