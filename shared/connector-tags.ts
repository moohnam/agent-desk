import { unified } from 'unified';
import { Tokenizer, TokenizerMode } from 'parse5';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

export const CONNECTOR_SCOPES = ['slack', 'jira', 'confluence'] as const;
export type ConnectorScope = typeof CONNECTOR_SCOPES[number];
const labels: Record<ConnectorScope, string> = { slack: 'Slack', jira: 'Jira', confluence: 'Confluence' };
const parser=unified().use(remarkParse).use(remarkGfm,{singleTilde:false}).use(remarkMath);
const excluded=new Set(['blockquote','code','inlineCode','html','link','linkReference','definition','image','imageReference','math','inlineMath','delete']);
type Node={type:string;children?:Node[];position?:{start:{offset?:number};end:{offset?:number}}};

// A generated diff may follow unfinished Markdown in a draft. Its literal extent
// must be independent of how that earlier Markdown parses.
function diffQuoteRanges(text: string) {
  const ranges:{start:number;end:number}[]=[];
  let opening:{start:number;fence:string}|undefined;
  for(const match of text.matchAll(/^(`{3,})(diff)?[ \t]*\r?$/gm)){
    if(opening){
      if(!match[2] && match[1]===opening.fence){
        ranges.push({start:opening.start,end:match.index+match[0].length});
        opening=undefined;
      }
    }else if(match[2])opening={start:match.index,fence:match[1]};
  }
  return ranges;
}

/** Preserve offsets while preventing Desk controls in literal code from being interpreted. */
export function maskCodeBlocks(text: string): string {
  if (!text.includes('`') && !text.includes('~~~') && !/^(?: {4}|\t)/m.test(text)) return text;
  // Keep character positions stable for tags outside the quoted ranges.
  for(const {start,end} of diffQuoteRanges(text).reverse())
    text=text.slice(0,start)+'\0'.repeat(end-start)+text.slice(end);
  let result='',offset=0;
  const visit=(node: Node)=>{
    if ((node.type==='code'||node.type==='inlineCode') && node.position) {
      const start=node.position.start.offset,end=node.position.end.offset;
      if(start!==undefined && end!==undefined){
        result+=text.slice(offset,start)+'\0'.repeat(end-start);
        offset=end;
      }
    } else node.children?.forEach(visit);
  };
  visit(parser.parse(text));
  return result+text.slice(offset);
}

/** Use the same Markdown grammar as the renderer; only literal body text grants access. */
export function connectorTags(text: string): { scopes: ConnectorScope[]; body: string } {
  if (!/#(?:slack|jira|confluence)\b/i.test(text)) return {scopes:[],body:text};
  const scopes:ConnectorScope[]=[],edits:{start:number;end:number;scope:ConnectorScope}[]=[];
  type Range={start:number;end:number};
  const spans:Range[]=[],ignored:Range[]=diffQuoteRanges(text),htmlSpans:Range[]=[],html:{tag:string;start:number}[]=[];
  const visit=(node:Node)=>{
    const start=node.position?.start.offset,end=node.position?.end.offset;
    if(start===undefined||end===undefined)return;
    if(node.type==='html')htmlSpans.push({start,end});
    if(excluded.has(node.type)){ignored.push({start,end});return;}
    if(node.type==='text')spans.push({start,end});
    else for(const child of node.children??[])visit(child);
  };
  visit(parser.parse(text));
  // One tokenizer preserves raw-text state across Markdown HTML nodes.
  let htmlSource='',htmlOffset=0;
  for(const range of htmlSpans){htmlSource+=' '.repeat(range.start-htmlOffset)+text.slice(range.start,range.end);htmlOffset=range.end;}
  const noop=()=>{};
  const tokenizer=new Tokenizer({sourceCodeLocationInfo:true},{
    onComment:noop,onDoctype:noop,onEof:noop,onCharacter:noop,onNullCharacter:noop,onWhitespaceCharacter:noop,
    onStartTag:tag=>{
      if(tag.location&&!['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'].includes(tag.tagName))
        html.push({tag:tag.tagName,start:tag.location.startOffset});
      if(tag.tagName==='script')tokenizer.state=TokenizerMode.SCRIPT_DATA;
      else if(['style','xmp','iframe','noembed','noframes'].includes(tag.tagName))tokenizer.state=TokenizerMode.RAWTEXT;
      else if(['title','textarea'].includes(tag.tagName))tokenizer.state=TokenizerMode.RCDATA;
    },
    onEndTag:tag=>{
      const index=html.findLastIndex(open=>open.tag===tag.tagName);
      if(index>=0&&tag.location){ignored.push({start:html[index].start,end:tag.location.endOffset});html.splice(index);}
    },
  });
  tokenizer.write(htmlSource,true);
  for(const open of html)ignored.push({start:open.start,end:text.length});
  const merged:Range[]=[];
  for(const range of ignored.sort((a,b)=>a.start-b.start)) {
    const last=merged.at(-1);
    if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});
  }
  // Ignore punctuation inside code/HTML when finding ordinary quoted examples.
  let masked='',offset=0;
  for(const range of merged){masked+=text.slice(offset,range.start)+' '.repeat(range.end-range.start);offset=range.end;}
  masked+=text.slice(offset);
  const quotes=[...masked.matchAll(/(?:^|[\s([{])(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\]|'(?=\p{L}))*(?:'|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$))/gu)]
    .map(match=>({start:match.index,end:match.index+match[0].length}));
  for(const span of spans) {
    for(const match of text.slice(span.start,span.end).matchAll(/(^|\s)#(slack|jira|confluence)(?=\s|$)/gi)) {
      const at=span.start+match.index+match[1].length,scope=match[2].toLowerCase() as ConnectorScope;
      if(merged.some(range=>at>=range.start&&at<range.end)||quotes.some(range=>at>=range.start&&at<range.end))continue;
      if(!scopes.includes(scope))scopes.push(scope);
      edits.push({start:at,end:at+match[2].length+1,scope});
    }
  }
  let body=text;
  for(const edit of edits.reverse())body=body.slice(0,edit.start)+labels[edit.scope]+body.slice(edit.end);
  return {scopes,body};
}

/** Only the user's own input field, never quoted posts, answers, files or generated summaries. */
export function connectorInputScopes(method: string, path: string, body: Record<string, unknown>): ConnectorScope[] {
  if (method !== 'POST' || !/^(?:\/(?:compose|tasks)|\/(?:tasks|channels)\/[^/]+\/messages)$/.test(path.split('?')[0])) return [];
  const text = typeof body.text === 'string' ? body.text : typeof body.prompt === 'string' ? body.prompt : '';
  return connectorTags(text).scopes;
}
