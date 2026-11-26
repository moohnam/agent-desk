import { api } from './api.ts';

/** Local document links share the thread's reading pane; other files retain the OS opener. */
export const DOCUMENT_OPEN = 'desk-document-open';
/** Keep the originating task when a browser copies a link or opens it in another tab. */
export function documentHref(taskId:string,href:string) {
  return '/?'+new URLSearchParams({documentTask:taskId,documentPath:href});
}
export function documentPath(href:string,base?:string) {
  return !base||/^[a-z][a-z\d+.-]*:/i.test(href)||/^[~\/]/.test(href)
    ? href : base.replace(/[^/]*$/,'')+href;
}
export function isDocumentLink(href:string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href)) return false;
  try {return /\.(md|markdown|html?)(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/i.test(decodeURIComponent(href));}
  catch{return false;}
}

/** Match alternate spellings that do not need the runner's filesystem to resolve. */
export function documentLinkKey(href: string) {
  try {
    const url = /^file:/i.test(href) ? new URL(href) : undefined;
    if (url?.hostname && url.hostname !== 'localhost') return `link:${href}`;
    const path = decodeURIComponent(url ? url.pathname : href)
      .replace(/#L\d+(-L?\d+)?$/, '').replace(/:\d+(:\d+)?(-\d+)?$/, '');
    if (!path || /[\x00-\x1f\\?#]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) return `link:${href}`;
    return `path:${path.startsWith('/') ? '/' : ''}${path.split('/').filter(part => part && part !== '.').join('/')}`;
  } catch { return `link:${href}`; }
}
export function previewLink(taskId:string,href:string):boolean {
  if(!isDocumentLink(href))return false;
  window.dispatchEvent(new CustomEvent(DOCUMENT_OPEN,{detail:{taskId,href}}));return true;
}

/** Opens a local link from a post through the hub. A hub without the route still hands app URLs to the browser. */
export const openLink = (taskId: string, onError?: (msg: string) => void) => (href: string) =>
  previewLink(taskId,href) ? Promise.resolve() : api.open(href, taskId).catch((e: Error) => {
    if (e.message.startsWith('no route') && /^(akb|lectern):/i.test(href)) window.location.href = href;
    else onError?.(e.message);
  });
