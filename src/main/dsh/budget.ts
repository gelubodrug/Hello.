/**
 * What the DSH host may use, and what it is using.
 *
 * The host is a whole second harness: dsh's web server, its plugin loader,
 * about twenty infrastructure plugins and whatever plugins the person
 * installed, in one Electron utility process. Hello is a chat app with a
 * browser in it, so that process cannot be allowed to grow until the Mac
 * swaps. Two things hold it:
 *
 * - a heap ceiling, given to the process itself at start
 *   (`--max-old-space-size`), so V8 collects instead of climbing, and a
 *   runaway plugin fails inside the host rather than taking the app with it;
 * - a watch on what it actually uses, sampled from Electron's own process
 *   metrics, which writes a line to the DSH log the first time the host passes
 *   its budget and again if it comes back under. Nothing is killed: a surface
 *   the person is working in is not something to close behind their back, and
 *   the log is where the host's own account of itself already is.
 *
 * The numbers are a budget, not a measurement of dsh: they are what Hello is
 * willing to spend on it. Re-check them on a dsh upgrade (ARCHITECTURE,
 * Upgrading dsh), because what a profile loads at boot is dsh's business.
 */
export interface DshBudget {
  /** V8 heap ceiling for the host process, in MB. */
  heapMb: number;
  /** Resident set the host may hold before Hello says so, in MB. */
  memoryMb: number;
  /** Share of one core the host may hold, sustained, before Hello says so. */
  cpuPercent: number;
  /** How long it has to be over before it counts, in ms: a boot or an install is a spike. */
  sustainedMs: number;
}

/**
 * Measured on this Mac while the surface was open and idle, 0.1.7-rc.2: the
 * host settles around 300–400 MB. Twice that is room for plugins; a profile
 * that needs more than 1 GB is a profile to look at, not to accommodate
 * silently. The CPU share is about a busy core and a half, which a plugin that
 * polls will exceed and an install will not reach for 30 s.
 */
export const DSH_BUDGET: DshBudget = { heapMb: 1024, memoryMb: 1024, cpuPercent: 150, sustainedMs: 30_000 };

/** The execArgv the host is started with: Hello's internals flag plus the heap ceiling. */
export function hostExecArgv(budget: DshBudget = DSH_BUDGET): string[] {
  return ['--expose-internals', `--max-old-space-size=${budget.heapMb}`];
}

/** One row of Electron's `app.getAppMetrics()`, as much of it as this needs. */
export interface ProcessMetric {
  pid: number;
  memory?: { workingSetSize?: number; privateBytes?: number };
  cpu?: { percentCPUUsage?: number };
}

export interface HostUsage {
  memoryMb: number;
  cpuPercent: number;
}

/** What the process with this pid is using, or undefined when the metrics do not name it. */
export function hostUsage(metrics: readonly ProcessMetric[], pid: number | undefined): HostUsage | undefined {
  if (pid === undefined) return undefined;
  const row = metrics.find(metric => metric.pid === pid);
  if (!row) return undefined;
  // Electron reports memory in kilobytes.
  const kilobytes = row.memory?.workingSetSize ?? row.memory?.privateBytes ?? 0;
  return { memoryMb: Math.round(kilobytes / 1024), cpuPercent: Math.round(row.cpu?.percentCPUUsage ?? 0) };
}

/** Whether a sample is past the budget, and in which words. */
export function overBudget(usage: HostUsage, budget: DshBudget = DSH_BUDGET): string | undefined {
  const reasons: string[] = [];
  if (usage.memoryMb > budget.memoryMb) reasons.push(`${usage.memoryMb} MB of memory (budget ${budget.memoryMb} MB)`);
  if (usage.cpuPercent > budget.cpuPercent) reasons.push(`${usage.cpuPercent}% of a core (budget ${budget.cpuPercent}%)`);
  return reasons.length ? reasons.join(' and ') : undefined;
}

export interface BudgetWatchOptions {
  /** The host's pid, read on each sample: undefined once it is gone. */
  pid(): number | undefined;
  metrics(): readonly ProcessMetric[];
  log(line: string): void;
  budget?: DshBudget;
  intervalMs?: number;
  now?(): number;
  setInterval?(handler: () => void, ms: number): { unref?(): void };
  clearInterval?(timer: unknown): void;
}

/** Samples every ten seconds: often enough to catch a climb, rare enough to cost nothing. */
export const SAMPLE_MS = 10_000;

/**
 * Watches one host's usage and says so in the log when it stays over budget —
 * once on the way over, once on the way back. `stop()` ends it; a pid that is
 * gone ends the breach quietly, because an exited host is not over budget.
 */
export function watchHostUsage(options: BudgetWatchOptions): { stop(): void; sample(): HostUsage | undefined } {
  const budget = options.budget ?? DSH_BUDGET;
  const now = options.now ?? Date.now;
  const start = options.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const stopTimer = options.clearInterval ?? ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>));
  let since: number | undefined;
  let said = false;
  const sample = (): HostUsage | undefined => {
    const usage = hostUsage(options.metrics(), options.pid());
    if (!usage) { since = undefined; said = false; return undefined; }
    const reason = overBudget(usage, budget);
    if (!reason) {
      if (said) options.log(`The DSH host is back inside its budget (${usage.memoryMb} MB, ${usage.cpuPercent}% of a core).`);
      since = undefined;
      said = false;
      return usage;
    }
    since ??= now();
    if (!said && now() - since >= budget.sustainedMs) {
      said = true;
      options.log(`The DSH host has been over its budget for ${Math.round((now() - since) / 1000)}s: ${reason}. Close the DSH surface, or remove a plugin, if the app feels slow.`);
    }
    return usage;
  };
  const timer = start(sample, options.intervalMs ?? SAMPLE_MS);
  timer.unref?.();
  return { stop: () => stopTimer(timer), sample };
}
