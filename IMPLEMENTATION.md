# pi-talk - Implementation Notes

## What We Did

1. **Created `/Users/af/.pi/agent/extensions/pi-talk/`** - A fresh, simple TTS extension
2. **Removed old complex extensions**:
   - Deleted `/Users/af/.pi/agent/extensions/tts/` (had only empty directories)
   - Deleted `/Users/af/.pi/agent/extensions/audio-tts/` (empty placeholder)
3. **Fixed skill documentation** - Removed reference to non-existent `speak` skill

## Key Design Decisions

### Philosophy

| Goal | Implementation |
|------|----------------|
| Simplicity | 258 lines vs 400+ in previous versions |
| Reliability | Minimal state, no complex pipelines |
| Natural speech | Sentence boundary detection |
| Cross-platform | `afplay` on macOS, `play` on Linux |
| Clean | Automatic temp file cleanup |

### What Works Well

✅ **Sentence-based chunking**: Waits for `.!?` followed by space - natural pauses

✅ **100ms accumulation**: Quick enough to feel instant, allows grouping for efficiency

✅ **No complex pipelines**: Direct generate → play, no parallel queues

✅ **Let audio continue during tool calls**: Natural flow, no interruption

✅ **File cleanup**: Tracks all temp files, deletes on turn_end or exit

✅ **Cross-platform**: Detects OS and uses correct audio player

✅ **Simple state**: Just `enabled`, `currentVoice`, `buffer`, `isSpeaking`

### What We Removed from Previous Versions

❌ Word highlighting overlay (too complex, rarely used)
❌ Session storage (unnecessary for simple TTS)
❌ Rewind/skip controls (overkill)
❌ Parallel generation queues (complexity without benefit)
❌ Multiple buffer layers (confusing)
❌ State machines (keep it simple)

## File Structure

```
pi-talk/
├── index.ts          # Main extension (258 lines)
├── package.json      # NPM metadata
└── README.md         # User documentation
```

## Commands

| Command | Action |
|---------|--------|
| `/talk` | Toggle TTS on/off |
| `/voice <name>` | Set voice |
| `Ctrl+Alt+T` | Toggle TTS |
| `Ctrl+Alt+V` | Cycle voices |

## Voices

- `alba` (female, default)
- `marius` (male)
- `javert` (male)
- `jean` (male)
- `fantine` (female)
- `cosette` (female)
- `eponine` (female)
- `azelma` (female)

## Comparison with Previous Versions

| Metric | v1-v6 | pi-talk |
|--------|-------|---------|
| Lines | 260-440 | 258 |
| Features | Word highlighting, rewind, session storage | Speak sentences |
| Complexity | High (multiple buffers, pipelines) | Low (single buffer) |
| Reliability | Medium | High |
| Maintenance effort | High | Low |

## How It Works

1. **Accumulate**: Text streams into buffer as `message_update` fires
2. **Schedule**: After 100ms of no new text, check for sentence boundary
3. **Chunk**: Extract text up to sentence boundary (`.`, `!`, `?` + space)
4. **Generate**: Call `speakturbo` to create WAV file
5. **Play**: Use OS audio player to speak
6. **Repeat**: Check buffer for more sentences
7. **Cleanup**: Delete temp files on turn end

## Testing

```bash
# Test basic functionality
pi --talk

# Test voice change
/voice marius

# Test toggle (Ctrl+Alt+T)
/voice jean

# Verify files are cleaned up
ls /tmp/pi-talk-*.wav  # Should be empty after turn ends
```

## Future Enhancements (If Needed)

1. **State persistence**: Save `enabled` and `currentVoice` to session
2. **Volume control**: Add `/volume` command
3. **Speed control**: Add rate adjustment via speakturbo flags
4. **Emotion markers**: Support `[laugh]`, `[sigh]` tags

But the goal is **minimalism** - only add if genuinely useful.
