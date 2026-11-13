/** Local document links share the thread's reading pane; other files retain the OS opener. */
export const DOCUMENT_OPEN = 'desk-document-open';
export function isDocumentLink(href:string) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^file:/i.test(href)) return false;
  try {return /\.(md|markdown|html?)(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?$/i.test(decodeURIComponent(href));}
  catch{return false;}
}
export function previewLink(taskId:string,href:string):boolean {
  if(!isDocumentLink(href))return false;
  window.dispatchEvent(new CustomEvent(DOCUMENT_OPEN,{detail:{taskId,href}}));return true;
}
