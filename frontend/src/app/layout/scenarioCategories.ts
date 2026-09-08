import type { Benchmark, BenchmarkProgress } from "@/shared/types";

/**
 * Which aim category a scenario belongs to, read out of the benchmark data
 * rather than decided here.
 *
 * The benchmark catalogue is community-authored, and the category field is
 * used for whatever its author felt like: across the 248 benchmarks on this
 * machine it holds 100 distinct values, among them rank names ("Advanced",
 * "Hard"), weapons ("AR", "SMG", "Shotgun"), a benchmark's own title, Chinese
 * translations, and "(:". Grouping training time by that field unfiltered
 * produces a distribution that means nothing, and 40% of the time lands in
 * scenarios whose sources disagree with each other.
 *
 * So two sources are trusted, in order:
 *
 *  1. Voltaic's own benchmarks. Internally consistent - 207 scenarios, zero
 *     disagreements - and the origin of the vocabulary everyone else borrows.
 *  2. Any other benchmark, but only where its category is one of the four
 *     names Voltaic uses. That admits "CLICKING" and "tracking" from other
 *     authors while rejecting "AR" and "Advanced", and it roughly doubles
 *     what can be classified while leaving almost nothing in dispute.
 *
 * Subcategories are taken as written. They are not canonicalised, because
 * another author's "Blending" is their own division and not a Voltaic one to
 * be mapped onto.
 *
 * Everything else is unknown, and stays visibly unknown. A scenario whose
 * sources disagree is reported as disagreeing rather than resolved by
 * picking one.
 */

export type CategoryPlacement = {
  category: string;
  subcategory: string | null;
};

export type ScenarioCategory =
  | { kind: "known"; placement: CategoryPlacement; voltaic: boolean }
  | { kind: "conflict"; candidates: CategoryPlacement[] }
  | { kind: "unknown" };

/** The four category names Voltaic uses, lowercased for matching. */
const CANONICAL: Record<string, string> = {
  tracking: "Tracking",
  clicking: "Clicking",
  switching: "Switching",
  movement: "Movement",
};

const UNKNOWN: ScenarioCategory = { kind: "unknown" };

type PlacementSet = Map<string, CategoryPlacement>;

function placementKey(p: CategoryPlacement): string {
  return `${p.category}/${p.subcategory ?? ""}`;
}

function record(
  into: Map<string, PlacementSet>,
  scenario: string,
  placement: CategoryPlacement,
) {
  let set = into.get(scenario);
  if (!set) {
    set = new Map();
    into.set(scenario, set);
  }
  set.set(placementKey(placement), placement);
}

function isVoltaic(benchmarkName: string): boolean {
  return benchmarkName.toLowerCase().includes("voltaic");
}

function resolve(
  set: PlacementSet | undefined,
  voltaic: boolean,
): ScenarioCategory | null {
  if (!set || set.size === 0) return null;
  const candidates = [...set.values()];
  if (candidates.length === 1) {
    return { kind: "known", placement: candidates[0], voltaic };
  }
  return { kind: "conflict", candidates };
}

export function buildScenarioCategories(
  benchmarks: Benchmark[],
  progressMap: Record<number, BenchmarkProgress>,
): Map<string, ScenarioCategory> {
  const fromVoltaic = new Map<string, PlacementSet>();
  const fromCanonical = new Map<string, PlacementSet>();

  for (const benchmark of benchmarks) {
    const voltaic = isVoltaic(benchmark.benchmarkName);
    for (const difficulty of benchmark.difficulties ?? []) {
      const progress = progressMap[difficulty.kovaaksBenchmarkId];
      if (!progress) continue;

      for (const category of progress.categories ?? []) {
        const raw = (category.name ?? "").trim();
        const canonical = CANONICAL[raw.toLowerCase()];
        // Outside Voltaic only the four known category names are believed.
        if (!voltaic && !canonical) continue;
        const name = canonical ?? raw;
        if (!name) continue;

        for (const group of category.groups ?? []) {
          const subcategory = (group.name ?? "").trim() || null;
          const placement = { category: name, subcategory };
          for (const scenario of group.scenarios ?? []) {
            if (!scenario.name) continue;
            record(
              voltaic ? fromVoltaic : fromCanonical,
              scenario.name,
              placement,
            );
          }
        }
      }
    }
  }

  const out = new Map<string, ScenarioCategory>();
  for (const scenario of fromVoltaic.keys()) {
    const resolved = resolve(fromVoltaic.get(scenario), true);
    if (resolved) out.set(scenario, resolved);
  }
  for (const scenario of fromCanonical.keys()) {
    if (out.has(scenario)) continue; // Voltaic already answered.
    const resolved = resolve(fromCanonical.get(scenario), false);
    if (resolved) out.set(scenario, resolved);
  }
  return out;
}

export function lookupCategory(
  index: Map<string, ScenarioCategory>,
  scenario: string,
): ScenarioCategory {
  return index.get(scenario) ?? UNKNOWN;
}

export function placementLabel(p: CategoryPlacement): string {
  return p.subcategory ? `${p.category} · ${p.subcategory}` : p.category;
}
