import { useRecentSessionSnapshot } from "@/features/overview/hooks/useRecentSessionSnapshot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { usePersistedState } from "@/shared/hooks";
import { cn } from "@/shared/lib";
import { useI18n } from "@/shared/lib/i18n";
import { ChevronDown, Clock3, Gamepad2 } from "lucide-react";

/**
 * Session and playtime, in the sidebar rather than on the overview page, so
 * the figure is there whichever page is open.
 *
 * It folds away, and remembers that it is folded. Watching the clock climb
 * is not always welcome, and a number you cannot get away from is worse
 * than no number - so hiding it is a first-class state here, not a
 * convenience. Folded means folded: the numbers are absent from the tooltip
 * too, since a tooltip that shows the time to someone who put it away would
 * defeat the point.
 *
 * The snapshot is the same one the overview page reads. It is memoised on
 * the session list, so a second reader costs a recomputation only when a run
 * lands, not on every render or route change.
 */

const STORE_EXPANDED = "refleks.sidebar.playtime.expanded";

export function SidebarPlaytime({ open }: { open: boolean }) {
  const { t } = useI18n();
  const snapshot = useRecentSessionSnapshot();
  const [expanded, setExpanded] = usePersistedState(STORE_EXPANDED, true);

  const collapsed = !open;
  const title = t("overview.sessionPlaytime.title");

  const toggle = (
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

  const readout = (
    <div className="space-y-0.5 px-2 pb-1 pt-0.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-sm font-semibold tabular-nums text-sidebar-foreground">
          {snapshot.sessionLengthLabel}
        </span>
        <span className="truncate text-[0.625rem] text-surface-muted-foreground">
          {snapshot.sessionLengthDetail}
        </span>
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
    </div>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{toggle}</TooltipTrigger>
        <TooltipContent side="right" align="center">
          {expanded ? (
            <div className="space-y-0.5">
              <div>{title}</div>
              <div className="tabular-nums">
                {snapshot.sessionLengthLabel} · {snapshot.activePlaytimeLabel}
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
      {toggle}
      {expanded && readout}
    </div>
  );
}
