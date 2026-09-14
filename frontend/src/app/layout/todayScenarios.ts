import { useStore } from "@/shared/hooks";
import { getScenarioName } from "@/shared/lib";
import type { Session } from "@/shared/types";
import { useMemo } from "react";
import {
  lookupCategory,
  placementLabel,
  type ScenarioCategory,
} from "./scenarioCategories";
import { useSessionTimers, type SessionTimers } from "./sessionTimers";

/**
 * Today's play, per scenario, gathered into aim categories.
 *
 * Time comes from two places, and which one is in use is reported rather than
 * hidden. KovaaK's runs an on-screen clock per scenario that counts the time
 * actually spent in it - restarts and abandoned attempts included - and that
 * clock is read back out of each replay. Where it is available it is the
 * truth, and it is materially larger than what the stats files describe: on
 * one measured block of thirteen runs it read 18:05 against the 12:52 the
 * finished runs account for.
 *
 * Where it is not available the finished runs are summed instead, which is
 * the old behaviour and an undercount. The two are never blended silently:
 * the breakdown says how many of the day's blocks were measured.
 *
 * A block is a stretch of consecutive runs of one scenario, because that is
 * exactly the span the clock covers - it resets whenever the scenario
 * changes, including on returning to one played earlier the same day.
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
  /**
   * Wall clock covered by the day's sessions, summed. Not the same as the
   * distance from the first run to the last: two sessions with a three-hour
   * break between them cover their own spans, not the break.
   */
  sessionSeconds: number;
  /** How many sessions contributed runs today. */
  sessions: number;
  totalSeconds: number;
  /** Seconds that resolved to a single agreed category. */
  knownSeconds: number;
  runs: number;
  sections: BreakdownSection[];
  /** Stretches of one scenario, and how many had their clock read. */
  blocks: number;
  measuredBlocks: number;
  /** Why the unmeasured blocks were unmeasured, most common first. */
  failureReasons: string[];
};

const CONFLICT_KEY = "conflict";
const UNKNOWN_KEY = "unknown";

type TodayRun = {
  fileName: string;
  scenario: string;
  seconds: number;
  playedAt: number;
};

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A session's wall clock, clipped to today.
 *
 * Sessions run past midnight, so a session is worth only the part of it that
 * falls on this side of it. Where the recorded bounds are unusable the run
 * timestamps stand in, and an unfinished session is measured to now rather
 * than to whatever its end field happens to say.
 */
function sessionSecondsToday(
  session: Session,
  dayStart: number,
  now: number,
): number {
  const dayEnd = Math.min(dayStart + 86_400_000, now);

  let start = Date.parse(session.start);
  let end = Date.parse(session.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    const stamps = session.items
      .map((item) => Date.parse(String(item.stats?.summary.datePlayed ?? "")))
      .filter((ts) => Number.isFinite(ts));
    if (stamps.length === 0) return 0;
    start = Math.min(...stamps);
    end = Math.max(...stamps);
  }
  end = Math.min(end, now);

  const from = Math.max(start, dayStart);
  const to = Math.min(end, dayEnd);
  return to > from ? (to - from) / 1000 : 0;
}

export function useTodayBreakdown(
  index: Map<string, ScenarioCategory>,
): TodayBreakdown {
  const sessions = useStore((state) => state.sessions);
  const timers = useSessionTimers();
  return useMemo(
    () =>
      buildTodayBreakdown(sessions, index, timers, startOfToday(), Date.now()),
    [sessions, index, timers],
  );
}

/** The hook's body, with the clock passed in so it can be checked. */
export function buildTodayBreakdown(
  sessions: Session[],
  index: Map<string, ScenarioCategory>,
  timers: SessionTimers,
  from: number,
  now: number,
): TodayBreakdown {
  const today: TodayRun[] = [];
  let sessionSeconds = 0;
  let sessionCount = 0;

  for (const session of sessions) {
    let runsToday = 0;
    for (const item of session.items) {
      const playedAt = Date.parse(String(item.stats?.summary.datePlayed ?? ""));
      if (!Number.isFinite(playedAt) || playedAt < from) continue;
      const seconds = Number(item.stats?.summary.duration ?? 0);
      if (!Number.isFinite(seconds) || seconds <= 0) continue;

      const scenario = getScenarioName(item);
      if (!scenario) continue;
      today.push({
        fileName: String(item.fileName ?? ""),
        scenario,
        seconds,
        playedAt,
      });
      runsToday += 1;
    }
    // A session that contributed nothing today contributes no time either,
    // even if it happens to straddle midnight.
    if (runsToday > 0) {
      sessionCount += 1;
      sessionSeconds += sessionSecondsToday(session, from, now);
    }
  }

  // The clock is per stretch of one scenario, so the runs have to be in the
  // order they were played before they can be cut into stretches.
  today.sort((a, b) => a.playedAt - b.playedAt);
  const blocks: TodayRun[][] = [];
  for (const run of today) {
    const last = blocks[blocks.length - 1];
    if (last && last[0].scenario === run.scenario) last.push(run);
    else blocks.push([run]);
  }

  const perScenario = new Map<string, { seconds: number; runs: number }>();
  const reasonCounts = new Map<string, number>();
  let totalSeconds = 0;
  let measuredBlocks = 0;

  for (const block of blocks) {
    const finished = block.reduce((sum, r) => sum + r.seconds, 0);
    // The clock is cumulative across the stretch, so only the last run's
    // reading describes the whole of it.
    const measured = timers.seconds.get(block[block.length - 1].fileName);
    let seconds = finished;
    if (typeof measured === "number" && measured >= finished) {
      seconds = measured;
      measuredBlocks += 1;
    } else {
      // A reading below the finished runs would mean the stretch was cut
      // differently from how the game counted it, so it is not believed.
      for (const run of block) {
        const reason = timers.reasons.get(run.fileName);
        if (reason)
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }

    const entry = perScenario.get(block[0].scenario) ?? { seconds: 0, runs: 0 };
    entry.seconds += seconds;
    entry.runs += block.length;
    perScenario.set(block[0].scenario, entry);
    totalSeconds += seconds;
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

  return {
    sessionSeconds,
    sessions: sessionCount,
    totalSeconds,
    knownSeconds,
    runs: today.length,
    sections: ordered,
    blocks: blocks.length,
    measuredBlocks,
    failureReasons: [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason]) => reason),
  };
}

export function formatMinutes(seconds: number): string {
  const total = Math.round(seconds / 60);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
