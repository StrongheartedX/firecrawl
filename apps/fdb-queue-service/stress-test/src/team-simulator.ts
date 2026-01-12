import type { TeamState, TeamTier, ActiveJob, StressTestConfig, TierStats } from './types.js';
import type { FDBQueueClient } from './http-client.js';
import type { CorrectnessChecker } from './correctness-checker.js';

export class TeamSimulator {
  private teams: Map<string, TeamState> = new Map();
  private tierTeams: Map<string, TeamState[]> = new Map();
  private config: StressTestConfig;
  private jobTimeout: number = 600_000; // 10 minutes
  private correctnessChecker?: CorrectnessChecker;
  private runId: string;

  constructor(config: StressTestConfig, correctnessChecker?: CorrectnessChecker) {
    this.config = config;
    this.correctnessChecker = correctnessChecker;
    // Unique run ID to prevent job ID collisions with previous test runs
    this.runId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.initializeTeams();
  }

  private initializeTeams(): void {
    let teamIndex = 0;

    for (const tier of this.config.teamTiers) {
      const tierTeamList: TeamState[] = [];

      for (let i = 0; i < tier.teamCount; i++) {
        const teamId = `stress-team-${teamIndex.toString().padStart(6, '0')}`;
        const state: TeamState = {
          teamId,
          tier,
          activeJobs: new Map(),
          queuedJobs: 0,
          completedJobs: 0,
          lastPushTime: 0,
          jobCounter: 0,
        };

        this.teams.set(teamId, state);
        tierTeamList.push(state);
        teamIndex++;
      }

      this.tierTeams.set(tier.name, tierTeamList);
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

  // Determine if a team should push a new job based on its rate
  shouldPushJob(team: TeamState, now: number): boolean {
    // Calculate interval between jobs based on rate
    const intervalMs = 1000 / team.tier.jobsPerSecond;
    const timeSinceLastPush = now - team.lastPushTime;

    // Add some randomization to avoid thundering herd
    const jitter = (Math.random() - 0.5) * intervalMs * 0.2;

    return timeSinceLastPush >= intervalMs + jitter;
  }

  // Check if team has capacity for more active jobs
  hasCapacity(team: TeamState): boolean {
    return team.activeJobs.size < team.tier.concurrencyLimit;
  }

  // Generate a new job ID for a team (includes runId for uniqueness across test runs)
  generateJobId(team: TeamState): string {
    team.jobCounter++;
    return `${team.teamId}-${this.runId}-job-${team.jobCounter}`;
  }

  // Maybe generate a crawl ID (20% chance, includes runId for uniqueness)
  maybeGenerateCrawlId(team: TeamState): string | undefined {
    if (Math.random() < 0.2) {
      return `${team.teamId}-${this.runId}-crawl-${Math.floor(team.jobCounter / 10)}`;
    }
    return undefined;
  }

  // Generate a random priority (1-100, lower = higher priority)
  generatePriority(): number {
    return Math.floor(Math.random() * 100) + 1;
  }

  // Push a job for a team
  async pushJob(client: FDBQueueClient, team: TeamState, now: number): Promise<boolean> {
    const jobId = this.generateJobId(team);
    const priority = this.generatePriority();
    const crawlId = this.maybeGenerateCrawlId(team);

    const success = await client.pushJob(
      team.teamId,
      jobId,
      priority,
      this.jobTimeout,
      crawlId,
    );

    if (success) {
      team.queuedJobs++;
      team.lastPushTime = now;
    }

    return success;
  }

  // Pop a job for a team
  async popJob(client: FDBQueueClient, team: TeamState, now: number): Promise<ActiveJob | null> {
    const claimed = await client.popJob(team.teamId);

    if (claimed && claimed.job && claimed.queueKey) {
      const activeJob: ActiveJob = {
        jobId: claimed.job.id,
        queueKey: claimed.queueKey,
        startTime: now,
      };

      team.activeJobs.set(claimed.job.id, activeJob);
      team.queuedJobs = Math.max(0, team.queuedJobs - 1);

      // Mark as active in FDB
      await client.pushActiveJob(team.teamId, claimed.job.id, this.jobTimeout);

      return activeJob;
    }

    return null;
  }

  // Complete a job for a team
  async completeJob(
    client: FDBQueueClient,
    team: TeamState,
    activeJob: ActiveJob,
  ): Promise<boolean> {
    // Remove from active tracking first
    await client.removeActiveJob(team.teamId, activeJob.jobId);

    // Complete the job
    const success = await client.completeJob(activeJob.queueKey);

    if (success) {
      team.activeJobs.delete(activeJob.jobId);
      team.completedJobs++;

      // Record completion for correctness tracking
      this.correctnessChecker?.recordComplete(activeJob.jobId);
    }

    return success;
  }

  // Get jobs that are ready to be completed (processing delay elapsed)
  getCompletableJobs(team: TeamState, now: number): ActiveJob[] {
    const completable: ActiveJob[] = [];

    for (const [, job] of team.activeJobs) {
      if (now - job.startTime >= this.config.jobProcessingDelayMs) {
        completable.push(job);
      }
    }

    return completable;
  }

  // Get tier statistics for the final report
  getTierStats(): TierStats[] {
    const stats: TierStats[] = [];

    for (const tier of this.config.teamTiers) {
      const teams = this.tierTeams.get(tier.name) ?? [];
      let totalCompleted = 0;
      let totalJobTimeMs = 0;
      let jobCount = 0;

      for (const team of teams) {
        totalCompleted += team.completedJobs;

        // Calculate average job time from current active jobs
        // (In a real scenario, we'd track this more precisely)
        const now = Date.now();
        for (const [, job] of team.activeJobs) {
          totalJobTimeMs += now - job.startTime;
          jobCount++;
        }
      }

      stats.push({
        tierName: tier.name,
        teamCount: tier.teamCount,
        concurrencyLimit: tier.concurrencyLimit,
        totalJobsCompleted: totalCompleted,
        avgJobTimeMs: jobCount > 0 ? totalJobTimeMs / jobCount : this.config.jobProcessingDelayMs,
      });
    }

    return stats;
  }

  // Get a random subset of teams for load distribution
  getRandomTeamSubset(count: number): TeamState[] {
    const allTeams = Array.from(this.teams.values());
    const subset: TeamState[] = [];

    // Fisher-Yates shuffle for first `count` elements
    for (let i = 0; i < Math.min(count, allTeams.length); i++) {
      const j = i + Math.floor(Math.random() * (allTeams.length - i));
      [allTeams[i], allTeams[j]] = [allTeams[j], allTeams[i]];
      subset.push(allTeams[i]);
    }

    return subset;
  }
}
