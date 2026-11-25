export interface SharedWorkspaceView {
  id: string; name: string; url: string; workspace_id: string; pending: number; view_index: number;
  publicKey?: string;
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
export interface WorkspaceRemoval {
  id: string; taskId?: string; projectId?: string; status: number | null; error?: string;
}

export interface SshPeerView {
  peerId:string; ownerId:string; ownerName:string; fingerprint:string; name:string; publicKey:string; admin:boolean; revoked:boolean;
}

export interface SshConnectRequest {
  id: string; name: string; ownerName: string; fingerprint: string; created_at: string;
}
export interface WorkspaceConnectRequest extends SshConnectRequest {
  linkId: string; workspaceName: string;
}
export interface OutgoingConnectRequest {
  id: string; name: string; status: 'pending' | 'approved' | 'rejected' | 'expired' | 'connected'; expires: number;
}
