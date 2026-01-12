import { parseArgs } from './config.js';
import { MetricsCollector } from './metrics.js';
import { FDBQueueClient } from './http-client.js';
import { CorrectnessChecker } from './correctness-checker.js';
import {
  printHeader,
  printLiveStats,
  printFinalReport,
  printCorrectnessReport,
  printError,
  printProgress,
} from './reporter.js';
import type { TeamState, ActiveJob } from './types.js';

// Simple semaphore for concurrency control
class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>(resolve => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }

  get available(): number {
    return this.permits;
  }

  get pending(): number {
    return this.waiting.length;
  }
}

// Simulated main queue job
interface MainQueueJob {
  jobId: string;
  teamId: string;
  priority: number;
  createdAt: number;
  crawlId?: string;
}

// Production-like simulator that models main queue + concurrency queue
class ProductionSimulator {
  private teams: Map<string, TeamState> = new Map();
  private mainQueue: MainQueueJob[] = []; // Simulated main queue (in-memory)
  private jobTimeout = 600_000;
  private correctnessChecker?: CorrectnessChecker;
  private runId: string;
  private config: typeof import('./config.js').DEFAULT_CONFIG;
  private jobCounter = 0;

  constructor(
    config: typeof import('./config.js').DEFAULT_CONFIG,
    correctnessChecker?: CorrectnessChecker
  ) {
    this.config = config;
    this.correctnessChecker = correctnessChecker;
    this.runId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.initializeTeams();
  }

  private initializeTeams(): void {
    let teamIndex = 0;
    for (const tier of this.config.teamTiers) {
      for (let i = 0; i < tier.teamCount; i++) {
        const teamId = `stress-team-${teamIndex.toString().padStart(6, '0')}`;
        const state: TeamState = {
          teamId,
          tier,
          activeJobs: new Map(),
          queuedJobs: 0, // Jobs in FDB concurrency queue
          completedJobs: 0,
          lastPushTime: 0,
          jobCounter: 0,
        };
        this.teams.set(teamId, state);
        teamIndex++;
      }
    }
  }

  getTeams(): Map<string, TeamState> {
    return this.teams;
  }

  getTotalTeams(): number {
    return this.teams.size;
  }

  getTotalActiveJobs(): number {
    let total = 0;
    for (const team of this.teams.values()) {
      total += team.activeJobs.size;
    }
    return total;
  }

  getTotalCompletedJobs(): number {
    let total = 0;
    for (const team of this.teams.values()) {
      total += team.completedJobs;
    }
    return total;
  }

  getMainQueueSize(): number {
    return this.mainQueue.length;
  }

  // Generate jobs and add to main queue (simulating upstream job creation)
  generateJobs(now: number): void {
    for (const team of this.teams.values()) {
      // Check if it's time to generate a job for this team
      const intervalMs = 1000 / team.tier.jobsPerSecond;
      const timeSinceLastPush = now - team.lastPushTime;
      const jitter = (Math.random() - 0.5) * intervalMs * 0.2;

      if (timeSinceLastPush >= intervalMs + jitter) {
        this.jobCounter++;
        team.jobCounter++;
        const jobId = `${team.teamId}-${this.runId}-job-${team.jobCounter}`;
        const crawlId = Math.random() < 0.2
          ? `${team.teamId}-${this.runId}-crawl-${Math.floor(team.jobCounter / 10)}`
          : undefined;

        this.mainQueue.push({
          jobId,
          teamId: team.teamId,
          priority: Math.floor(Math.random() * 100) + 1,
          createdAt: now,
          crawlId,
        });

        team.lastPushTime = now;
        // Note: We don't record push here - only overflow jobs that actually
        // go to FDB concurrency queue get recorded
      }
    }
  }

  // Worker picks a job from main queue
  // Returns the highest priority job, regardless of team capacity
  // Caller must check capacity and handle overflow to FDB
  pickJobFromMainQueue(): MainQueueJob | null {
    if (this.mainQueue.length === 0) return null;

    // Find highest priority job (lower number = higher priority)
    let bestIdx = 0;
    let bestPriority = this.mainQueue[0].priority;

    for (let i = 1; i < this.mainQueue.length; i++) {
      if (this.mainQueue[i].priority < bestPriority) {
        bestPriority = this.mainQueue[i].priority;
        bestIdx = i;
      }
    }

    // Remove and return
    const job = this.mainQueue[bestIdx];
    this.mainQueue.splice(bestIdx, 1);
    return job;
  }

