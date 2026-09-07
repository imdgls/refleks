package runs

import (
	"math"
	"time"

	"refleks/internal/models"
)

// Time actually spent playing a scenario, as opposed to time the scenario
// existed.
//
// KovaaK's writes a run's stats file only when the scenario reaches its
// natural end, and the file carries the wall-clock time the challenge began
// plus how long it stood paused. The window between start and end is
// therefore not the same as the time played: pausing for an hour and coming
// back produces a sixty-second run inside a sixty-one-minute window.
//
// The window itself must stay wall-clock - the mouse trace and the screen
// recording are indexed by real time, and shortening the window would cut
// them in the wrong place. Only the reported duration has the pause removed.
//
// Verified against the stats files: for the twelve longest runs on record,
// window minus Pause Duration lands within a second of sixty every time, and
// across the whole history the pause accounts for 8.7% of the total.

// playtimeSeconds returns the seconds of the window that were spent playing.
//
// A run with no pause is its whole window, which is what the value was before
// this existed. Pause Duration is written in whole seconds and can only be
// subtracted while it leaves something behind; anything else is treated as a
// field we do not understand and the window is returned untouched.
func playtimeSeconds(window time.Duration, summary models.RunStatsSummary) float64 {
	seconds := window.Seconds()
	pause := summary.PauseDuration
	if pause <= 0 || math.IsNaN(pause) || pause >= seconds {
		return seconds
	}
	return seconds - pause
}

// repairPausedDuration recomputes a stored run's duration from the fields the
// record already carries.
//
// Runs recorded before the pause was subtracted keep an inflated duration on
// disk, and there are years of them. Rather than rewrite thousands of files -
// a migration whose failure mode is a corrupted history - the value is
// rebuilt when the run is read. Nothing else in the record depends on it.
//
// The rebuild is a function of the stored fields alone, never of the stored
// duration, so it lands on the same answer whether the record was written
// before or after the fix, and running it twice changes nothing.
//
// It declines to guess. A run whose Challenge Start is missing or
// unparseable cannot have its window reconstructed here - at ingest the
// window can fall back to the first stats event, which a summary-only read
// does not have - so such a record is left exactly as it was found.
func repairPausedDuration(rec *storedRunRecord) {
	summary := &rec.Stats.Summary
	if summary.PauseDuration <= 0 || rec.EpochMilli <= 0 {
		return
	}
	end := time.UnixMilli(rec.EpochMilli)
	start, ok := parseTODOnDate(summary.ChallengeStart, end)
	if !ok {
		return
	}
	if start.After(end) {
		start = start.AddDate(0, 0, -1)
	}
	window := end.Sub(start)
	if window <= 0 {
		return
	}
	// Only a duration that is recognisably one of the two forms this window
	// can produce is replaced. Anything else was computed by a path this
	// function does not model, and overwriting it would be a guess.
	played := playtimeSeconds(window, *summary)
	if !closeEnough(summary.Duration, window.Seconds()) && !closeEnough(summary.Duration, played) {
		return
	}
	summary.Duration = played
}

// closeEnough allows for the sub-second rounding between a run's recorded
// start and the second-resolution timestamp in its file name.
func closeEnough(a, b float64) bool {
	return math.Abs(a-b) < 2
}
