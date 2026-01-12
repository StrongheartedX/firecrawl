import type { StressTestConfig, TeamTier } from './types.js';

// Default tier distribution (5000 teams total)
export const DEFAULT_TIERS: TeamTier[] = [
  { name: 'micro',      concurrencyLimit: 2,   teamCount: 1500, jobsPerSecond: 0.5 },
  { name: 'small',      concurrencyLimit: 5,   teamCount: 1500, jobsPerSecond: 1.0 },
  { name: 'medium',     concurrencyLimit: 50,  teamCount: 1000, jobsPerSecond: 5.0 },
  { name: 'large',      concurrencyLimit: 100, teamCount: 600,  jobsPerSecond: 10.0 },
  { name: 'xlarge',     concurrencyLimit: 200, teamCount: 300,  jobsPerSecond: 15.0 },
  { name: 'enterprise', concurrencyLimit: 500, teamCount: 100,  jobsPerSecond: 25.0 },
];

export const DEFAULT_CONFIG: StressTestConfig = {
  serviceUrl: 'http://localhost:3100',
  durationSeconds: 300,
  teamTiers: DEFAULT_TIERS,
  workerConcurrency: 500,
  jobProcessingDelayMs: 3500, // Realistic p50 job processing time
  metricsBufferSize: 100_000, // Reduced from 1M to save memory
  reportIntervalSeconds: 10,
  verbose: false,
  correctnessChecking: true,
};

function printUsage(): void {
  console.log(`
FDB Queue Service Stress Test

Usage: tsx src/index.ts [options]

Options:
  --url <url>           FDB Queue Service URL (default: http://localhost:3100)
  --duration <seconds>  Test duration in seconds (default: 300)
  --workers <count>     Concurrent HTTP workers (default: 500)
  --job-delay <ms>      Simulated job processing delay (default: 100)
  --buffer-size <n>     Metrics buffer size per operation (default: 100000)
  --report-interval <s> Live report interval in seconds (default: 10)
  --verbose             Enable verbose logging
  --correctness         Enable correctness checking (default: enabled)
  --no-correctness      Disable correctness checking
  --help                Show this help message

Team Tier Options (use to scale team counts):
  --scale <factor>      Scale all team counts by factor (default: 1.0)
                        e.g., --scale 0.1 for 500 teams instead of 5000

Examples:
  # Quick 60-second test with 500 teams
  npx tsx src/index.ts --duration 60 --scale 0.1

  # Full stress test with 5000 teams for 5 minutes
  npx tsx src/index.ts --duration 300

  # High concurrency test (increase heap for large tests)
  NODE_OPTIONS="--max-old-space-size=4096" npx tsx src/index.ts --workers 1000 --duration 300
`);
}

export function parseArgs(args: string[]): StressTestConfig | null {
  const config = { ...DEFAULT_CONFIG, teamTiers: [...DEFAULT_TIERS] };
  let scale = 1.0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--help':
      case '-h':
        printUsage();
        return null;

      case '--url':
        if (!next) {
          console.error('Error: --url requires a value');
          return null;
        }
        config.serviceUrl = next;
        i++;
        break;

      case '--duration':
        if (!next || isNaN(parseInt(next))) {
          console.error('Error: --duration requires a number');
          return null;
        }
        config.durationSeconds = parseInt(next);
        i++;
        break;

      case '--workers':
        if (!next || isNaN(parseInt(next))) {
          console.error('Error: --workers requires a number');
          return null;
        }
        config.workerConcurrency = parseInt(next);
        i++;
        break;

      case '--job-delay':
        if (!next || isNaN(parseInt(next))) {
          console.error('Error: --job-delay requires a number');
          return null;
        }
        config.jobProcessingDelayMs = parseInt(next);
        i++;
        break;

      case '--buffer-size':
        if (!next || isNaN(parseInt(next))) {
          console.error('Error: --buffer-size requires a number');
          return null;
        }
        config.metricsBufferSize = parseInt(next);
        i++;
        break;

      case '--report-interval':
        if (!next || isNaN(parseInt(next))) {
          console.error('Error: --report-interval requires a number');
          return null;
        }
        config.reportIntervalSeconds = parseInt(next);
        i++;
        break;

      case '--scale':
        if (!next || isNaN(parseFloat(next))) {
          console.error('Error: --scale requires a number');
          return null;
        }
        scale = parseFloat(next);
        i++;
        break;

      case '--verbose':
        config.verbose = true;
        break;

      case '--correctness':
        config.correctnessChecking = true;
        break;

      case '--no-correctness':
        config.correctnessChecking = false;
        break;

      default:
        if (arg.startsWith('-')) {
          console.error(`Error: Unknown option: ${arg}`);
          printUsage();
          return null;
        }
    }
  }

  // Apply scale factor to team counts
  if (scale !== 1.0) {
    config.teamTiers = config.teamTiers.map(tier => ({
      ...tier,
      teamCount: Math.max(1, Math.round(tier.teamCount * scale)),
    }));
  }

  return config;
}

export function getTotalTeams(config: StressTestConfig): number {
  return config.teamTiers.reduce((sum, tier) => sum + tier.teamCount, 0);
}

export function getExpectedOpsPerSecond(config: StressTestConfig): number {
  // Each job involves: push, pop, activePush, activeRemove, complete = 5 ops
  // Plus occasional count queries
  const opsPerJob = 5.5;
  const totalJobsPerSecond = config.teamTiers.reduce(
    (sum, tier) => sum + tier.teamCount * tier.jobsPerSecond,
    0
  );
  return Math.round(totalJobsPerSecond * opsPerJob);
}
