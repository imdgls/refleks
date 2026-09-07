package runs

import (
	"testing"
	"time"

	"refleks/internal/models"
)

func TestPlaytimeSecondsRemovesPause(t *testing.T) {
	cases := []struct {
		name   string
		window time.Duration
		pause  float64
		want   float64
	}{
		{"no pause is the whole window", 60 * time.Second, 0, 60},
		// The longest run on record: a sixty-second scenario left paused for
		// nearly two hours.
		{"long pause leaves the scenario", 6571600 * time.Millisecond, 6512, 59.6},
		{"pause longer than the window is not believed", 60 * time.Second, 90, 60},
		{"pause equal to the window is not believed", 60 * time.Second, 60, 60},
		{"negative pause is ignored", 60 * time.Second, -5, 60},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := playtimeSeconds(c.window, models.RunStatsSummary{PauseDuration: c.pause})
			if diff := got - c.want; diff > 0.001 || diff < -0.001 {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

// record builds a stored run that started an hour before it ended.
func record(pause, duration float64, challengeStart string) storedRunRecord {
	end := time.Date(2026, 4, 20, 10, 0, 0, 0, time.Local)
	return storedRunRecord{
		EpochMilli: end.UnixMilli(),
		Stats: models.RunStatsData{Summary: models.RunStatsSummary{
			ChallengeStart: challengeStart,
			PauseDuration:  pause,
			Duration:       duration,
		}},
	}
}

func TestRepairPausedDuration(t *testing.T) {
	t.Run("rebuilds an inflated duration", func(t *testing.T) {
		rec := record(3540, 3600, "09:00:00")
		repairPausedDuration(&rec)
		if rec.Stats.Summary.Duration != 60 {
			t.Fatalf("got %v, want 60", rec.Stats.Summary.Duration)
		}
	})

	t.Run("leaves an already repaired duration alone", func(t *testing.T) {
		rec := record(3540, 60, "09:00:00")
		repairPausedDuration(&rec)
		repairPausedDuration(&rec)
		if rec.Stats.Summary.Duration != 60 {
			t.Fatalf("got %v, want 60", rec.Stats.Summary.Duration)
		}
	})

	t.Run("leaves an unpaused run alone", func(t *testing.T) {
		rec := record(0, 3600, "09:00:00")
		repairPausedDuration(&rec)
		if rec.Stats.Summary.Duration != 3600 {
			t.Fatalf("got %v, want 3600", rec.Stats.Summary.Duration)
		}
	})

	t.Run("declines without a usable challenge start", func(t *testing.T) {
		rec := record(3540, 3600, "")
		repairPausedDuration(&rec)
		if rec.Stats.Summary.Duration != 3600 {
			t.Fatalf("got %v, want 3600 untouched", rec.Stats.Summary.Duration)
		}
	})

	t.Run("declines when the duration came from somewhere else", func(t *testing.T) {
		rec := record(3540, 1234, "09:00:00")
		repairPausedDuration(&rec)
		if rec.Stats.Summary.Duration != 1234 {
			t.Fatalf("got %v, want 1234 untouched", rec.Stats.Summary.Duration)
		}
	})

	t.Run("handles a run that crossed midnight", func(t *testing.T) {
		// Ends at 10:00, Challenge Start reads 23:30 - the previous day.
		rec := record(1800, 0, "23:30:00")
		rec.Stats.Summary.Duration = 37800
		repairPausedDuration(&rec)
		if rec.Stats.Summary.Duration != 36000 {
			t.Fatalf("got %v, want 36000", rec.Stats.Summary.Duration)
		}
	})
}
