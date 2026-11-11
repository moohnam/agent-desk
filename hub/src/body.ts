import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.ts';

/** Largest request body the hub reads; a skill file or a long prompt fits well within it. */
export const MAX_BODY = 2 * 1024 * 1024;

/**
 * Whether a request may come from where it says: no Origin (curl, MCP clients), or the page the
 * hub itself served (its origin names the same host:port the request was sent to). A page on
 * another site gets 403 even though the browser sends it to a hub on this machine.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === (req.headers.host ?? '').toLowerCase(); }
  catch { return false; }
}

/**
 * Reads a JSON body of at most MAX_BODY bytes. JSON only: a form on another site can't post one
 * without a CORS preflight, which the hub never answers.
 */
export async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  const declared = Number(req.headers['content-length']);
  if (declared > limit) throw new HttpError(413, `요청 본문이 너무 큽니다 (최대 ${limit / 1024 / 1024} MiB)`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, `요청 본문이 너무 큽니다 (최대 ${limit / 1024 / 1024} MiB)`);
    }
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return undefined;
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON 본문만 받습니다');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid JSON body'); }
}
