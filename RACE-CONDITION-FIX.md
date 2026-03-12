# Race Condition Fix - pi-talk

## Problem

Users experienced audio playing **twice simultaneously**, creating an annoying overlapping voice effect. Error messages showed:

```
pi-talk error: Error: Command failed: afplay "/var/folders/.../pi-talk-179418ef-98e6-4fdc-9d89-5b4d26cb0d20.wav"
  signal: 'SIGTERM'
```

## Root Cause

The extension used a **single `currentProcess` variable** to track both:
1. The `speakturbo` audio generation process
2. The `afplay` audio playback process

### The Race Flow

```
Time 0: speakChunk(A) starts
  → generationProcess = speakturbo PID 100

Time 1: Audio generation completes
  → playbackProcess = afplay PID 200 (overwrites generationProcess!)

Time 2: User sends new message
  → turn_start event → stopAudio() called
  → Kills playbackProcess (PID 200) with SIGTERM

Time 3: speakChunk(B) starts
  → generationProcess = speakturbo PID 300

Time 4: speakChunk(B) starts playback
  → playbackProcess = afplay PID 400

Time 5: PID 200 (afplay) STILL RUNNING
  → SIGTERM was async or didn't complete in time

Result: TWO afplay processes playing simultaneously! 🔊🔊
```

### Why This Happened

1. **Overwritten reference**: `currentProcess` was reassigned after generation completed
2. **Async kill**: `kill()` is non-blocking, so the old afplay might still be playing
3. **No cleanup**: No mechanism to find and kill orphaned afplay processes

## Solution

### 1. Separate Process Tracking

**Before:**
```typescript
let currentProcess = null;

async function speakChunk(text: string): Promise<void> {
    // Generate
    await new Promise<void>((resolve, reject) => {
        const proc = exec(command, ...);
        currentProcess = proc;  // ← Points to generation
    });

    // Play
    await new Promise<void>((resolve, reject) => {
        const playProc = exec(`${AUDIO_PLAYER} "${audioFile}"`, ...);
        currentProcess = playProc;  // ← Overwrites! Lost generation ref
    });
}

function stopAudio(): void {
    if (currentProcess) {
        currentProcess.kill();  // ← Only kills one, not both
        currentProcess = null;
    }
}
```

**After:**
```typescript
let generationProcess: any = null;
let playbackProcess: any = null;

async function speakChunk(text: string): Promise<void> {
    // Generate
    await new Promise<void>((resolve, reject) => {
        const proc = exec(command, ...);
        generationProcess = proc;
    });

    // Play
    await new Promise<void>((resolve, reject) => {
        const playProc = exec(`${AUDIO_PLAYER} "${audioFile}"`, ...);
        playbackProcess = playProc;
    });
}

function stopAudio(): void {
    // Kill generation
    if (generationProcess) {
        generationProcess.kill("SIGTERM");
        generationProcess = null;
    }

    // Kill playback
    if (playbackProcess) {
        playbackProcess.kill("SIGTERM");
        playbackProcess = null;
    }

    // Defensive cleanup
    exec(`pkill -f "${AUDIO_PLAYER} .*pi-talk-"`, ...);
}
```

### 2. Defensive Cleanup

Added a **safety net** that kills any stray afplay processes matching the pi-talk pattern:

```typescript
// Also kill any stray afplay processes (defensive cleanup)
try {
    const { exec } = require("node:child_process");
    exec(`pkill -f "${AUDIO_PLAYER} .*pi-talk-"`, { shell: true }, () => {});
} catch (e) {
    // Ignore cleanup errors
}
```

This ensures that even if:
- Process tracking fails
- `kill()` is async and doesn't complete in time
- References become stale

...we still clean up orphaned audio processes.

### 3. Proper Error Handling

Both processes are now set to `null` in the `catch` block:

```typescript
} catch (e) {
    generationProcess = null;
    playbackProcess = null;  // ← Both cleaned up on error
    throw e;
}
```

## Testing

### Manual Test

```bash
# Start pi with pi-talk enabled
pi --talk

# Send rapid messages to trigger race condition
# Old behavior: Audio overlaps, two voices
# New behavior: Clean audio, no overlap
```

### Automated Test Scenario

1. Enable pi-talk: `/talk`
2. Start a long message
3. While audio is playing, send another message
4. **Old:** Both audios play simultaneously
5. **New:** First audio stops, second audio plays cleanly

## Files Changed

- `/Users/af/.pi/agent/extensions/pi-talk/index.ts`
  - Split `currentProcess` into `generationProcess` and `playbackProcess`
  - Enhanced `stopAudio()` to kill both processes
  - Added defensive `pkill` cleanup
  - Improved error handling in `speakChunk()`

## Related Issues

- Error: `signal: 'SIGTERM'` when afplay was killed mid-playback
- Two voices overlapping
- Audio continuing after new messages

## Prevention

To prevent similar race conditions in the future:

1. **Always track async resources separately** - Don't reuse variables
2. **Use defensive cleanup** - Assume processes might not die when told
3. **Kill with specific signals** - Use `SIGTERM` not `SIGKILL` (allows cleanup)
4. **Set references to null** - Prevent dangling references
5. **Add safety nets** - Use `pkill` patterns for cleanup

## Performance Impact

- **Minimal**: Two extra variable assignments
- **Negligible**: `pkill` only runs on stop (rare)
- **Benefit**: Eliminates annoying double-audio bug
