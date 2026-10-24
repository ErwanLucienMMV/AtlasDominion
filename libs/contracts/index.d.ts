/** Phase 0 compile-time contracts; no Docker or HTTP implementation. */
export type InstanceId = string;
export type DesiredState = 'wanted_running' | 'wanted_stopped' | 'unknown';
export type DockerState = 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'missing' | 'unknown';
export type Readiness = 'ready' | 'not_ready' | 'unverified' | 'unknown';
export type OperationState = 'queued' | 'starting' | 'stopping' | 'completed' | 'failed' | 'timed_out';
export type Action = 'start' | 'stop';
export type ErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'UNKNOWN_INSTANCE' | 'MISSING_CONTAINER' |
  'IDENTITY_MISMATCH' | 'PORT_MISMATCH' | 'RESOURCE_EXHAUSTED' | 'OPERATION_CONFLICT' |
  'DOCKER_UNAVAILABLE' | 'TIMEOUT' | 'INVALID_REQUEST' | 'ADAPTER_UNAVAILABLE';

export interface ServerStatus {
  instanceId: InstanceId;
  displayName: string;
  gameType: string;
  desired: DesiredState;
  docker: DockerState;
  readiness: Readiness;
  observedAt: string;
  activeOperationId: string | null;
}
export interface Operation {
  operationId: string;
  instanceId: InstanceId;
  action: Action;
  state: OperationState;
  requestedAt: string;
  completedAt: string | null;
  result: 'already_running' | 'already_stopped' | 'changed' | null;
  error: ErrorCode | null;
}
/** Ephemeral authorization input only. Never persist/log these identifiers. */
export interface AuthorizationContext {
  guildId: string;
  userId: string;
  roleIds: readonly string[];
}
export interface OperationRequest {
  idempotencyKey: string;
  authorization: AuthorizationContext;
}
export interface Page<T> { items: readonly T[]; nextCursor: string | null }
export interface ApiError { code: ErrorCode; message: string }
export interface AuditEvent {
  timestamp: string;
  instanceId: InstanceId;
  operation: Action | 'unexpected_exit' | 'reconcile' | 'backup';
  outcome: 'accepted' | 'completed' | 'failed' | 'timed_out';
  error: ErrorCode | null;
}
