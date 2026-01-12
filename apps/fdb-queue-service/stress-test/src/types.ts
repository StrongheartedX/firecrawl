// Operation types that match the API endpoints
export type OperationType =
  | 'push'
  | 'pop'
  | 'complete'
  | 'release'
  | 'activePush'
  | 'activeRemove'
  | 'activeCount'
  | 'teamQueueCount';

// Team configuration tiers
export interface TeamTier {
  name: string;
  concurrencyLimit: number;
  teamCount: number;
  jobsPerSecond: number;
}

// Active job tracking
export interface ActiveJob {
  jobId: string;
  queueKey: string;
  startTime: number;
  fromFDB?: boolean; // True if job came from FDB concurrency queue (promotion)
}

// Team simulation state
export interface TeamState {
  teamId: string;
  tier: TeamTier;
  activeJobs: Map<string, ActiveJob>;
  queuedJobs: number;
  completedJobs: number;
  lastPushTime: number;
  jobCounter: number;
}

// Percentile statistics
export interface PercentileStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

// Per-operation metrics using typed arrays for efficiency
export interface OperationMetrics {
  operationType: OperationType;
  latencies: Float64Array;
  count: number;
  successCount: number;
  errorCount: number;
  totalLatencyMs: number;
}

// Operation statistics in final report
export interface OperationStats {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  successRate: number;
  percentiles: PercentileStats;
}

// Error breakdown
export interface ErrorBreakdown {
  http4xx: number;
  http5xx: number;
  network: number;
  timeout: number;
  other: number;
}

// Detailed error sample for reporting
export interface ErrorSample {
  timestamp: number;
  operationType: OperationType;
  httpStatus?: number;
  errorMessage: string;
  responseBody?: string;
}

// Final report structure
export interface FinalReport {
  config: StressTestConfig;
  durationMs: number;
  actualOpsPerSecond: number;
  totalOperations: number;
  overallSuccessRate: number;
  operationStats: Record<OperationType, OperationStats>;
  errorBreakdown: ErrorBreakdown;
  tierStats: TierStats[];
}

// Per-tier statistics
export interface TierStats {
  tierName: string;
  teamCount: number;
  concurrencyLimit: number;
  totalJobsCompleted: number;
  avgJobTimeMs: number;
}

// Configuration
export interface StressTestConfig {
  serviceUrl: string;
  durationSeconds: number;
  teamTiers: TeamTier[];
  workerConcurrency: number;
  jobProcessingDelayMs: number;
  metricsBufferSize: number;
  reportIntervalSeconds: number;
  verbose: boolean;
  correctnessChecking: boolean;
}

// Job data structure matching the Rust service
export interface FDBQueueJob {
  id: string;
  data: unknown;
  priority: number;
  listenable: boolean;
  createdAt: number;
  timesOutAt?: number;
  listenChannelId?: string;
  crawlId?: string;
  teamId: string;
}

// Claimed job response from pop
export interface ClaimedJob {
  job: FDBQueueJob;
  queueKey: string;
}

// Push job request body
export interface PushJobRequest {
  teamId: string;
  job: {
    id: string;
    data: unknown;
    priority: number;
    listenable: boolean;
    listenChannelId?: string;
  };
  timeout?: number;
  crawlId?: string;
}

// Pop job request body
export interface PopJobRequest {
  workerId: string;
  blockedCrawlIds?: string[];
}

// Active job push request
export interface PushActiveJobRequest {
  teamId: string;
  jobId: string;
  timeout: number;
}

// Active job remove request
export interface RemoveActiveJobRequest {
  teamId: string;
  jobId: string;
}

// Complete job request
export interface CompleteJobRequest {
  queueKey: string;
}

// Release job request
export interface ReleaseJobRequest {
  jobId: string;
}

// === Correctness Checking Types ===

// Record of a pushed job for later validation
export interface PushedJobRecord {
  jobId: string;
  teamId: string;
  priority: number;
  crawlId?: string;
  dataTimestamp: number; // The timestamp inside job.data for validation
}

// State transitions for job lifecycle tracking
export type JobState = 'pushed' | 'claimed' | 'completed';

// Record of the current state of a job
export interface JobLifecycleRecord {
  jobId: string;
  state: JobState;
  pushedRecord: PushedJobRecord;
  claimTimestamp?: number;
  completeTimestamp?: number;
}

// Types of correctness violations
export type ViolationType =
  | 'duplicate_claim'     // Same job claimed twice
  | 'orphan_claim'        // Claimed a job that was never pushed
  | 'wrong_team'          // Job popped by different team than it was pushed for
  | 'priority_mismatch'   // Priority in claimed job != priority pushed
  | 'data_corruption'     // Data payload doesn't match expected structure
  | 'crawl_id_mismatch'   // CrawlId changed between push and pop
  | 'lost_job'            // Pushed but never claimed or completed by end
  | 'incomplete_job';     // Claimed but never completed by end

// Individual correctness violation record
export interface CorrectnessViolation {
  type: ViolationType;
  timestamp: number;
  jobId: string;
  teamId?: string;
  details: string;
  expected?: unknown;
  actual?: unknown;
}

// Summary statistics for correctness checking
export interface CorrectnessSummary {
  totalPushed: number;
  totalClaimed: number;
  totalCompleted: number;
  violationCounts: Record<ViolationType, number>;
  totalViolations: number;
  isPassing: boolean;
}
