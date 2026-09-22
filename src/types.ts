export type AgentStatus = "healthy" | "degraded" | "down";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertState = "firing" | "resolved";
export type Comparator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export interface MetricSample {
  ts: number;
  value: number;
}

export interface TimeSeries {
  name: string;
  samples: MetricSample[];
  maxSamples: number;
}

export interface HistogramStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface HealthCheckResult {
  agent: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface HealthRecord {
  agent: string;
  status: AgentStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastCheck: number;
  lastDetail?: string;
  latencyEwma: number;
}

export interface AlertRule {
  id: string;
  series: string;
  comparator: Comparator;
  threshold: number;
  severity: AlertSeverity;
  /** Consecutive evaluations the condition must hold before firing. */
  forTicks: number;
  description?: string;
}

export interface Alert {
  id: string;
  rule: AlertRule;
  state: AlertState;
  severity: AlertSeverity;
  value: number;
  firedAt: number;
  resolvedAt?: number;
  summary: string;
}

export interface AgentSnapshot {
  agent: string;
  status: AgentStatus;
  latencyMs: number;
  successRate: number;
  requests: number;
  errors: number;
  errorRate: number;
  lastSeen: number;
}

export interface DashboardSnapshot {
  ts: number;
  tick: number;
  agents: AgentSnapshot[];
  alerts: Alert[];
  totals: {
    agents: number;
    healthy: number;
    degraded: number;
    down: number;
    firing: number;
  };
  /** Alert state-transition log (FIRED/RESOLVED lines), oldest first. */
  events?: string[];
}

/** Convenience alias used by the CLI and consumers when exporting/importing state. */
export type Snapshot = DashboardSnapshot;
