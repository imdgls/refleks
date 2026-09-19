import type { Benchmark, BenchmarkProgress, RankDef } from "@/shared/types";

/**
 * Which benchmarks a scenario belongs to, and where a score sits in each.
 *
 * Nothing here is configured. A benchmark is a list of scenarios, and the
 * progress data already holds those lists, so membership is the same walk
 * read backwards.
 *
 * Every benchmark a scenario belongs to is reported, never one of them. The
 * same result is ranked completely differently depending on who drew the
 * ladder: RawControlSphere at 10,743 is rank 1 in Leica Control Bench, 2 in
 * FN Prospects, 3 in Jay9's and 4 in Viscose S2. Of 648 scenarios that sit in
 * more than one benchmark, 607 have thresholds that disagree. Picking one
 * would not be a simplification, it would be an answer that happens to be
 * wrong three times out of four.
 */

export type LadderScenario = {
  name: string;
  thresholds: number[];
  /** The score the benchmark recorded, which is the player's best there. */
  apiScore: number;
};

export type LadderGroup = { name: string; scenarios: LadderScenario[] };
export type LadderCategory = { name: string; groups: LadderGroup[] };

export type BenchmarkList = {
  key: string;
  benchmarkName: string;
  difficultyName: string;
  ranks: RankDef[];
  categories: LadderCategory[];
  favorite: boolean;
  /** How far along this ladder the player is, used only for ordering. */
  reach: number;
};

/**
 * What a rank number means, established against the data rather than assumed.
 *
 * thresholds[0] is the floor of the ladder and earns nothing. thresholds[i]
 * for i >= 1 is the requirement for the rank named ranks[i-1]. A scenario's
 * rank is therefore the highest index whose threshold the score meets, and 0
 * means the first named rank has not been reached.
 *
 * Checked against every scenario entry on this machine: the rule reproduces
 * the rank the server reports for all 4,168 of them.
 */
export function rankForScore(score: number, thresholds: number[]): number {
  // A few published ladders pad their lowest ranks with zeroes, which anyone
  // clears the moment they score at all. The server treats those as earned
  // and withholds a rank only where there is no score, so an unplayed
  // scenario stays unranked and a played one takes the free rung.
  if (score <= 0) return 0;

  let rank = 0;
  for (let i = 1; i < thresholds.length; i++) {
    if (score >= thresholds[i]) rank = i;
  }
  return rank;
}

/**
 * Where a score sits along the ladder, from 0 to 1, with every rank given an
 * equal share of the bar.
 *
 * Rank-linear rather than score-linear because the thresholds are spaced
 * unevenly - one Viscose ladder steps 5562, 6600, 8150, 9300, 10500 - and a
 * score-linear axis would draw some ranks wide and others narrow. Equal
 * steps also match the per-rank cells on the benchmarks page.
 *
 * This deliberately does not call the app's normalizedRankProgress, which
 * places rank r in the band belonging to rank r-1: for rank 4 of 9 it returns
 * 0.367 where the band starts at 0.444, so every marker would be drawn one
 * rank low. Its rank-0 branch is right, which is what makes the disagreement
 * visible.
 */
export function rankPosition(score: number, thresholds: number[]): number {
  const bands = thresholds.length - 1;
  if (bands <= 0) return 0;

  const rank = rankForScore(score, thresholds);
  if (rank >= bands) return 1;

  const from = thresholds[rank];
  const to = thresholds[rank + 1];
  const within = to > from ? (score - from) / (to - from) : 0;
  const clamped = Math.max(0, Math.min(1, within));
  return Math.max(0, Math.min(1, (rank + clamped) / bands));
}

/** The name of the rank a score has earned, or null below the first one. */
export function rankName(
  score: number,
  thresholds: number[],
  ranks: RankDef[],
): string | null {
  const rank = rankForScore(score, thresholds);
  if (rank <= 0) return null;
  return ranks[rank - 1]?.name ?? null;
}

export type BenchmarkLists = {
  /** Every list, in no particular order. */
  all: BenchmarkList[];
  /** The lists containing a scenario, best first. */
  byScenario: Map<string, BenchmarkList[]>;
};

/**
 * Every benchmark list, kept whole, plus an index from scenario to the lists
 * that contain it.
 *
 * The lists are shared by reference rather than copied per scenario: 248
 * difficulties of a dozen or more scenarios each is not large, but copying
 * one per membership would be.
 */
export function buildBenchmarkLists(
  benchmarks: Benchmark[],
  progressMap: Record<number, BenchmarkProgress>,
  favorites: string[] = [],
): BenchmarkLists {
  const favorite = new Set(favorites);
  const all: BenchmarkList[] = [];
  const byScenario = new Map<string, BenchmarkList[]>();

  for (const benchmark of benchmarks) {
    for (const difficulty of benchmark.difficulties ?? []) {
      const progress = progressMap[difficulty.kovaaksBenchmarkId];
      if (!progress) continue;

      const categories: LadderCategory[] = [];
      const members: string[] = [];
      let reachSum = 0;
      let reachCount = 0;

      for (const category of progress.categories ?? []) {
        const groups: LadderGroup[] = [];
        for (const group of category.groups ?? []) {
          const scenarios: LadderScenario[] = [];
          for (const scenario of group.scenarios ?? []) {
            const thresholds = scenario.thresholds ?? [];
            // A ladder needs a floor and at least one rank to be drawable.
            if (!scenario.name || thresholds.length < 2) continue;
            const apiScore = Number(scenario.score ?? 0);
            scenarios.push({ name: scenario.name, thresholds, apiScore });
            members.push(scenario.name);
            reachSum += rankPosition(apiScore, thresholds);
            reachCount += 1;
          }
          if (scenarios.length > 0) {
            groups.push({ name: (group.name ?? "").trim(), scenarios });
          }
        }
        if (groups.length > 0) {
          categories.push({ name: (category.name ?? "").trim(), groups });
        }
      }
      if (categories.length === 0) continue;

      const list: BenchmarkList = {
        key: `${difficulty.kovaaksBenchmarkId}-${benchmark.benchmarkName}-${difficulty.difficultyName}`,
        benchmarkName: benchmark.benchmarkName,
        difficultyName: difficulty.difficultyName,
        ranks: progress.ranks ?? [],
        categories,
        favorite: favorite.has(benchmark.benchmarkName),
        reach: reachCount > 0 ? reachSum / reachCount : 0,
      };
      all.push(list);
      for (const name of members) {
        const bucket = byScenario.get(name);
        if (bucket) bucket.push(list);
        else byScenario.set(name, [list]);
      }
    }
  }

  for (const bucket of byScenario.values()) {
    // Favourites first, then the ladder the player has come furthest along,
    // so the benchmark actually being worked through leads.
    bucket.sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return b.reach - a.reach;
    });
  }
  return { all, byScenario };
}

/** Finds a scenario's entry inside a list, or null when it is not there. */
export function findInList(
  list: BenchmarkList,
  scenarioName: string,
): LadderScenario | null {
  for (const category of list.categories) {
    for (const group of category.groups) {
      for (const scenario of group.scenarios) {
        if (scenario.name === scenarioName) return scenario;
      }
    }
  }
  return null;
}
