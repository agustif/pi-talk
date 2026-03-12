# Changelog

## [Unreleased]

### Changed
- Renamed the npm package from `@agustif/pi-talk` to unscoped `pi-talk`
- Added role-specific voices for talk, thinking, and tool announcements
- Added hidden-thinking TLDR playback and tool-call announcement toggles

### Fixed
- Fixed text being swallowed and not appearing/speaking in TUI
  - Root cause: `message_end` handler was calling `stopAudio()` which killed ongoing speech
  - Solution: Added `isMessageComplete` flag to track streaming state
  - Removed `stopAudio()` call from `message_end` - let streaming finish naturally
  - `message_end` now waits for ongoing speech to finish before speaking remaining buffer
  - Prevents `scheduleSpeak()` from executing after message completes
- Fixed race condition causing audio to play twice simultaneously
  - Root cause: Single `currentProcess` variable was overwritten, causing afplay processes to not be properly killed
  - Solution: Track `generationProcess` and `playbackProcess` separately, kill both in `stopAudio()`
  - Added defensive cleanup: kill any stray afplay processes matching pi-talk pattern
- Fixed `--talk` flag not auto-enabling TTS on startup
  - Now checks `pi.getFlag("talk")` in the `ready` event
- Removed all console.log/error calls to prevent TUI pollution
  - Errors now logged to /tmp/pi-talk.log instead
- Fixed "pi-talk error" messages appearing in TUI when processes are killed
  - Added `stopRequested` flag to distinguish intentional kills from real errors
  - Added error event handlers to suppress uncaught process errors
  - SIGTERM errors are now treated as success (expected behavior when stopping)
