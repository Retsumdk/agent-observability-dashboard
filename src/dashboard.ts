import { AlertManager } from "./alerts.js";
import { HealthMonitor } from "./health.js";
import { MetricsRegistry } from "./metrics.js";
import type { AgentSnapshot, DashboardSnapshot } from "./types.js";

export interface AgentDefinition {
  name: string;
  /** Probe returning ok=false to simulate failure; latency always recorded. */
  probe: () => { ok: boolean; latencyMs: number; detail?: string };
  /** Requests and errors observed this tick, fed into counters and rates. */
  traffic: () => { requests: number; errors: number };
}

export interface DashboardOptions {
  /** Rolling window (ticks) used for success/error rates. */
  rateWindow?: number;
}

/**
 * Dashboard = metrics registry + health monitor + alert manager, driven by
 * per-agent probe/traffic functions. `tick()` collects one observation round;
 * `render()` produces the ASCII board; `snapshot()` produces JSON.
 */
export class Dashboard {
  readonly registry: MetricsRegistry;
  readonly health: HealthMonitor;
  readonly alerts: AlertManager;
  private agents: AgentDefinition[];
  private tickCount = 0;
  private rateWindow: number;
  private requestWindow = new Map<string, number[]>();
  private errorWindow = new Map<string, number[]>();
  private lastLatency = new Map<string, number>();
  private lastSuccessRate = new Map<string, number>();
  private eventLog: string[] = [];

  constructor(agents: AgentDefinition[], alerts: AlertManager, options: DashboardOptions = {}) {
    this.agents = agents;
    this.alerts = alerts;
    this.registry = new MetricsRegistry();
    this.health = new HealthMonitor();
    this.rateWindow = options.rateWindow ?? 10;
  }

  tick(): DashboardSnapshot {
    this.tickCount += 1;
    for (const agent of this.agents) {
      const result = agent.probe();
      const traffic = agent.traffic();
      const ts = this.tickCount;

      const status = this.health.observe({
        agent: agent.name,
        ok: result.ok,
        latencyMs: result.latencyMs,
        detail: result.detail,
      });

      this.lastLatency.set(agent.name, result.latencyMs);
      this.registry.record(`${agent.name}.latency_ms`, result.latencyMs, ts);
      this.registry.increment(`${agent.name}.requests`, traffic.requests);
      this.registry.increment(`${agent.name}.errors`, traffic.errors);
      this.registry.record(`${agent.name}.error_rate`, traffic.requests > 0 ? traffic.errors / traffic.requests : 0, ts);

      const reqWin = this.requestWindow.get(agent.name) ?? [];
      const errWin = this.errorWindow.get(agent.name) ?? [];
      reqWin.push(traffic.requests);
      errWin.push(traffic.errors);
      if (reqWin.length > this.rateWindow) reqWin.shift();
      if (errWin.length > this.rateWindow) errWin.shift();
      this.requestWindow.set(agent.name, reqWin);
      this.errorWindow.set(agent.name, errWin);
      this.lastSuccessRate.set(agent.name, reqWin.length > 0 ? 1 - errWin.reduce((a, b) => a + b, 0) / reqWin.reduce((a, b) => a + b, 0) : 1);
    }

    const { fired, resolved } = this.alerts.evaluate(this.registry, this.tickCount);
    for (const a of fired) this.eventLog.push(`tick ${a.firedAt}  FIRED    [${a.severity}] ${a.summary}`);
    for (const a of resolved) this.eventLog.push(`tick ${a.resolvedAt}  RESOLVED [${a.severity}] ${a.id}: back to ${a.value}`);

    return this.snapshot();
  }

