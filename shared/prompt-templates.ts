export interface PromptTemplate { id: string; name: string; text: string }
export interface PromptTemplates { revision: string; items: PromptTemplate[] }
/** The quote is appended verbatim; template text never substitutes inside source code. */
export function codePrompt(text: string, quote: string): string {
  return text.trim() ? `${text.trim()}\n\n${quote}` : quote;
}
