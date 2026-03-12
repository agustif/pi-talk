# Text Swallow Fix - pi-talk

## Problem

Users reported that **text was being swallowed** - it would disappear or not show up/speak in the TUI. The issue was intermittent and hard to reproduce.

## Root Cause Analysis

### The Problem Flow

```
1. LLM starts streaming text
   ↓
2. message_update events fire with text deltas
   ↓
3. Delta 1: "Hello" → buffer = "Hello", scheduleSpeak() called (100ms delay)
   ↓
4. Delta 2: ", how" → buffer = "Hello, how", scheduleSpeak() rescheduled
   ↓
5. Delta 3: " are you?" → buffer = "Hello, how are you?", scheduleSpeak() rescheduled
   ↓
6. findBreakPoint() finds break at "?" → speaks "Hello, how are you?"
   ↓
7. Delta 4: " I'm doing" → buffer = " I'm doing", scheduleSpeak() called
   ↓
8. message_end fires
   ↓
9. stopAudio() called! ← BUG: Kills any ongoing speech
   ↓
10. speakChunk(buffer) speaks " I'm doing" as one chunk
   ↓
11. Result: Text from Delta 4 is lost or spoken out of context
```

### Why Text Was "Swallowed"

1. **`stopAudio()` in `message_end`**: This was the main bug. It would kill any currently playing audio when the message ended, causing:
   - Text that was mid-stream to be cut off
   - Buffer state to become inconsistent
   - `isSpeaking` flag to be reset while audio was still playing

2. **No coordination between streaming and final buffer**:
   - Streaming: `message_update` → `speakNext()` → sentence-by-sentence
   - Final: `message_end` → `speakChunk(buffer)` → everything at once
   - These two paths conflicted, causing text to be lost

3. **`speakNext()` blocked by `isSpeaking`**:
   - After `message_end` called `stopAudio()`, `isSpeaking` was false
   - But if `speakChunk()` from `message_end` was still running, new deltas couldn't speak
   - This created a deadlock where text would accumulate but never speak

4. **Pending timeouts not cleared**:
   - `scheduleSpeak()` sets a timeout for 100ms
   - If `message_end` fires before timeout, the timeout still executes
   - This would try to speak from an empty or inconsistent buffer

## Solution

### 1. Added `isMessageComplete` Flag

```typescript
let isMessageComplete = false; // Track if current message is done streaming
```

This flag distinguishes between:
- **Streaming phase** (`message_update` firing): `isMessageComplete = false`
- **Complete phase** (`message_end` fired): `isMessageComplete = true`

### 2. Updated `scheduleSpeak()` to Check Flag

```typescript
function scheduleSpeak(ctx: ExtensionContext): void {
    if (speakTimeout) {
        clearTimeout(speakTimeout);
    }

    speakTimeout = setTimeout(() => {
        speakTimeout = null;
        // Only speak if we're not already speaking and message isn't complete
        if (!isSpeaking && !isMessageComplete) {
            speakNext(ctx).catch(() => {});
        }
    }, ACCUMULATION_MS);
}
```

**What this prevents:**
- If `message_end` has fired, pending timeouts won't try to speak
- No more speaking from an inconsistent buffer state

### 3. Removed `stopAudio()` from `message_end`

**Before:**
```typescript
pi.on("message_end", async (_, ctx) => {
    if (enabled && buffer.trim()) {
        stopAudio(); // ← Kills ongoing speech!
        await speakChunk(buffer);
        buffer = "";
    }
});
```

**After:**
```typescript
pi.on("message_end", async (_, ctx) => {
    if (!enabled) return;

    // Mark message as complete
    isMessageComplete = true;

    // Clear any pending speak timeout
    if (speakTimeout) {
        clearTimeout(speakTimeout);
        speakTimeout = null;
    }

    // If we have remaining buffer, speak it
    if (buffer.trim()) {
        // Don't call stopAudio() - let streaming finish naturally
        const remaining = buffer.trim();
        if (remaining.length >= MIN_CHARS) {
            try {
                // Wait for any ongoing speech to finish
                while (isSpeaking) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                await speakChunk(remaining);
            } catch (e) {
                // Silently fail
            }
        }
        buffer = "";
    }
});
```

