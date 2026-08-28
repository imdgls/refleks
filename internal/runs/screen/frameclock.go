//go:build windows

package screen

import (
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
// nothing at 30 fps but up to 0.05% at 60 fps, which is around 30 ms of
// slippage per minute of play and grows for as long as the session lasts.
//
// The frames originate here, so their times are already known. Writing each
// one down and looking the answer up removes the inference entirely.
//
// Every frame is kept rather than a periodic sample: interpolating between
// samples 250 ms apart was measured 62 ms out on a 60 fps session, because
// a capture that stutters does not distribute its frames evenly between two
// sample points. An exact table costs about a megabyte for the retained
// window and removes that error rather than shrinking it.

// frameClockRetention bounds the table. Segments older than the capture's
// own retention are pruned and can never be trimmed from, so their frame
// times cannot be asked for either. The margin over that retention covers a
// trim that is still finishing as its segments age out.
const frameClockRetention = 12 * time.Minute

// frameClock maps a position in ffmpeg's media timeline back to the wall
// clock, from the times at which frames were handed to ffmpeg.
type frameClock struct {
	mu sync.Mutex

	// session identifies which capture session these times belong to. A
	// trim can finish after the capture has restarted - a settings change
	// or a recovery from failure both begin a new session - and answering
	// from the wrong session's table would be worse than not answering.
	session time.Time

	fps   int
	first uint64      // frame index of times[0]
	times []time.Time // times[i] is when frame first+i went to ffmpeg
}

func (fc *frameClock) reset(fps int, session time.Time) {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.session = session
	fc.fps = fps
	fc.first = 0
	fc.times = fc.times[:0]
}

// mark records that one frame has been written to ffmpeg at time at. It is
// called for every frame, including the repeats that keep the stream at a
// constant rate while the screen is static - those occupy media time like
// any other frame and must be counted.
func (fc *frameClock) mark(at time.Time) {
	fc.mu.Lock()
	defer fc.mu.Unlock()

	fc.times = append(fc.times, at)

	limit := fc.retainedFrames()
	if len(fc.times) <= limit {
		return
	}
	// Drop in blocks so the copy cost is amortised rather than paid per frame.
	drop := len(fc.times) - limit
	if drop < limit/4 {
		drop = limit / 4
	}
	if drop >= len(fc.times) {
		drop = len(fc.times) - 1
	}
	fc.times = append(fc.times[:0], fc.times[drop:]...)
	fc.first += uint64(drop)
}

func (fc *frameClock) retainedFrames() int {
	fps := fc.fps
	if fps <= 0 {
		fps = 60
	}
	return fps * int(frameClockRetention/time.Second)
}

// wallAt returns when the frame at the given media offset was written.
//
// Reports false when the session does not match, when nothing was recorded,
// or when the offset falls outside the frames still held - guessing past
// either edge would reintroduce what this replaces.
func (fc *frameClock) wallAt(session time.Time, media time.Duration) (time.Time, bool) {
	fc.mu.Lock()
	defer fc.mu.Unlock()

	if fc.fps <= 0 || len(fc.times) == 0 || media < 0 {
		return time.Time{}, false
	}
	if !fc.session.Equal(session) {
		return time.Time{}, false
	}

	index := int64(media.Seconds()*float64(fc.fps) + 0.5)
	if index < 0 || uint64(index) < fc.first {
		return time.Time{}, false
	}
	offset := uint64(index) - fc.first
	if offset >= uint64(len(fc.times)) {
		return time.Time{}, false
	}
	return fc.times[offset], true
}

// FrameWallClock exposes the frame clock to the run store. It is deliberately
// not part of the Provider interface: a platform without frame-level capture
// timing simply does not have this method, and the caller falls back to the
// old assumption rather than every platform having to implement a stub.
func (c *captureWin) FrameWallClock(session time.Time, media time.Duration) (time.Time, bool) {
	return c.frames.wallAt(session, media)
}