  // Start processing a job (add to active)
  startJob(job: MainQueueJob, now: number, fromFDB: boolean = false): ActiveJob {
    const team = this.teams.get(job.teamId)!;
    const activeJob: ActiveJob = {
      jobId: job.jobId,
      queueKey: '', // Will be set if this was from FDB
      startTime: now,
      fromFDB, // Track if this job came from FDB concurrency queue
    };
    team.activeJobs.set(job.jobId, activeJob);
    return activeJob;
  }

  // Check if team is at concurrency limit
  isTeamAtCapacity(teamId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) return true;
    return team.activeJobs.size >= team.tier.concurrencyLimit;
  }

  // Push job to FDB concurrency queue (when team is at capacity)
  async pushToConcurrencyQueue(
    client: FDBQueueClient,
    job: MainQueueJob
  ): Promise<boolean> {
    const team = this.teams.get(job.teamId);
    if (!team) return false;

    const success = await client.pushJob(
      job.teamId,
      job.jobId,
      job.priority,
      this.jobTimeout,
      job.crawlId
    );

    if (success) {
      team.queuedJobs++;
    }

    return success;
  }

  // Complete a job and check for promotion from concurrency queue
  async completeJob(
    client: FDBQueueClient,
    teamId: string,
    activeJob: ActiveJob
  ): Promise<MainQueueJob | null> {
    const team = this.teams.get(teamId);
    if (!team) return null;

    // Remove from active
    team.activeJobs.delete(activeJob.jobId);
    team.completedJobs++;

    // Only record completion for jobs that came from FDB concurrency queue
    // Main queue jobs never interact with FDB so shouldn't be tracked
    if (activeJob.fromFDB) {
      this.correctnessChecker?.recordComplete(activeJob.jobId);
    }

    // If there was an FDB queue key, complete it
    if (activeJob.queueKey) {
      await client.completeJob(activeJob.queueKey);
    }

    // Check if team has jobs waiting in concurrency queue
    if (team.queuedJobs > 0) {
      // Try to pop from FDB concurrency queue
      const claimed = await client.popJob(teamId);
      if (claimed && claimed.job) {
        team.queuedJobs--;

        // Record the claim
        this.correctnessChecker?.recordClaim(claimed, teamId);

        // Return as a main queue job to be processed
        return {
          jobId: claimed.job.id,
          teamId: teamId,
          priority: claimed.job.priority,
          createdAt: claimed.job.created_at,
          crawlId: claimed.job.crawl_id,
        };
      }
    }

    return null;
  }

  // Get jobs that are ready to complete (processing delay elapsed)
  getCompletableJobs(team: TeamState, now: number): ActiveJob[] {
    const completable: ActiveJob[] = [];
    for (const [, job] of team.activeJobs) {
      if (now - job.startTime >= this.config.jobProcessingDelayMs) {
        completable.push(job);
      }
    }
    return completable;
  }

  // Get tier stats for reporting
  getTierStats() {
    const tierMap = new Map<string, { teams: TeamState[]; tier: typeof this.config.teamTiers[0] }>();

    for (const team of this.teams.values()) {
      const existing = tierMap.get(team.tier.name);
      if (existing) {
        existing.teams.push(team);
      } else {
        tierMap.set(team.tier.name, { teams: [team], tier: team.tier });
      }
    }

    return Array.from(tierMap.values()).map(({ teams, tier }) => {
      let totalCompleted = 0;
      let totalJobTimeMs = 0;
      let jobCount = 0;

      for (const team of teams) {
        totalCompleted += team.completedJobs;
        const now = Date.now();
        for (const [, job] of team.activeJobs) {
          totalJobTimeMs += now - job.startTime;
          jobCount++;
        }
      }

      return {
        tierName: tier.name,
        teamCount: tier.teamCount,
        concurrencyLimit: tier.concurrencyLimit,
        totalJobsCompleted: totalCompleted,
        avgJobTimeMs: jobCount > 0 ? totalJobTimeMs / jobCount : this.config.jobProcessingDelayMs,
      };
    });
  }
}

