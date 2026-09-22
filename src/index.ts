#!/usr/bin/env bun
/**
 * agent-observability-dashboard CLI
 *
 * Two ways to run:
 *   --demo        Replay a deterministic 15-tick incident against a simulated
 *                 agent fleet (checkout degrades and crashes, orders recover).
 *   --snapshot F  Render a dashboard from a previously exported JSON snapshot.
 *
 * Every mode prints an ASCII dashboard plus the alert timeline; --json swaps
 * the ASCII rendering for the machine-readable snapshot.
 */

import { readFileSync } from "fs";
import { Dashboard } from "./dashboard.js";
import { simulateFleet } from "./simulate.js";
import type { Snapshot } from "./types.js";

function parseArgs(argv: string[]): { demo: boolean; ticks: number; json: boolean; snapshot?: string } {
  const opts = { demo: false, ticks: 15, json: false, snapshot: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--demo") opts.demo = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--ticks" || a === "-t") opts.ticks = Number(argv[++i]);
    else if (a === "--snapshot" || a === "-s") opts.snapshot = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(`agent-observability-dashboard

Usage:
  bun run src/index.ts --demo [--ticks N] [--json]
  bun run src/index.ts --snapshot metrics.json [--json]

Options:
  --demo            Run the deterministic incident simulation
  --ticks, -t N     Number of simulation ticks (default 15)
  --snapshot, -s F  Render a dashboard from an exported snapshot JSON file
  --json            Emit machine-readable JSON instead of the ASCII dashboard
  --help, -h        Show this help`);
      process.exit(0);
    }
  }
  return opts;
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));

  let dashboard: Dashboard;
  if (opts.snapshot) {
    const raw = JSON.parse(readFileSync(opts.snapshot, "utf-8")) as Snapshot;
    dashboard = Dashboard.fromSnapshot(raw);
  } else {
    dashboard = simulateFleet(Math.max(1, opts.ticks));
  }

  const snapshot = dashboard.snapshot();

  if (opts.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    console.log(dashboard.render());
    if (!opts.snapshot) {
      console.log(`\nExport this state:  bun run src/index.ts --demo --json > metrics.json`);
      console.log(`Re-render it later: bun run src/index.ts --snapshot metrics.json`);
    }
  }

  const critical = snapshot.alerts.filter((a) => a.state === "firing" && a.severity === "critical").length;
  const down = Object.values(snapshot.agents).filter((s) => s.status === "down").length;
  return critical > 0 || down > 0 ? 1 : 0;
}

process.exit(main());
