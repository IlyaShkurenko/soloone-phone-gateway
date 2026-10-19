// Send was not pressed: the backend may retry when `retryable` is true (PGW-2).
export class SendFailure extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message)
    this.name = 'SendFailure'
  }
}

// Send was pressed but the result was not confirmed. Never retried (PGW-3).
export class SendUncertain extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SendUncertain'
  }
}
