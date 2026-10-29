/**
 * A failure the caller should see as is: bad input (400), not found (404), a conflict (409), the
 * runner unavailable (503)… HTTP answers with `status`; MCP turns it into a tool error.
 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
