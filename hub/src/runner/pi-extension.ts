// pi extension the desk loads into every pi session it starts (pi.ts, `-e`). pi runs tools without
// asking; this asks the desk first. Before each tool call that is not read-only it calls
// ctx.ui.confirm, which in RPC mode reaches the desk adapter as an extension_ui_request; the adapter
// shows an approval card (#ask) or answers yes itself (#auto). A blocked call reaches the model as
// an error with the reason. At session start it sets a status the adapter waits for: without it the
// adapter starts no work, so a pi that failed to load this never runs tools unasked.
//
// Loaded by pi itself (not imported by the hub), so it imports nothing.

/** Tools that only read the workspace. */
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls']);

/** The confirm title the adapter recognizes as a desk approval: `agent-desk:<tool>`. */
export const TITLE_PREFIX = 'agent-desk:';

export default function deskApprovals(pi: any) {
  pi.on('session_start', async (_event: unknown, ctx: any) => {
    ctx.ui.setStatus('agent-desk', 'approvals');
  });
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (READ_ONLY.has(event.toolName)) return undefined;
    const ok = await ctx.ui.confirm(`${TITLE_PREFIX}${event.toolName}`, JSON.stringify(event.input ?? {}));
    return ok ? undefined : { block: true, reason: '데스크에서 거절했습니다' };
  });
}
