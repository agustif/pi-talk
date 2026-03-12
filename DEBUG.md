# Debug Guide - pi-talk

## The Problem: No Audio

The speakturbo daemon wasn't running. The Rust CLI (`~/.local/bin/speakturbo`) expects the daemon to be started.

## Solution: Auto-Start Daemon

Added `ensureDaemon()` function that:
1. Checks if daemon is running on port 7125
2. If not, starts it with: `nohup python3 -m speakturbo.daemon_streaming > /tmp/speakturbo-daemon.log 2>&1 &`
3. Waits up to 5 seconds for daemon to be ready

## How to Test

### 1. Verify Daemon
```bash
curl http://127.0.0.1:7125/health
# Should return: {"status":"ready","voices":[...]}
```

### 2. Test CLI Directly
```bash
~/.local/bin/speakturbo "Hello world"
# You should hear audio
```

### 3. Test Extension
```bash
pi
/talk-test
# Should play: "This is a test of pi talk..."
```

### 4. Test Full Flow
```bash
pi
/talk
# Then type anything - should hear it spoken
```

## Daemon Logs

```bash
# View daemon logs
cat /tmp/speakturbo-daemon.log

# Check if daemon process is running
ps aux | grep daemon_streaming

# Check port is listening
lsof -i :7125
```

## Manual Daemon Control

```bash
# Start manually
nohup python3 -m speakturbo.daemon_streaming > /tmp/speakturbo-daemon.log 2>&1 &

# Stop
pkill -f daemon_streaming

# Restart
pkill -f daemon_streaming
nohup python3 -m speakturbo.daemon_streaming > /tmp/speakturbo-daemon.log 2>&1 &
```

## Common Issues

### "Daemon not running?"
- Daemon auto-starts on first use
- Check logs: `cat /tmp/speakturbo-daemon.log`
- Ensure python3 is in PATH
- Ensure pocket-tts is installed: `pip list | grep pocket-tts`

### No audio even though daemon is running
- Check audio system: play a test file with `afplay /tmp/test.wav`
- Check volume: macOS system volume or `osascript -e 'set volume output volume 100'`
- Check temp files are being created: `ls /tmp/pi-talk-*.wav`

### Audio is choppy or delayed
- This is expected for streaming TTS
- First sentence has ~2-3s delay (daemon startup)
- Subsequent sentences are ~90-200ms

## Architecture

```
pi-talk (TypeScript extension)
    │
    │ Calls ensureDaemon()
    ▼
python3 -m speakturbo.daemon_streaming (FastAPI, port 7125)
    │
    │ HTTP GET /tts?text=...&voice=...
    ▼
pocket-tts (Python TTS model)
    │
    │ Returns WAV audio stream
    ▼
afplay (macOS) or play (Linux)
    │
    ▼
Speakers
```

## Files Created During Runtime

- `/tmp/pi-talk-{uuid}.wav` - Temporary audio files (deleted on cleanup)
- `/tmp/speakturbo-daemon.log` - Daemon logs
- `nohup.out` - No output file (daemon handles its own logging)

## Performance

| Metric | Value |
|--------|-------|
| Daemon startup | ~3s (first time) |
| Per-sentence latency | ~90-200ms |
| Audio generation | ~40ms per frame |
| Real-time factor | ~4x faster than real-time |