  snapshot(): DashboardSnapshot {
    const agents: AgentSnapshot[] = this.agents.map((agent) => {
      const requests = this.registry.counter(`${agent.name}.requests`);
      const errors = this.registry.counter(`${agent.name}.errors`);
      const reqWin = (this.requestWindow.get(agent.name) ?? []).reduce((a, b) => a + b, 0);
      const errWin = (this.errorWindow.get(agent.name) ?? []).reduce((a, b) => a + b, 0);
      const latency = this.registry.windowMean(`${agent.name}.latency_ms`, 3) ?? this.lastLatency.get(agent.name) ?? 0;
      return {
        agent: agent.name,
        status: this.health.status(agent.name) ?? "healthy",
        latencyMs: Math.round(latency),
        successRate: this.lastSuccessRate.get(agent.name) ?? (reqWin > 0 ? 1 - errWin / reqWin : 1),
        requests,
        errors,
        errorRate: requests > 0 ? errors / requests : 0,
        lastSeen: this.tickCount,
      };
    });

    return {
      ts: this.tickCount,
      tick: this.tickCount,
      agents: agents.sort((a, b) => a.agent.localeCompare(b.agent)),
      alerts: this.alerts.firing(),
      events: [...this.eventLog],
      totals: {
        agents: agents.length,
        healthy: agents.filter((a) => a.status === "healthy").length,
        degraded: agents.filter((a) => a.status === "degraded").length,
        down: agents.filter((a) => a.status === "down").length,
        firing: this.alerts.firing().length,
      },
    };
  }

  events(): string[] {
    return [...this.eventLog];
  }

  /** Alias of `events()` — the fire/resolve transition log. */
  alertTimeline(): string[] {
    return this.events();
  }

  /**
   * Rebuild a dashboard from an exported snapshot so an incident can be
   * re-rendered (or shipped to a teammate) without the live collectors.
   */
  static fromSnapshot(snap: DashboardSnapshot): Dashboard {
    const agents: AgentDefinition[] = snap.agents.map((a) => ({
      name: a.agent,
      probe: () => ({ ok: a.status !== "down", latencyMs: a.latencyMs }),
      traffic: () => ({ requests: 0, errors: 0 }),
    }));
    const dashboard = new Dashboard(agents, new AlertManager([]));
    dashboard.tickCount = snap.tick;
    for (const a of snap.agents) {
      dashboard.lastLatency.set(a.agent, a.latencyMs);
      dashboard.lastSuccessRate.set(a.agent, a.successRate);
      dashboard.registry.record(`${a.agent}.latency_ms`, a.latencyMs, a.lastSeen);
      dashboard.registry.increment(`${a.agent}.requests`, a.requests, a.lastSeen);
      dashboard.registry.increment(`${a.agent}.errors`, a.errors, a.lastSeen);
      dashboard.health.force(a.agent, a.status);
    }
    dashboard.alerts.restore(snap.alerts);
    dashboard.eventLog = [...(snap.events ?? [])];
    return dashboard;
  }

  render(snap: DashboardSnapshot = this.snapshot()): string {
    const statusGlyph = (s: string) => (s === "healthy" ? "OK  " : s === "degraded" ? "WARN" : "DOWN");
    const lines: string[] = [];
    const w = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

    lines.push(`╔═ AGENT OBSERVABILITY DASHBOARD — tick ${snap.tick} `);
    lines.push(`║ fleet: ${snap.totals.healthy} healthy · ${snap.totals.degraded} degraded · ${snap.totals.down} down · ${snap.totals.firing} alert(s) firing`);
    lines.push("╠═ agents");
    lines.push(`║ ${w("AGENT", 22)}${w("STATUS", 8)}${w("LAT(ms)", 9)}${w("SUCC%", 8)}${w("REQS", 8)}ERR%`);
    for (const a of snap.agents) {
      lines.push(
        `║ ${w(a.agent, 22)}${w(statusGlyph(a.status), 8)}${w(String(a.latencyMs), 9)}${w((a.successRate * 100).toFixed(1), 8)}${w(String(a.requests), 8)}${(a.errorRate * 100).toFixed(2)}`,
      );
    }
    const firing = snap.alerts;
    lines.push("╠═ FIRING ALERTS");
    if (firing.length === 0) lines.push("║ (none firing)");
    for (const a of firing) {
      lines.push(`║ [${a.severity.toUpperCase()}] ${a.id}: ${a.summary}`);
    }
    lines.push("╠═ event log");
    const recent = this.events().slice(-6);
    if (recent.length === 0) lines.push("║ (no transitions)");
    for (const e of recent) lines.push(`║ ${e}`);
    lines.push("╚" + "═".repeat(60));
    return lines.join("\n");
  }
}
