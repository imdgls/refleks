package screen

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"time"
)

// Reads the SESSION timer out of a finished replay.
//
// KovaaK's shows a running clock on screen that counts the time actually
// spent in the current scenario - restarts and abandoned attempts included -
// and pauses on the results screen. It resets when the scenario changes.
// That figure exists nowhere on disk: the stats file has no field for it and
// the game writes no log, so the only copy is the one recorded into the
// replay.
//
// Reading it back is easier than it sounds. The clock sits at a fixed place
// in a fixed font, and every frame's ink separates into exactly eight
// character columns, so the digits segment themselves rather than being cut
// at guessed offsets. Across 765 recorded frames not one failed to split
// into eight.
//
// The last frame is not necessarily the one to read: at a scenario change the
// game throws up a full-screen logo that covers the clock, and up to twelve
// seconds of a clip can be obscured. By then the clock has already stopped -
// the results screen pauses it - so the last *readable* frame carries the
// final value, and that is what this returns.
//
// Every stage refuses rather than guesses. A frame that does not split into
// eight characters, a glyph with no template close enough, an impossible
// clock, a value that goes backwards: all of them mean "no answer", never a
// wrong one. On the nine replays held out of the template building, 552
// readings produced no incorrect value.

const (
	// Where the clock sits in a 1080p frame, and the rows inside that crop
	// that hold the digits.
	timerCropX, timerCropY   = 164, 26
	timerCropW, timerCropH   = 90, 44
	timerRowTop, timerRowBot = 17, 38

	// A pixel counts as ink above this; the gap between the clock's white and
	// the panel behind it is wide enough that the exact value hardly matters.
	timerInk = 150

	// A column belongs to a character if at least this many of its pixels are
	// ink, which keeps a stray compression pixel from inventing a column.
	timerMinColumnInk = 2

	// Mean squared difference below which a glyph is accepted. Measured, not
	// chosen: across 180,000 pairs of recorded glyphs, matching pairs sat
	// below 0.03 and non-matching above 0.08, with a single pair in between.
	timerMatchThreshold = 0.05

	// The crop is only meaningful at the resolution it was measured at.
	timerFrameWidth, timerFrameHeight = 1920, 1080

	// How much of the clip's end to look at, and how often to sample it. The
	// clock has stopped well before this window opens, so the extra frames
	// only buy tolerance against the logo overlay.
	timerTailSeconds = 20
	timerSampleFPS   = 2
)

// ErrTimerUnavailable reports that the clock could not be read. It is not an
// error in the usual sense - a replay recorded at another resolution, or one
// whose end is covered by the scenario-change logo throughout, simply has no
// value to give, and the caller falls back to the run's own duration.
type ErrTimerUnavailable struct{ Reason string }

func (e ErrTimerUnavailable) Error() string { return "session timer unavailable: " + e.Reason }

var timerGlyphs = buildTimerGlyphs()

func buildTimerGlyphs() [10][]bool {
	var out [10][]bool
	for d, s := range digitGlyphs {
		bits := make([]bool, glyphHeight*glyphWidth)
		for i := 0; i < len(bits) && i < len(s); i++ {
			bits[i] = s[i] == '#'
		}
		out[d] = bits
	}
	return out
}

// ReadSessionTimer returns the session clock, in seconds, from the end of a
// replay. A returned ErrTimerUnavailable means no reading could be trusted.
func (e *Encoder) ReadSessionTimer(path string) (int, error) {
	e.ensureProbed()
	if e.ffmpegPath == "" {
		return 0, ErrTimerUnavailable{"ffmpeg not available"}
	}

	info, err := e.ProbeReplay(path)
	if err != nil {
		return 0, ErrTimerUnavailable{"could not probe replay: " + err.Error()}
	}
	if info.Width != timerFrameWidth || info.Height != timerFrameHeight {
		return 0, ErrTimerUnavailable{fmt.Sprintf(
			"replay is %dx%d; the clock's position is only known for %dx%d",
			info.Width, info.Height, timerFrameWidth, timerFrameHeight)}
	}

	frames, err := e.grabTimerFrames(path)
	if err != nil {
		return 0, ErrTimerUnavailable{err.Error()}
	}
	if len(frames) == 0 {
		return 0, ErrTimerUnavailable{"no frames decoded from the clip's end"}
	}

	best := -1
	for _, f := range frames {
		v, ok := decodeTimerFrame(f)
		if !ok {
			continue
		}
		// Inside the last few seconds of one run the clock can only stand
		// still or climb. Going backwards would mean the scenario changed
		// mid-window, which cannot happen here - so distrust the whole clip
		// rather than report a value from the wrong scenario.
		if v < best {
			return 0, ErrTimerUnavailable{"clock ran backwards within the clip"}
		}
		best = v
	}
	if best < 0 {
		return 0, ErrTimerUnavailable{"no frame at the clip's end could be read"}
	}
	return best, nil
}

