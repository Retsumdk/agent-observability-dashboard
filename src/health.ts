import type { AgentStatus, HealthCheckResult, HealthRecord } from "./types.js";

export type HealthProbe = () => HealthCheckResult | Promise<HealthCheckResult>;

export interface HealthThresholds {
  /** Consecutive failed probes before an agent is marked down. */
  failAfter: number;
  /** Consecutive successful probes before a down agent recovers to healthy. */
  recoverAfter: number;
  /** Rolling latency average above which a healthy agent is degraded (ms). */
  degradedLatencyMs: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  failAfter: 3,
  recoverAfter: 2,
  degradedLatencyMs: 1500,
};

/**
 * Health monitor with hysteresis: an agent needs `failAfter` consecutive
 * failures to be marked down and `recoverAfter` consecutive successes to
 * come back, so single blips never flap the dashboard.
 */
export class HealthMonitor {
  private records = new Map<string, HealthRecord>();
  private thresholds: HealthThresholds;

  constructor(thresholds: Partial<HealthThresholds> = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** Record one probe outcome and return the recomputed status. */
  observe(result: HealthCheckResult): AgentStatus {
    let rec = this.records.get(result.agent);
    if (!rec) {
      rec = {
        agent: result.agent,
        status: "healthy",
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastCheck: result.latencyMs >= 0 ? Date.now() : Date.now(),
        latencyEwma: result.latencyMs,
      };
      this.records.set(result.agent, rec);
    }
    rec.lastCheck = Date.now();
    rec.lastDetail = result.detail;
    rec.latencyEwma = rec.latencyEwma * 0.7 + result.latencyMs * 0.3;

    if (result.ok) {
      rec.consecutiveFailures = 0;
      rec.consecutiveSuccesses += 1;
      if (rec.status === "down" && rec.consecutiveSuccesses >= this.thresholds.recoverAfter) {
        rec.status = "healthy";
      }
    } else {
      rec.consecutiveSuccesses = 0;
      rec.consecutiveFailures += 1;
      if (rec.consecutiveFailures >= this.thresholds.failAfter) {
        rec.status = "down";
      }
    }

    if (
      rec.status === "healthy" &&
      rec.latencyEwma > this.thresholds.degradedLatencyMs
    ) {
      rec.status = "degraded";
    } else if (rec.status === "degraded" && rec.latencyEwma <= this.thresholds.degradedLatencyMs && rec.consecutiveFailures === 0) {
      rec.status = "healthy";
    }

    return rec.status;
  }

  status(agent: string): AgentStatus | undefined {
    return this.records.get(agent)?.status;
  }

  /** Force a status without a probe — used when restoring from a snapshot. */
  force(agent: string, status: AgentStatus, consecutiveFailures = 0): void {
    const rec = this.records.get(agent) ?? {
      agent,
      status,
      consecutiveFailures,
      consecutiveSuccesses: 0,
      lastCheck: 0,
      latencyEwma: 0,
    };
    rec.status = status;
    rec.consecutiveFailures = consecutiveFailures;
    if (status === "healthy" || status === "degraded") rec.consecutiveSuccesses = Math.max(rec.consecutiveSuccesses, 1);
    this.records.set(agent, rec);
  }

  record(agent: string): HealthRecord | undefined {
    return this.records.get(agent);
  }

  all(): HealthRecord[] {
    return [...this.records.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  }

  async runProbe(agent: string, probe: HealthProbe): Promise<AgentStatus> {
    return this.observe(await probe());
  }
}
