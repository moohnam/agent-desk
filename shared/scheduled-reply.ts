const withTags = /^\s*(?:#[a-z0-9][a-z0-9-]*\s+)*#later\s+\{/i;

export const hasScheduledReply = (text: string) => withTags.test(text);
export const scheduledReplyHint = '#later {시각}은 스레드 답글에서 예약으로 보내세요';
export const scheduledReplyPlainText = '예약할 메시지는 본문으로 작성해 주세요. 스킬·외부 조회·실행 설정 태그는 일반 답글에서 사용할 수 있습니다';

export function scheduledReplyInstant(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-/.test(value)) return NaN;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date.getTime() : NaN;
}

/** Resolve a typed schedule only on the authoring device. Servers receive the UTC instant. */
export function parseScheduledReply(text: string, now = Date.now()):
  { text: string; at: string; relativeMinutes?: number } | { error: string } | undefined {
  if (!hasScheduledReply(text)) return undefined;
  const input = /^\s*#later[^\S\r\n]+\{([^{}\r\n]*)\}(?=\s|$)([\s\S]*)$/i.exec(text);
  if (!input) return { error: '답글 맨 앞에 #later {YYYY-MM-DD HH:mm} 또는 #later {+2m}을 입력해 주세요' };
  const body = input[2].trim();
  if (!body) return { error: '예약할 메시지를 입력해 주세요' };
  const relative = /^\+([1-9]\d{0,5})m$/i.exec(input[1]);
  if (relative) {
    const minutes = Number(relative[1]);
    return { text: body, at: new Date(Math.ceil(now / 1000) * 1000 + minutes * 60_000).toISOString(), relativeMinutes: minutes };
  }
  const absolute = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2})(\.\d{3})?)?(Z)?$/.exec(input[1]);
  if (!absolute) return { error: '예약 시각은 YYYY-MM-DD HH:mm 또는 +2m 형식으로 입력해 주세요' };
  const [, year, month, day, hour, minute, second = '00', millis = '', utc = ''] = absolute;
  const inputTime = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  const date = new Date(inputTime + millis + utc);
  const actual = new Date(date.getTime() - (utc ? 0 : date.getTimezoneOffset() * 60_000));
  if (!Number.isFinite(actual.getTime()) || actual.toISOString().slice(0, 19) !== inputTime)
    return { error: '이 기기의 시간대에서 유효한 예약 시각을 입력해 주세요' };
  if (date.getTime() <= now) return { error: '현재보다 나중 시각으로 예약해 주세요' };
  return { text: body, at: date.toISOString() };
}

export function scheduledReplyDraft(at: string, text: string) {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = [String(date.getFullYear()).padStart(4, '0'), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
  const clock = [date.getHours(), date.getMinutes(), ...(date.getSeconds() ? [date.getSeconds()] : [])].map(pad).join(':');
  const wallTime = new Date(`${day}T${clock}`);
  const atDraft = wallTime.getTime() === date.getTime() ? `${day} ${clock}` : date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
  return `#later {${atDraft}} ${text}`;
}