// grabTimerFrames returns the cropped grey frames from the clip's tail.
func (e *Encoder) grabTimerFrames(path string) ([][]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, e.ffmpegPath,
		"-hide_banner", "-loglevel", "error",
		"-sseof", fmt.Sprintf("-%d", timerTailSeconds),
		"-i", path,
		"-vf", fmt.Sprintf("fps=%d,crop=%d:%d:%d:%d",
			timerSampleFPS, timerCropW, timerCropH, timerCropX, timerCropY),
		"-f", "rawvideo", "-pix_fmt", "gray", "-",
	)
	var stderr tailBuffer
	cmd.Stderr = &stderr
	hideCmdWindow(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	size := timerCropW * timerCropH
	var frames [][]byte
	for {
		buf := make([]byte, size)
		if _, err := io.ReadFull(stdout, buf); err != nil {
			break
		}
		frames = append(frames, buf)
	}
	if err := cmd.Wait(); err != nil && len(frames) == 0 {
		return nil, fmt.Errorf("ffmpeg: %v: %s", err, stderr.String())
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("timed out reading the clip's end")
	}
	return frames, nil
}

// decodeTimerFrame reads HH:MM:SS out of one cropped grey frame.
func decodeTimerFrame(buf []byte) (int, bool) {
	if len(buf) < timerCropW*timerCropH {
		return 0, false
	}
	height := timerRowBot - timerRowTop
	ink := make([]bool, height*timerCropW)
	columnInk := make([]int, timerCropW)
	for y := 0; y < height; y++ {
		row := (y + timerRowTop) * timerCropW
		for x := 0; x < timerCropW; x++ {
			if buf[row+x] > timerInk {
				ink[y*timerCropW+x] = true
				columnInk[x]++
			}
		}
	}

	// The clock is eight characters wide. Anything else on screen where the
	// clock should be is not the clock.
	type span struct{ from, to int }
	var spans []span
	start := -1
	for x := 0; x <= timerCropW; x++ {
		lit := x < timerCropW && columnInk[x] >= timerMinColumnInk
		if lit && start < 0 {
			start = x
		}
		if !lit && start >= 0 {
			spans = append(spans, span{start, x})
			start = -1
		}
	}
	if len(spans) != 8 {
		return 0, false
	}

	digits := make([]int, 0, 6)
	for _, slot := range [6]int{0, 1, 3, 4, 6, 7} {
		d, ok := matchGlyph(ink, height, spans[slot].from, spans[slot].to)
		if !ok {
			return 0, false
		}
		digits = append(digits, d)
	}

	hours := digits[0]*10 + digits[1]
	mins := digits[2]*10 + digits[3]
	secs := digits[4]*10 + digits[5]
	if mins > 59 || secs > 59 {
		return 0, false
	}
	return hours*3600 + mins*60 + secs, true
}

// matchGlyph centres one character's ink in the template canvas and names it.
func matchGlyph(ink []bool, height, from, to int) (int, bool) {
	width := to - from
	if width <= 0 || width > glyphWidth {
		return 0, false
	}

	top, bottom := -1, -1
	for y := 0; y < height; y++ {
		n := 0
		for x := from; x < to; x++ {
			if ink[y*timerCropW+x] {
				n++
			}
		}
		if n >= timerMinColumnInk {
			if top < 0 {
				top = y
			}
			bottom = y
		}
	}
	if top < 0 || bottom-top+1 > glyphHeight {
		return 0, false
	}

	canvas := make([]bool, glyphHeight*glyphWidth)
	offY := (glyphHeight - (bottom - top + 1)) / 2
	offX := (glyphWidth - width) / 2
	for y := top; y <= bottom; y++ {
		for x := from; x < to; x++ {
			if ink[y*timerCropW+x] {
				canvas[(offY+y-top)*glyphWidth+offX+x-from] = true
			}
		}
	}

	bestDist, best := 1.0, -1
	for d, glyph := range timerGlyphs {
		diff := 0
		for i := range canvas {
			if canvas[i] != glyph[i] {
				diff++
			}
		}
		dist := float64(diff) / float64(len(canvas))
		if dist < bestDist {
			bestDist, best = dist, d
		}
	}
	if best < 0 || bestDist >= timerMatchThreshold {
		return 0, false
	}
	return best, true
}
