/**
 * The key pressed as on a US layout, for shortcuts: a letter key under another input source (ㅏ on
 * a Korean one, or an IME's 'Process') counts as its Latin letter (k), uppercase with Shift.
 */
export function latinKey(e: KeyboardEvent): string {
  const m = /^Key([A-Z])$/.exec(e.code);
  if (!m || /^[a-zA-Z]$/.test(e.key)) return e.key;
  return e.shiftKey ? m[1] : m[1].toLowerCase();
}
