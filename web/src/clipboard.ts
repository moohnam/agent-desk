/** LAN HTTP and some embedded browsers need the synchronous clipboard fallback. */
export async function writeClipboardText(text: string, control: HTMLElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* Try the legacy path. */ }
  if (!control.isConnected) return false;
  const focused = document.activeElement;
  const selection = document.getSelection();
  const anchor = selection?.anchorNode, focus = selection?.focusNode;
  const anchorOffset = selection?.anchorOffset ?? 0, focusOffset = selection?.focusOffset ?? 0;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
  document.body.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    return document.execCommand('copy');
  } catch { return false; }
  finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection && anchor?.isConnected && focus?.isConnected) {
      try { selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset); } catch { /* Selection changed while copying. */ }
    }
  }
}
