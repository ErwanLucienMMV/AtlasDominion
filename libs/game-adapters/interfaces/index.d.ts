import type { DockerState, Readiness, InstanceId } from '../../contracts/index.js';

/** Constructed only after registry, identity, port and authorization checks. */
export interface ApprovedContainer {
  inspect(): Promise<{ state: DockerState; health: 'healthy' | 'unhealthy' | 'starting' | null }>;
  start(): Promise<void>;
  stop(timeoutSeconds: number): Promise<void>;
}
export interface AdapterContext {
  instanceId: InstanceId;
  container: ApprovedContainer;
  signal: AbortSignal;
}
/** No raw Docker client, exec, image pull, filesystem path or provisioning capability. */
export interface LifecycleAdapter {
  readonly id: string;
  start(context: AdapterContext): Promise<void>;
  stop(context: AdapterContext, timeoutSeconds: number): Promise<void>;
}
export interface ReadinessAdapter {
  readonly id: string;
  probe(context: AdapterContext): Promise<Readiness>;
}
/** Opaque references resolved by the worker's separate administrator-approved configuration. */
export interface BackupContext {
  instanceId: InstanceId;
  sourceRef: string;
  destinationRef: string;
  signal: AbortSignal;
}
export interface BackupArtifact { artifactId: string; createdAt: string; verified: boolean }
export interface BackupAdapter {
  readonly id: string;
  backup(context: BackupContext): Promise<BackupArtifact>;
  verify(context: BackupContext, artifactId: string): Promise<boolean>;
}