async function runSimulation(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  if (!config) {
    process.exit(0);
  }

  const correctnessChecker = config.correctnessChecking
    ? new CorrectnessChecker()
    : undefined;

  const metrics = new MetricsCollector(config.metricsBufferSize);
  const client = new FDBQueueClient({
    baseUrl: config.serviceUrl,
    metrics,
    verbose: config.verbose,
    correctnessChecker,
  });
  const simulator = new ProductionSimulator(config, correctnessChecker);
  const semaphore = new Semaphore(config.workerConcurrency);

  printHeader(config);

  // Health check
  printProgress('Checking FDB Queue Service health...');
  const healthy = await client.healthCheck();
  if (!healthy) {
    printError(`Cannot connect to FDB Queue Service at ${config.serviceUrl}`);
    process.exit(1);
  }
  printProgress('Service is healthy.');
  console.log('');

  // Set up graceful shutdown
  let running = true;
  const shutdown = () => {
    if (running) {
      running = false;
      console.log('\nShutting down gracefully...');
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  metrics.start();
  const startTime = Date.now();
  const endTime = startTime + config.durationSeconds * 1000;

  const reportInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.floor((now - startTime) / 1000);
    const progress = ((now - startTime) / (config.durationSeconds * 1000) * 100).toFixed(1);

    console.log(`\n=== FDB Queue Service Stress Test (Production Model) ===`);
    console.log(`Elapsed: ${elapsed}s / ${config.durationSeconds}s (${progress}%)`);
    console.log(`Main Queue: ${simulator.getMainQueueSize()} jobs`);
    console.log(`Active Jobs: ${simulator.getTotalActiveJobs()}`);
    console.log(`Completed: ${simulator.getTotalCompletedJobs()}`);
    console.log(`\nFDB Operations (concurrency queue only):`);

    const stats = metrics.getAllOperationStats();
    for (const [op, opStats] of Object.entries(stats)) {
      if (opStats.totalRequests > 0) {
        console.log(`  ${op}: ${opStats.totalRequests} reqs, ${(opStats.successRate * 100).toFixed(1)}% success, p50=${opStats.percentiles.p50.toFixed(0)}ms`);
      }
    }
  }, config.reportIntervalSeconds * 1000);

  printProgress('Starting stress test (production model)...');
  console.log('');

  let inFlight = 0;

  const runTask = async (task: () => Promise<void>): Promise<void> => {
    await semaphore.acquire();
    inFlight++;
    try {
      await task();
    } finally {
      inFlight--;
      semaphore.release();
    }
  };

  // Track jobs that need to be pushed to FDB (overflow)
  const overflowQueue: MainQueueJob[] = [];

  while (running && Date.now() < endTime) {
    const now = Date.now();

    // 1. Generate new jobs into main queue
    simulator.generateJobs(now);

    // 2. Process overflow - push to FDB concurrency queue
    while (overflowQueue.length > 0) {
      const job = overflowQueue.shift()!;
      runTask(async () => {
        await simulator.pushToConcurrencyQueue(client, job);
      });
    }

    // 3. Workers pick jobs from main queue
    // Limit how many we start per iteration to avoid overwhelming
    for (let i = 0; i < 100 && semaphore.available > 0; i++) {
      const job = simulator.pickJobFromMainQueue();
      if (!job) break;

      const team = simulator.getTeams().get(job.teamId)!;

      // Check if team is at capacity - if so, overflow to FDB
      if (simulator.isTeamAtCapacity(job.teamId)) {
        overflowQueue.push(job);
        continue;
      }

      // Start processing the job
      const activeJob = simulator.startJob(job, now);

      // Track active job in FDB (optional, for monitoring)
      runTask(async () => {
        await client.pushActiveJob(job.teamId, job.jobId, 600_000);
      });
    }

    // 4. Complete ready jobs and check for promotions
    for (const team of simulator.getTeams().values()) {
      const completable = simulator.getCompletableJobs(team, now);

      for (const activeJob of completable) {
        runTask(async () => {
          // Remove from active tracking
          await client.removeActiveJob(team.teamId, activeJob.jobId);

          // Complete and check for promotion
          const promoted = await simulator.completeJob(client, team.teamId, activeJob);

          if (promoted) {
            // A job was promoted from FDB - start processing it
            const newActive = simulator.startJob(promoted, Date.now(), true /* fromFDB */);

            // Track active
            await client.pushActiveJob(promoted.teamId, promoted.jobId, 600_000);
          }
        });
      }
    }

    // Yield periodically
    await new Promise(resolve => setImmediate(resolve));

    // Throttle if saturated
    if (semaphore.available === 0 && semaphore.pending > 1000) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  clearInterval(reportInterval);

  // Wait for in-flight
  printProgress(`Waiting for ${inFlight} pending operations...`);
  while (inFlight > 0) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Drain phase - allow all active jobs to complete
  // With 3.5s job delay, we need enough time to drain all active jobs
  const drainTimeout = config.jobProcessingDelayMs * 3 + 30_000; // 3x job delay + buffer
  const drainStart = Date.now();
  let lastActiveCount = simulator.getTotalActiveJobs();
  let lastReportTime = drainStart;

  printProgress(`Draining ${lastActiveCount} active jobs (timeout: ${Math.round(drainTimeout / 1000)}s)...`);

  while (Date.now() - drainStart < drainTimeout) {
    const now = Date.now();

    // Complete ready jobs
    for (const team of simulator.getTeams().values()) {
      const completable = simulator.getCompletableJobs(team, now);
      for (const activeJob of completable) {
        runTask(async () => {
          await client.removeActiveJob(team.teamId, activeJob.jobId);
          await simulator.completeJob(client, team.teamId, activeJob);
        });
      }
    }

    // Wait for in-flight operations
    while (inFlight > 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const activeCount = simulator.getTotalActiveJobs();

    // Report progress every 5 seconds
    if (now - lastReportTime >= 5000) {
      printProgress(`Draining: ${activeCount} active jobs remaining...`);
      lastReportTime = now;
    }

    // Check if done
    if (activeCount === 0) {
      printProgress('Drain complete - all jobs finished.');
      break;
    }

    // Check for stall (no progress in 10 seconds)
    if (activeCount === lastActiveCount && now - lastReportTime >= 10000) {
      printProgress(`Warning: Drain stalled at ${activeCount} active jobs`);
    }
    lastActiveCount = activeCount;

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (simulator.getTotalActiveJobs() > 0) {
    printProgress(`Drain timeout - ${simulator.getTotalActiveJobs()} jobs still active`);
  }

  // Print final report
  console.log('\n' + '='.repeat(70));
  console.log('  FDB Queue Service Stress Test - Final Report (Production Model)');
  console.log('='.repeat(70));
  console.log(`\nCompleted Jobs: ${simulator.getTotalCompletedJobs()}`);
  console.log(`Remaining in Main Queue: ${simulator.getMainQueueSize()}`);
  console.log(`Remaining Active: ${simulator.getTotalActiveJobs()}`);

  const finalStats = metrics.getAllOperationStats();
  console.log('\nFDB Operations (concurrency queue):');
  for (const [op, opStats] of Object.entries(finalStats)) {
    if (opStats.totalRequests > 0) {
      console.log(`  ${op}: ${opStats.totalRequests} requests, ${(opStats.successRate * 100).toFixed(1)}% success`);
      console.log(`    p50=${opStats.percentiles.p50.toFixed(0)}ms, p95=${opStats.percentiles.p95.toFixed(0)}ms, p99=${opStats.percentiles.p99.toFixed(0)}ms`);
    }
  }

  console.log('\nTier Summary:');
  for (const tier of simulator.getTierStats()) {
    console.log(`  ${tier.tierName}: ${tier.totalJobsCompleted} completed`);
  }

  // Show errors if any
  const totalErrors = metrics.getTotalErrors();
  if (totalErrors > 0) {
    console.log('\n' + '='.repeat(70));
    console.log('  ERRORS');
    console.log('='.repeat(70));

    const errorBreakdown = metrics.getErrorBreakdown();
    console.log('\nError Breakdown:');
    if (errorBreakdown.http4xx > 0) console.log(`  HTTP 4xx: ${errorBreakdown.http4xx}`);
    if (errorBreakdown.http5xx > 0) console.log(`  HTTP 5xx: ${errorBreakdown.http5xx}`);
    if (errorBreakdown.network > 0) console.log(`  Network:  ${errorBreakdown.network}`);
    if (errorBreakdown.timeout > 0) console.log(`  Timeout:  ${errorBreakdown.timeout}`);
    if (errorBreakdown.other > 0) console.log(`  Other:    ${errorBreakdown.other}`);

    const recentErrors = metrics.getRecentErrors(10);
    if (recentErrors.length > 0) {
      console.log('\nRecent Errors (last 10):');
      console.log('-'.repeat(70));
      for (const err of recentErrors) {
        const time = new Date(err.timestamp).toISOString().split('T')[1].replace('Z', '');
        console.log(`  [${time}] ${err.operationType}: ${err.errorMessage}`);
        if (err.httpStatus) console.log(`    Status: ${err.httpStatus}`);
        if (err.responseBody) console.log(`    Body: ${err.responseBody.substring(0, 100)}`);
      }
      console.log('-'.repeat(70));
    }
  }

  if (correctnessChecker) {
    printProgress('Running correctness verification...');
    correctnessChecker.runEndOfTestVerification();
    printCorrectnessReport(correctnessChecker);
  }
}

runSimulation().catch((error) => {
  printError('Fatal error', error);
  process.exit(1);
});
