import { useRecentSessionSnapshot } from "@/features/overview/hooks/useRecentSessionSnapshot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { useBenchmarks, usePersistedState } from "@/shared/hooks";
import { cn } from "@/shared/lib";
import { useI18n } from "@/shared/lib/i18n";
import { ChevronDown, Clock3, Gamepad2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildScenarioCategories } from "./scenarioCategories";
import { formatMinutes, useTodayBreakdown } from "./todayScenarios";

/**
 * Session and playtime, in the sidebar rather than on the overview page, so
 * the figure is there whichever page is open.
 *
 * It folds away, and remembers that it is folded. Watching the clock climb
 * is not always welcome, and a number you cannot get away from is worse than
 * no number - so hiding it is a first-class state here, not a convenience.
 * Folded means folded: the numbers are absent from the tooltip too, since a
 * tooltip that shows the time to someone who put it away would defeat the
 * point.
 *
 * The readout opens a breakdown of the day by scenario, gathered into aim
 * categories where the benchmark data supports one. That data is only
 * fetched once the breakdown is opened for the first time - it is most of a
 * megabyte, and nothing else in the sidebar needs it.
 *
 * The snapshot is the same one the overview page reads. It is memoised on the
 * session list, so a second reader costs a recomputation only when a run
 * lands, not on every render or route change.
 */

const STORE_EXPANDED = "refleks.sidebar.playtime.expanded";
const STORE_LIST_OPEN = "refleks.sidebar.playtime.today";

type CategoryState = "idle" | "loading" | "ready" | "unavailable";

export function SidebarPlaytime({ open }: { open: boolean }) {
  const { t } = useI18n();
  const snapshot = useRecentSessionSnapshot();
  const { benchmarks, progressMap, loadAllProgress } = useBenchmarks();
  const [expanded, setExpanded] = usePersistedState(STORE_EXPANDED, true);
  const [listOpen, setListOpen] = usePersistedState(STORE_LIST_OPEN, false);
  const [catState, setCatState] = useState<CategoryState>("idle");
  const requested = useRef(false);

  const collapsed = !open;
  const title = t("overview.sessionPlaytime.title");
  const showList = expanded && listOpen && !collapsed;

  // Fetched on first open rather than at startup: the progress cache is
  // ~700 KB and only this breakdown reads it.
  useEffect(() => {
    if (!showList || requested.current) return;
    if (Object.keys(progressMap).length > 0) {
      setCatState("ready");
      return;
    }
    requested.current = true;
    setCatState("loading");
    loadAllProgress()
      .then(() => setCatState("ready"))
      .catch(() => setCatState("unavailable"));
  }, [showList, progressMap, loadAllProgress]);

  const index = useMemo(
    () => buildScenarioCategories(benchmarks, progressMap),
    [benchmarks, progressMap],
  );
  const breakdown = useTodayBreakdown(index);

  const categorised =
    breakdown.totalSeconds > 0
      ? Math.round((breakdown.knownSeconds / breakdown.totalSeconds) * 100)
      : 0;
  // Only claim a share once the lookup can actually answer; an empty index
  // would otherwise report a confident "0% categorised".
  const indexUsable = index.size > 0;

  const header = (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      className={cn(
        "relative z-[1] flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        collapsed && "justify-center",
      )}
    >
      <span className="relative flex size-[1.125rem] shrink-0 items-center justify-center [&_svg]:size-[1.125rem] [&_svg]:shrink-0">
        <Clock3 />
      </span>
      <span
        className={cn(
          "min-w-0 overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200 ease-out",
          collapsed ? "max-w-0 opacity-0" : "max-w-[12rem] flex-1 opacity-100",
        )}
      >
        {title}
      </span>
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-surface-muted-foreground transition-[transform,max-width,opacity] duration-200 ease-out",
          expanded ? "" : "-rotate-90",
          collapsed ? "max-w-0 opacity-0" : "max-w-4 opacity-100",
        )}
      />
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{header}</TooltipTrigger>
        <TooltipContent side="right" align="center">
          {expanded ? (
            <div className="space-y-0.5">
              <div>{title}</div>
              <div className="tabular-nums">
                {snapshot.sessionLengthLabel} - {snapshot.activePlaytimeLabel}
              </div>
            </div>
          ) : (
            title
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div>
      {header}
      {expanded && (
        <>
          <button
            type="button"
            onClick={() => setListOpen((v) => !v)}
            aria-expanded={listOpen}
            title="Today's scenarios"
            className="w-full space-y-0.5 rounded-md px-2 pb-1 pt-0.5 text-left transition-colors hover:bg-sidebar-accent"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-semibold tabular-nums text-sidebar-foreground">
                {snapshot.sessionLengthLabel}
              </span>
              <span className="truncate text-[0.625rem] text-surface-muted-foreground">
                {snapshot.sessionLengthDetail}
              </span>
              <ChevronDown
                aria-hidden
                className={cn(
                  "ml-auto size-3 shrink-0 text-surface-muted-foreground transition-transform",
                  listOpen ? "" : "-rotate-90",
                )}
              />
            </div>
            <div className="flex items-baseline gap-1.5">
              <Gamepad2 className="size-3 shrink-0 self-center text-surface-muted-foreground" />
              <span className="text-sm font-medium tabular-nums text-sidebar-foreground">
                {snapshot.activePlaytimeLabel}
              </span>
              <span className="truncate text-[0.625rem] text-surface-muted-foreground">
                {snapshot.activePlaytimeDetail}
              </span>
            </div>
          </button>

          {listOpen && (
            <TodayList
              breakdown={breakdown}
              categorised={categorised}
              indexUsable={indexUsable}
              catState={catState}
            />
          )}
        </>
      )}
    </div>
  );
}

