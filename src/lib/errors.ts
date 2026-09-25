/**
 * Typed errors for the shared service layer.
 *
 * Service functions run in both local mode (in-process with the CLI) and
 * server mode (inside `crm serve`, per RPC frame). They therefore must never
 * call process.exit — they throw ServiceError instead, and each transport
 * decides what to do with it:
 *  - local: printed to stderr, exit 1 (byte-identical to legacy `die()`)
 *  - remote: mapped onto the RPC error frame (code + message travel as-is)
 */
export type ServiceErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INTERNAL'

export class ServiceError extends Error {
  readonly code: ServiceErrorCode

  constructor(code: ServiceErrorCode, message: string) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}