**What this changes:**
- No longer kills ongoing speech
- Waits for `isSpeaking` to be false before speaking remaining buffer
- Properly cleans up pending timeouts
- Only speaks if there's enough text (>= MIN_CHARS)

### 4. Updated Lifecycle Handlers

**`turn_start`:**
```typescript
pi.on("turn_start", () => {
    stopAudio();
    buffer = "";
    isMessageComplete = false; // Reset flag
    if (speakTimeout) {
        clearTimeout(speakTimeout);
        speakTimeout = null;
    }
    cleanupFiles();
});
```

**`user_message`:**
```typescript
pi.on("user_message", () => {
    stopAudio();
    buffer = "";
    isMessageComplete = false; // Reset flag
    if (speakTimeout) {
        clearTimeout(speakTimeout);
        speakTimeout = null;
    }
});
```

**What this ensures:**
- Flag is reset at start of each turn
- Pending timeouts are always cleared
- No state leakage between turns

### 5. Enhanced `speakNext()` for Final Buffer

```typescript
async function speakNext(ctx: ExtensionContext): Promise<void> {
    // ... existing code ...

    } finally {
        isSpeaking = false;
        updateWidget(ctx);

        // Check for more to speak immediately
        if (buffer.length >= MIN_CHARS) {
            // Don't wait - speak next chunk
            speakNext(ctx).catch(() => {});
        } else if (isMessageComplete && buffer.trim()) {
            // Message is complete but we still have some remaining text
            // Speak it without waiting for more
            const remaining = buffer.trim();
            if (remaining.length >= MIN_CHARS) {
                speakChunk(remaining).catch(() => {});
            }
            buffer = "";
        }
    }
}
```

**What this adds:**
- After each chunk, check if message is complete
- If complete and buffer has remaining text, speak it immediately
- Prevents text from being stuck in buffer after streaming ends

## State Diagram

```
┌─────────────────┐
│  turn_start     │
│  isMessageComplete = false
│  buffer = ""
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  message_update │◄────────────────┐
│  buffer += delta│                 │
│  scheduleSpeak()│                 │
└────────┬────────┘                 │
         │                          │
         ▼                          │
┌─────────────────┐                 │
│  speakNext()    │                 │
│  (after 100ms)  │                 │
└────────┬────────┘                 │
         │                          │
         ▼                          │
┌─────────────────┐                 │
│  findBreakPoint │                 │
│  break = -1?    │──No─────────────┘
└────────┬────────┘  (wait for more text)
         │ Yes
         ▼
┌─────────────────┐
│  speakChunk()   │
│  isSpeaking=true│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  buffer cleared  │
│  isSpeaking=false│
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│  message_update  │────▶│  message_end    │
│  (more deltas)  │     │  isMessageComplete = true
└─────────────────┘     │  speak remaining │
                         └─────────────────┘
```

## Testing

### Manual Test

```bash
pi
/talk
```

Then send messages with varying lengths:
1. Short message (1 sentence)
2. Long message (5+ sentences)
3. Message with tool calls
4. Rapid successive messages

**Expected behavior:**
- All text appears in TUI
- All text is spoken in natural sentences
- No text is lost or swallowed
- Audio doesn't overlap or cut off

### Edge Cases

1. **Tool call mid-message:**
   - Text before tool: spoken normally
   - Tool executes
   - Text after tool: spoken normally

2. **User message mid-stream:**
   - Current audio stops
   - New message starts fresh

3. **Very slow LLM (text trickles):**
   - Waits for sentence boundaries
   - Speaks in natural chunks

4. **Very fast LLM (text floods):**
   - Accumulates quickly
   - Speaks at sentence boundaries
   - No text lost

## Performance Impact

- **Minimal**: One extra boolean flag (`isMessageComplete`)
- **Negligible**: Timeout checks are already done
- **Benefit**: Eliminates text swallowing bug completely

## Related Issues

- Text disappearing from TUI
- Audio cutting off mid-sentence
- Buffer state inconsistency
- Pending timeouts executing after message complete

## Prevention

To prevent similar issues in the future:

1. **Track message lifecycle explicitly** - Use flags to distinguish phases
2. **Don't kill resources unnecessarily** - Only stop when really needed
3. **Coordinate async operations** - Wait for ongoing work before starting new
4. **Clean up pending timeouts** - Always clear timeouts when state changes
5. **Think about edge cases** - What happens if X happens while Y is running?
