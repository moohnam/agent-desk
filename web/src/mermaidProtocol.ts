export const MAX_DIAGRAM_TEXT = 20_000;
export interface DiagramResult { image: string; background: string }
export interface DiagramReply { id: number; result?: DiagramResult; error?: string }
