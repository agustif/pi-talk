# pi-talk

Streaming text-to-speech for the [Pi coding agent](https://github.com/badlogic/pi-mono), with separate voices for normal replies, visible thinking, hidden-thinking summaries, and tool-call announcements.

`pi-talk` is built for live terminal use. It speaks as text streams in, cleans up Markdown before sending it to TTS, flushes thinking before tool execution, and can use distinct voices so you can hear whether Pi is answering, reasoning, or acting.

## Features

- Streaming speech for normal assistant text via `text_delta`
- Visible-thinking narration via `thinking_delta`
- Hidden-thinking TLDR playback when full thinking is not being read aloud
- Brief tool-call announcements for `read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`, and custom tools
- Role-specific voices:
  - talk voice
  - thinking voice
  - tools voice
- Markdown-to-speech cleanup for links, emphasis, headings, code fences, inline code, lists, and blockquotes
- Sentence-aware chunking with queue-based playback so mixed text/thinking/tool boundaries do not get swallowed
- Auto-started `speakturbo` daemon with temp-file cleanup after playback

## Installation

### Local extension folder

Copy this repo into one of Pi's extension discovery locations:

```bash
# Global
~/.pi/agent/extensions/pi-talk

# Project-specific
.pi/extensions/pi-talk
```

### Git repository

After this repository has its first pushed commit, the intended install target is:

```bash
pi install git:github.com/agustif/pi-talk
```

### npm package

Package metadata is prepared as `pi-talk`, and the intended install target is:

```bash
pi install npm:pi-talk
```

## Quick Start

Enable the extension and test speech:

```bash
/talk
/talk-test
```

Recommended first-run setup:

```bash
/voice talk alba
/voice thinking cosette
/voice tools javert
```

Then toggle the optional behaviors you want:

```bash
/talk-thinking   # visible thinking aloud on/off
/talk-tldr       # hidden-thinking summary on/off
/talk-tools      # tool-call announcements on/off
```

## Commands

| Command | Purpose |
| --- | --- |
| `/talk` | Toggle `pi-talk` on or off |
| `/talk-test` | Generate a short test phrase |
| `/talk-thinking` | Toggle visible-thinking narration |
| `/talk-tldr` | Toggle hidden-thinking TLDR playback |
| `/talk-tools` | Toggle tool-call announcements |
| `/voice list` | Show the available voices and current role mapping |
| `/voice <name>` | Set all voices to the same voice |
| `/voice talk <name>` | Set the normal reply voice |
| `/voice thinking <name>` | Set the visible-thinking and TLDR voice |
| `/voice tools <name>` | Set the tool-announcement voice |

## Shortcuts

| Shortcut | Purpose |
| --- | --- |
| `Ctrl+Alt+T` | Toggle `pi-talk` |
| `Ctrl+Alt+V` | Cycle the talk voice |

## Voice Routing

By default, `pi-talk` uses:

| Role | Default voice |
| --- | --- |
| Talk | `alba` |
| Thinking | `cosette` |
| Tools | `javert` |

This separation makes it easier to distinguish:

- standard assistant output
- visible reasoning text
- hidden-thinking summaries
- tool execution announcements

If you prefer a single narrator, run:

```bash
/voice alba
```

## How It Works

1. Pi streams `text_delta` and `thinking_delta` events.
2. `pi-talk` accumulates text in short windows and waits for natural sentence boundaries.
3. Markdown is normalized before TTS so speech sounds natural instead of reading formatting punctuation.
4. When the stream changes mode from thinking to normal text, or when a tool call starts, buffered speech is flushed instead of being stranded.
5. If visible thinking is disabled but TLDR mode is enabled, `pi-talk` summarizes the hidden reasoning heuristically and speaks a compact summary.
6. Tool announcements are queued into the same playback pipeline, using the tool voice.
7. `speakturbo` generates audio to a temp WAV file and the local audio player plays it immediately.

## Requirements

`pi-talk` expects:

- Pi with extension support
- `speakturbo` CLI installed at `~/.local/bin/speakturbo`
- `python3 -m speakturbo.daemon_streaming` available for daemon startup
- macOS `afplay` or Linux `play`

The current extension is optimized for Pi's streaming event model:

- `text_delta`
- `thinking_delta`
- `tool_call`

## Behavior Notes

### Visible thinking

When `/talk-thinking` is enabled, visible reasoning is spoken live using the thinking voice.

### Hidden thinking

When `/talk-thinking` is disabled and `/talk-tldr` is enabled, `pi-talk` accumulates hidden reasoning and speaks a short summary instead of the full block.

### Tool announcements

When `/talk-tools` is enabled, Pi briefly announces what it is about to do. Examples:

- `Reading /path/to/file`
- `Editing /path/to/file`
- `Running bash command ...`
- `Searching for pattern`

### Markdown cleanup

`pi-talk` strips or flattens:

- emphasis markers
- headings
- blockquotes
- list bullets
- links
- fenced code blocks
- inline code

This keeps the spoken output much closer to what a human would say aloud.

## Troubleshooting

### No audio

Check the daemon health:

```bash
curl http://127.0.0.1:7125/health
```

Then verify the binary path:

```bash
ls -l ~/.local/bin/speakturbo
```

### Wrong voice mapping

Show the current voice assignments:

```bash
/voice list
```

### Thinking still feels delayed

The extension already flushes buffered thinking at text/tool boundaries, but you can make the distinction clearer by assigning a more contrasting thinking voice:

```bash
/voice thinking eponine
```

### Debug event logging

Set:

```bash
PI_TALK_DEBUG=1
```

Then inspect:

- `/tmp/pi-talk.log`
- `/tmp/pi-talk-events.log`

## Repository Contents

| File | Purpose |
| --- | --- |
| `index.ts` | Main extension |
| `CHANGELOG.md` | Release notes |
| `IMPLEMENTATION.md` | Internal implementation notes |
| `STREAMING.md` | Streaming behavior notes |
| `RACE-CONDITION-FIX.md` | Historical fix notes |
| `TEXT-SWALLOW-FIX.md` | Historical buffering fix notes |
| `DEBUG.md` | Debugging notes |
| `test-streaming.cjs` | Simple local streaming test helper |

## Status

This repository is prepared as a standalone `pi-talk` package and GitHub repo.
