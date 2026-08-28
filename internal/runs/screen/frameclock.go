//go:build windows

package screen

import (
	"sort"
	"sync"
	"time"
)

// The capture pipes raw frames into ffmpeg over stdin at a nominal frame
// rate, so ffmpeg stamps frame n with media time n/fps regardless of when
// that frame was actually taken. Two things follow, and both were being
// papered over by assuming media time and wall-clock time were the same
// thing measured from the moment the session started:
//
//   - Nothing is written until the encoder is up, so media time zero
//     happens some way after the session start that was recorded.
//   - If the capture cannot sustain the nominal rate, fewer frames are
//     produced per real second, and media time falls progressively behind
//     wall-clock time for the rest of the session.
//
// Measured on this machine, the first cost a fixed 30-60 ms and the second
// nothing at 30 fps but roughly 0.05% at 60 fps - which is around 30 ms of
// slippage per minute of play, growing without bound across a session.
//
// The frames are produced here, so the honest answer is simply to write
// down when each one went out and look the answer up later, rather than
// deriving it from a start time that was never the same clock.

// frameSampleInterval is how often a frame's wall-clock time is kept. Frames
// between samples are interpolated, which is exact while the pipe is keeping
// pace and off by a fraction of the gap when it stutters.
const frameSampleInterval = 250 * time.Millisecond

type frameStamp struct {
	index uint64
	at    time.Time
}

// frameClock maps a position in ffmpeg's media timeline back to the wall
// clock, from the times at which frames were handed to ffmpeg.
type frameClock struct {
	mu      sync.Mutex
	fps     int
	count   uint64
	samples []frameStamp
}

// reset starts a new session. fps must match the -framerate ffmpeg is given,
// since that is what fixes the media timestamp of each frame.
func (fc *frameClock) reset(fps int) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.fps = fps
	fc.count = 0
	fc.samples = fc.samples[:0]
}

// mark records that one frame has been written to ffmpeg at time at. It is
// called for every frame, including the repeats that keep the stream at a
// constant rate while the screen is static - those occupy media time like
// any other frame and must be counted.
func (fc *frameClock) mark(at time.Time) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	index := fc.count
	fc.count++

	if len(fc.samples) == 0 {
		fc.samples = append(fc.samples, frameStamp{index: index, at: at})
		return
	}
	if at.Sub(fc.samples[len(fc.samples)-1].at) >= frameSampleInterval {
		fc.samples = append(fc.samples, frameStamp{index: index, at: at})
	}
}

// wallAt returns when the frame at the given media offset was captured.
//
// Reports false when the session produced no frames, or when the offset
// lands past the frames actually written - extrapolating beyond the last
// one would reintroduce exactly the guess this replaces.
func (fc *frameClock) wallAt(media time.Duration) (time.Time, bool) {
	fc.mu.Lock()
	defer fc.mu.Unlock()

	if fc.fps <= 0 || len(fc.samples) == 0 || media < 0 {
		return time.Time{}, false
	}

	target := media.Seconds() * float64(fc.fps)
	if target < 0 {
		return time.Time{}, false
	}
	if target > float64(fc.count-1) {
		return time.Time{}, false
	}

	// Last sample at or before the target frame.
	i := sort.Search(len(fc.samples), func(k int) bool {
		return float64(fc.samples[k].index) > target
	}) - 1
	if i < 0 {
		return fc.samples[0].at, true
	}
	if i >= len(fc.samples)-1 {
		return fc.samples[len(fc.samples)-1].at, true
	}

	lo, hi := fc.samples[i], fc.samples[i+1]
	span := float64(hi.index - lo.index)
	if span <= 0 {
		return lo.at, true
	}
	frac := (target - float64(lo.index)) / span
	return lo.at.Add(time.Duration(frac * float64(hi.at.Sub(lo.at)))), true
}

// FrameWallClock exposes the frame clock to the run store. It is deliberately
// not part of the Provider interface: a platform without frame-level capture
// timing simply does not have this method, and the caller falls back to the
// old assumption rather than every platform having to implement a stub.
func (c *captureWin) FrameWallClock(media time.Duration) (time.Time, bool) {
	return c.frames.wallAt(media)
}