function TodayList({
  breakdown,
  categorised,
  indexUsable,
  catState,
}: {
  breakdown: ReturnType<typeof useTodayBreakdown>;
  categorised: number;
  indexUsable: boolean;
  catState: CategoryState;
}) {
  if (breakdown.runs === 0) {
    return (
      <p className="px-2 pb-2 text-[0.625rem] text-surface-muted-foreground">
        No runs today.
      </p>
    );
  }

  return (
    <div className="max-h-72 overflow-y-auto px-2 pb-2">
      <div className="flex items-baseline justify-between gap-1 pb-1 text-[0.625rem] uppercase tracking-wider text-surface-muted-foreground">
        <span>Today</span>
        <span className="tabular-nums">
          {formatMinutes(breakdown.totalSeconds)}
        </span>
      </div>

      <p className="pb-1.5 text-[0.625rem] text-surface-muted-foreground">
        {catState === "loading" && "Loading categories..."}
        {catState === "unavailable" && "Categories unavailable - listing by scenario."}
        {catState !== "loading" &&
          catState !== "unavailable" &&
          (indexUsable
            ? `${formatMinutes(breakdown.knownSeconds)} of ${formatMinutes(
                breakdown.totalSeconds,
              )} categorised (${categorised}%)`
            : "Categories not loaded - listing by scenario.")}
      </p>

      <div className="space-y-2">
        {breakdown.sections.map((section) => (
          <div key={section.key}>
            <div
              className={cn(
                "flex items-baseline justify-between gap-1 text-[0.625rem] font-medium uppercase tracking-wider",
                section.tone === "known"
                  ? "text-sidebar-foreground"
                  : "text-surface-muted-foreground",
              )}
            >
              <span className="min-w-0 truncate" title={section.label}>
                {section.label}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatMinutes(section.seconds)}
              </span>
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {section.scenarios.map((row) => (
                <li key={row.scenario}>
                  <div className="flex items-baseline justify-between gap-1.5">
                    <span
                      className="min-w-0 truncate text-[0.6875rem] text-sidebar-foreground"
                      title={
                        row.runs > 1
                          ? `${row.scenario} (${row.runs} runs)`
                          : row.scenario
                      }
                    >
                      {row.scenario}
                    </span>
                    <span className="shrink-0 text-[0.6875rem] tabular-nums text-surface-muted-foreground">
                      {formatMinutes(row.seconds)}
                    </span>
                  </div>
                  {row.note && (
                    <p
                      className="truncate text-[0.5625rem] text-surface-muted-foreground"
                      title={row.note}
                    >
                      {row.note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
