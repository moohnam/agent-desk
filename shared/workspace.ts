export interface SharedWorkspaceView {
  id: string; name: string; url: string; workspace_id: string; pending: number; view_index: number;
  legacy_project_ids?: string[]; legacy_task_ids?: string[];
  legacy_approval_ids?: string[]; legacy_question_ids?: string[];
  legacy_runner_ids?: string[];
  route_addresses?: string[];
}
export interface WorkspaceOperation {
  id: string; method: string; path: string; body: Record<string, unknown>;
}
export interface WorkspaceDelivery {
  id: string; method: string; path: string; status: number | null; error?: string; text?: string;
}
