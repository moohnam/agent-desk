export interface SharedWorkspaceView {
  id: string; name: string; url: string; workspace_id: string; pending: number; view_index: number;
}
export interface WorkspaceOperation {
  id: string; method: string; path: string; body: Record<string, unknown>;
}
export interface WorkspaceDelivery {
  id: string; method: string; path: string; status: number | null; error?: string; text?: string;
}
