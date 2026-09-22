import { compare } from "./metrics.js";
import type { MetricsRegistry } from "./metrics.js";
import type { Alert, AlertRule } from "./types.js";

export interface AlertsRegistry {
  rules: AlertRule[];
}

/**
 * Threshold alerting over metric series. A rule fires after its condition
 * holds for `forTicks` consecutive evaluations and auto-resolves when the
 * condition clears. State transitions are returned so the dashboard can log
 * them as an event stream.
 */
export class AlertManager {
  private rules: AlertRule[];
  private strikes = new Map<string, number>();
  private active = new Map<string, Alert>();

  constructor(rules: AlertRule[]) {
    for (const r of rules) {
      if (!Number.isFinite(r.threshold)) {
        throw new Error(`rule ${r.id}: threshold must be finite`);
      }
      if (!Number.isInteger(r.forTicks) || r.forTicks < 1) {
        throw new Error(`rule ${r.id}: forTicks must be a positive integer`);
      }
    }
    this.rules = rules;
  }

  /**
   * Evaluate every rule against the registry's latest samples.
   * Returns the transitions that occurred this tick.
   */
  evaluate(registry: MetricsRegistry, ts: number): { fired: Alert[]; resolved: Alert[] } {
    const fired: Alert[] = [];
    const resolved: Alert[] = [];

    for (const rule of this.rules) {
      const sample = registry.latest(rule.series);
      if (!sample) continue; // no data yet — never fire on absence

      const conditionHolds = compare(sample.value, rule.comparator, rule.threshold);
      const strikes = (this.strikes.get(rule.id) ?? 0) + (conditionHolds ? 1 : 0);
      if (!conditionHolds) this.strikes.set(rule.id, 0);
      else this.strikes.set(rule.id, strikes);

      const alert = this.active.get(rule.id);
      if (!alert && strikes >= rule.forTicks) {
        const summary =
          `${rule.series} ${rule.comparator} ${rule.threshold} for ${strikes} tick(s): ` +
          `observed ${Number(sample.value.toFixed(4))}`;
        const newAlert: Alert = {
          id: rule.id,
          rule,
          state: "firing",
          severity: rule.severity,
          value: sample.value,
          firedAt: ts,
          summary,
        };
        this.active.set(rule.id, newAlert);
        fired.push(newAlert);
      } else if (alert && !conditionHolds) {
        alert.state = "resolved";
        alert.resolvedAt = ts;
        alert.value = sample.value;
        this.active.delete(rule.id);
        resolved.push(alert);
      } else if (alert) {
        alert.value = sample.value; // keep firing alert current
      }
    }

    return { fired, resolved };
  }

  firing(): Alert[] {
    return [...this.active.values()].sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id),
    );
  }

  /**
   * Re-attach firing alerts from an exported snapshot so a restored
   * dashboard keeps its active incident state.
   */
  restore(active: Alert[]): void {
    for (const a of active) {
      const rule = this.rules.find((r) => r.id === a.id) ?? a.rule;
      this.active.set(a.id, { ...a, rule, state: "firing" });
    }
  }

  ruleById(id: string): AlertRule | undefined {
    return this.rules.find((r) => r.id === id);
  }
}

export function severityRank(s: "info" | "warning" | "critical"): number {
  return s === "critical" ? 3 : s === "warning" ? 2 : 1;
}
