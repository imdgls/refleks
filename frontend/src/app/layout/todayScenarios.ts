import { useStore } from "@/shared/hooks";
import { getScenarioName } from "@/shared/lib";
import { useMemo } from "react";
import {
  lookupCategory,
  placementLabel,
  type ScenarioCategory,
} from "./scenarioCategories";

/**
 * Today's play, per scenario, gathered into aim categories.
 *
 * Time comes from each run's recorded duration, which has paused time taken
 * out of it, so this is time spent playing rather than time the scenario was
 * open.
 *
 * Scenarios whose category is unknown are not distributed, guessed at, or
 * quietly dropped - they are kept in their own group, and the share of the
 * day that did resolve is reported alongside. A breakdown covering half the
 * day looks exactly like a breakdown covering all of it unless it says so.
 */

export type ScenarioTime = {
  scenario: string;
  seconds: number;
  runs: number;
  /** Set only where the sources disagree: the placements they offered. */
  note: string | null;
};

export type SectionTone = "known" | "conflict" | "unknown";

export type BreakdownSection = {
  key: string;
  label: string;
  seconds: number;
  tone: SectionTone;
  scenarios: ScenarioTime[];
};

export type TodayBreakdown = {
  totalSeconds: number;
  /** Seconds that resolved to a single agreed category. */
  knownSeconds: number;
  runs: number;
  sections: BreakdownSection[];
};

const CONFLICT_KEY = "conflict";
const UNKNOWN_KEY = "unknown";

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function useTodayBreakdown(
  index: Map<string, ScenarioCategory>,
): TodayBreakdown {
  const sessions = useStore((state) => state.sessions);

  return useMemo(() => {
    const from = startOfToday();
    const perScenario = new Map<string, { seconds: number; runs: number }>();
    let totalSeconds = 0;
    let runs = 0;

    for (const session of sessions) {
      for (const item of session.items) {
        const played = Date.parse(String(item.stats?.summary.datePlayed ?? ""));
        if (!Number.isFinite(played) || played < from) continue;
        const seconds = Number(item.stats?.summary.duration ?? 0);
        if (!Number.isFinite(seconds) || seconds <= 0) continue;

        const name = getScenarioName(item);
        if (!name) continue;
        const entry = perScenario.get(name) ?? { seconds: 0, runs: 0 };
        entry.seconds += seconds;
        entry.runs += 1;
        perScenario.set(name, entry);
        totalSeconds += seconds;
        runs += 1;
      }
    }

    const sections = new Map<string, BreakdownSection>();
    let knownSeconds = 0;

    const section = (key: string, label: string, tone: SectionTone) => {
      let found = sections.get(key);
      if (!found) {
        found = { key, label, seconds: 0, tone, scenarios: [] };
        sections.set(key, found);
      }
      return found;
    };

    for (const [scenario, { seconds, runs: count }] of perScenario) {
      const category = lookupCategory(index, scenario);
      let target: BreakdownSection;
      let note: string | null = null;

      if (category.kind === "known") {
        const label = placementLabel(category.placement);
        target = section(label, label, "known");
        knownSeconds += seconds;
      } else if (category.kind === "conflict") {
        target = section(CONFLICT_KEY, "Category disputed", "conflict");
        note = category.candidates.map(placementLabel).join("  /  ");
      } else {
        target = section(UNKNOWN_KEY, "Unknown category", "unknown");
      }

      target.seconds += seconds;
      target.scenarios.push({ scenario, seconds, runs: count, note });
    }

    const ordered = [...sections.values()].sort((a, b) => {
      // The two "we do not know" groups always sit at the bottom, so a real
      // category is never read as competing with them for position.
      const rank = (s: BreakdownSection) =>
        s.tone === "known" ? 0 : s.tone === "conflict" ? 1 : 2;
      const byRank = rank(a) - rank(b);
      return byRank !== 0 ? byRank : b.seconds - a.seconds;
    });
    for (const s of ordered) {
      s.scenarios.sort((a, b) => b.seconds - a.seconds);
    }

    return { totalSeconds, knownSeconds, runs, sections: ordered };
  }, [sessions, index]);
}

export function formatMinutes(seconds: number): string {
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
