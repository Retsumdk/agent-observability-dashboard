# agent-observability-dashboard

Real-time dashboard for agent metrics, health monitoring, and alerting.

A dependency-light TypeScript library + CLI that watches a fleet of agents,
tracks their latency and error rates in bounded in-memory time series, derives
health status with hysteresis (no flapping on single blips), and fires
threshold alerts that persist until the metric genuinely recovers. It renders
an ASCII operations board, exports its state as JSON, and re-renders a
snapshot later — so an incident can be replayed, archived, or shipped to a
teammate without the live collectors.

## The problem

When you run more than a couple of autonomous agents, failures are quiet:
latency creeps up, error rates drift, an agent flaps between up and down, and
nobody notices until a downstream workflow stalls. Pulling in a full metrics
stack (Prometheus + Grafana + alertmanager) to watch a handful of agents is
disproportionate — and most logging libraries give you raw events but no
verdict.

## The solution

`agent-observability-dashboard` answers three questions in one process:

1. **Is each agent up?** — probe outcomes feed a health monitor with
   hysteresis: an agent goes `down` only after N consecutive failures and
   comes back only after M consecutive successes.
2. **How is it performing?** — every tick records latency, request and error
   counters, and error rates into bounded ring buffers with percentile
   histograms (`p50` / `p95` / `p99`) and sparklines.
3. **Is anything on fire?** — threshold rules fire only after the condition
   holds for `forTicks` consecutive evaluations and auto-resolve when the
   metric clears, producing a fire/resolve event timeline.

Unlike a hosted metrics stack there is nothing to deploy, and unlike a logger
it emits decisions (status + alert state), not just observations.

## How it works

```
AgentDefinition[]          AlertRule[]
 (probe + traffic fns)      (series + comparator + threshold + forTicks)
        │                            │
        ▼                            ▼
  ┌─────────────┐   samples   ┌──────────────────┐
  │  Dashboard  │────────────▶│  MetricsRegistry │  ring buffers, histograms
  │  .tick()    │             └──────────────────┘
  │             │   probes    ┌──────────────────┐
  │             │────────────▶│  HealthMonitor   │  hysteresis: healthy /
  │             │             └──────────────────┘  degraded / down
  │             │   gauges    ┌──────────────────┐
  │             │────────────▶│  AlertManager    │  fire / resolve + timeline
  └─────────────┘             └──────────────────┘
        │
        ├── .render()    → ASCII operations board
        ├── .snapshot()  → JSON (agents, alerts, event log)
        └── Dashboard.fromSnapshot(json) → replayable dashboard
```

## Getting started

```bash
git clone https://github.com/Retsumdk/agent-observability-dashboard.git
cd agent-observability-dashboard
bun install
```

### Run the demo

```bash
bun run src/index.ts --demo
```

Expected output (deterministic — the seeded simulation always produces this
incident):

```
╔═ AGENT OBSERVABILITY DASHBOARD — tick 15
║ fleet: 2 healthy · 0 degraded · 1 down · 1 alert(s) firing
╠═ agents
║ AGENT                 STATUS  LAT(ms)  SUCC%   REQS    ERR%
║ checkout-worker       DOWN    2367     39.7    1800    40.50
║ mail-sender           OK      46       99.8    4164    0.24
║ orders-api            OK      118      99.9    6940    0.14
╠═ FIRING ALERTS
║ [CRITICAL] checkout-errors: checkout-worker.error_rate gt 0.2 for 2 tick(s): observed 0.8417
╠═ event log
║ tick 10  FIRED    [critical] checkout-worker.error_rate gt 0.2 for 2 tick(s): observed 0.8417
╚════════════════════════════════════════════════════════════
```

The CLI exits non-zero when an alert is `critical` or an agent is `down`, so
the same command doubles as a CI health gate.

### Export and replay a snapshot

```bash
bun run src/index.ts --demo --json > metrics.json
bun run src/index.ts --snapshot metrics.json   # re-renders the identical board
```

### Other CLI options

```bash
bun run src/index.ts --help
#   --demo            Run the deterministic incident simulation
#   --ticks, -t N     Number of simulation ticks (default 15)
#   --snapshot, -s F  Render a dashboard from an exported snapshot JSON file
#   --json            Emit machine-readable JSON instead of the ASCII dashboard
```

## Usage as a library

```ts
import { Dashboard } from "./src/dashboard.js";
import { AlertManager } from "./src/alerts.js";
import type { AgentDefinition, AlertRule } from "./src/index.js";

const agents: AgentDefinition[] = [
  {
    name: "checkout-worker",
    probe: () => ({ ok: true, latencyMs: 210 }),
    traffic: () => ({ requests: 120, errors: 2 }),
  },
];

const rules: AlertRule[] = [
  {
    id: "checkout-latency",
    series: "checkout-worker.latency_ms",
    comparator: "gt",
    threshold: 800,
    severity: "warning",
    forTicks: 3,
  },
];

const dashboard = new Dashboard(agents, new AlertManager(rules));
dashboard.tick();                                  // one collection round
console.log(dashboard.snapshot().totals);          // { agents: 1, healthy: 1, ... }
console.log(dashboard.render());                   // ASCII board
```

Run the test suite and the type-checked build with:

```bash
bun test        # 23 tests / 60 assertions
bun run build   # tsc → dist/
```

## API overview

| Export | Purpose |
|--------|---------|
| `Dashboard` | Composes the three subsystems; `tick()`, `render()`, `snapshot()`, `events()`, `alertTimeline()`, static `fromSnapshot()` |
| `MetricsRegistry` | Ring-buffered series, counters with per-tick `rate()`, gauges, histograms (`p50/p95/p99`), `sparkline()` |
| `HealthMonitor` | Hysteresis health states from probe outcomes; configurable `failAfter`, `recoverAfter`, `degradedLatencyMs` |
| `AlertManager` | Threshold rules with `forTicks` persistence; returns `{ fired, resolved }` transitions each evaluation |
| `simulateFleet(ticks)` | Deterministic three-agent incident used by the demo and tests |
| `percentile`, `mean`, `compare` | Statistic and comparator helpers |

All types (`AgentStatus`, `AlertSeverity`, `AlertRule`, `DashboardSnapshot`, …)
are exported from `src/types.js`.

## Configuration

Health thresholds and the rolling rate window are tuned via constructor
options — for example:

```ts
import { Dashboard } from "./src/dashboard.js";
import { HealthMonitor } from "./src/health.js";

const dashboard = new Dashboard(agents, new AlertManager(rules), { rateWindow: 20 });
dashboard.health; // HealthMonitor — replace or configure via Dashboard internals
```

The `HealthMonitor` accepts `{ failAfter, recoverAfter, degradedLatencyMs }`
(defaults: 3, 2, 1500 ms); a single failed probe never takes an agent down.

## License

MIT License

---

Built by [Retsumdk](https://github.com/Retsumdk)
