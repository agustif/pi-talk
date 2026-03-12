/**
 * pi-talk - Simple TTS extension that just works
 *
 * Philosophy:
 * - Minimal code, maximum reliability
 * - Speak naturally at sentence boundaries
 * - Quick but not choppy (100ms accumulation)
 * - Cross-platform audio playback
 * - Clean up after itself
 * - Optional thinking block reading
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";

const VOICES = ["alba", "marius", "javert", "jean", "fantine", "cosette", "eponine", "azelma"] as const;
type Voice = typeof VOICES[number];

// State (encapsulated in an object for cleaner management)
interface TalkState {
	enabled: boolean;
	responseVoice: Voice;
	thinkingVoice: Voice;
	toolVoice: Voice;
	readThinking: boolean; // Whether to read thinking blocks aloud
	announceTools: boolean;
	generateThinkingTldr: boolean;
	buffer: string;
	bufferKind: "text" | "thinking" | null;
	hiddenThinkingBuffer: string;
	speechQueue: Array<{ text: string; allowShort: boolean; voice: Voice }>;
	isSpeaking: boolean;
	generationProcess: ReturnType<typeof import("node:child_process").exec> | null;
	playbackProcess: ReturnType<typeof import("node:child_process").exec> | null;
	tempFiles: string[];
	speakTimeout: NodeJS.Timeout | null;
	stopRequested: boolean;
	isMessageComplete: boolean;
}

const state: TalkState = {
	enabled: false,
	responseVoice: "alba",
	thinkingVoice: "cosette",
	toolVoice: "javert",
	readThinking: true, // Default to reading thinking
	announceTools: true,
	generateThinkingTldr: true,
	buffer: "",
	bufferKind: null,
	hiddenThinkingBuffer: "",
	speechQueue: [],
	isSpeaking: false,
	generationProcess: null,
	playbackProcess: null,
	tempFiles: [],
	speakTimeout: null,
	stopRequested: false,
	isMessageComplete: false,
};

// Config
const ACCUMULATION_MS = 100; // Quick grouping, feels instant
const MIN_CHARS = 30; // Don't speak tiny chunks

// Cross-platform audio player
const AUDIO_PLAYER = process.platform === "darwin" ? "afplay" : "play";

// Daemon URL
const DAEMON_URL = "http://127.0.0.1:7125";
let daemonStarted = false;
let daemonStarting = false; // Prevent concurrent daemon starts

/**
 * Find natural break point in text
 * Priority: sentence endings (. ! ?) > commas (,) > length (150 chars)
 */
function findBreakPoint(text: string): number {
	// 1. Sentence endings (. ! ?) - but avoid breaking on abbreviations
	const sentenceEnders = [".", "!", "?"];
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (sentenceEnders.includes(char)) {
			const next = text[i + 1];
			// Must be followed by space/newline/end
			if (!next || next === " " || next === "\n") {
				// Check it's not an abbreviation (single capital letter before)
				const prev = text[i - 1];
				if (prev && prev === prev.toUpperCase() && prev !== prev.toLowerCase() && i > 0) {
					// Likely an abbreviation like "Mr." or "Dr." - skip
					continue;
				}
				return i + 1;
			}
		}
	}

	// 2. Commas (clauses) - better than waiting too long
	for (let i = 0; i < text.length; i++) {
		if (text[i] === ",") {
			const next = text[i + 1];
			if (!next || next === " ") {
				return i + 1;
			}
		}
	}

	// 3. If we have enough text and it's been accumulating, break at last space
	if (text.length >= 150) {
		const spaceIndex = text.lastIndexOf(" ", 150);
		if (spaceIndex > 50) {
			return spaceIndex;
		}
	}

	// 4. Don't break yet
	return -1;
}

function normalizeSpeechText(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, " $1 ")
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, " $1 ")
		.replace(/```([\s\S]*?)```/g, (_, code: string) => ` ${code.replace(/\s+/g, " ")} `)
		.replace(/`([^`]+)`/g, " $1 ")
		.replace(/(^|\n)\s{0,3}#{1,6}\s+/g, "$1")
		.replace(/(^|\n)\s*>\s?/g, "$1")
		.replace(/(^|\n)\s*[-*+]\s+/g, "$1")
		.replace(/(^|\n)\s*\d+\.\s+/g, "$1")
		.replace(/(\*\*|__|\*|_|~~)/g, "")
		.replace(/\|/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function summarizeThinking(text: string): string | null {
	const normalized = normalizeSpeechText(text);
	if (!normalized) return null;

	const sentences = normalized
		.match(/[^.!?]+[.!?]?/g)
		?.map((sentence) => sentence.trim())
		.filter(Boolean) ?? [];

	if (sentences.length === 0) {
		return normalized.length > 220 ? `${normalized.slice(0, 217).trimEnd()}...` : normalized;
	}

	let summary = sentences[0]!;
	const lastSentence = sentences.at(-1);
	if (lastSentence && lastSentence !== summary) {
		const combined = `${summary} ${lastSentence}`;
		summary = combined.length <= 260 ? combined : summary;
	}

	if (summary.length > 260) {
		summary = `${summary.slice(0, 257).trimEnd()}...`;
	}

	return `Thinking summary. ${summary}`;
}

function voiceForBufferKind(kind: TalkState["bufferKind"]): Voice {
	if (kind === "thinking") return state.thinkingVoice;
	return state.responseVoice;
}

function queueSpeech(text: string, ctx: ExtensionContext, allowShort = false, voice: Voice = state.responseVoice): void {
	const normalized = normalizeSpeechText(text);
	if (!normalized) return;
	if (!allowShort && normalized.length < MIN_CHARS) return;
	state.speechQueue.push({ text: normalized, allowShort, voice });
	drainSpeechQueue(ctx).catch(() => {});
}

function extractBufferedSpeech(force = false): { text: string; allowShort: boolean; voice: Voice } | null {
	const rawBuffer = state.buffer.trim();
	if (!rawBuffer) {
		state.buffer = "";
		state.bufferKind = null;
		return null;
	}

	const voice = voiceForBufferKind(state.bufferKind);

	if (!force) {
		const breakPoint = findBreakPoint(state.buffer);
		if (breakPoint === -1) return null;

		const rawChunk = state.buffer.slice(0, breakPoint);
		const normalized = normalizeSpeechText(rawChunk);
		if (!normalized || normalized.length < MIN_CHARS) {
			return null;
		}

		state.buffer = state.buffer.slice(breakPoint);
		if (!state.buffer.trim()) {
			state.buffer = "";
			state.bufferKind = null;
		}
		return { text: normalized, allowShort: false, voice };
	}

	state.buffer = "";
	state.bufferKind = null;

	const normalized = normalizeSpeechText(rawBuffer);
	if (!normalized) return null;
	return { text: normalized, allowShort: true, voice };
}

function flushBufferedSpeech(ctx: ExtensionContext, allowShort = true): void {
	const queued = extractBufferedSpeech(true);
	if (!queued) return;
	state.speechQueue.push({ text: queued.text, allowShort, voice: queued.voice });
	drainSpeechQueue(ctx).catch(() => {});
}

function maybeQueueThinkingTldr(ctx: ExtensionContext): void {
	if (state.readThinking || !state.generateThinkingTldr || !state.hiddenThinkingBuffer.trim()) {
		state.hiddenThinkingBuffer = "";
		return;
	}

	const summary = summarizeThinking(state.hiddenThinkingBuffer);
	state.hiddenThinkingBuffer = "";
	if (!summary) return;
	queueSpeech(summary, ctx, true, state.thinkingVoice);
}

async function drainSpeechQueue(ctx: ExtensionContext): Promise<void> {
	if (state.isSpeaking) return;

	const next = state.speechQueue.shift();
	if (!next) return;
	if (!next.allowShort && next.text.length < MIN_CHARS) {
		await drainSpeechQueue(ctx);
		return;
	}

	state.isSpeaking = true;
	updateWidget(ctx);

	try {
		await speakChunk(next.text, next.voice);
	} finally {
		state.isSpeaking = false;
		updateWidget(ctx);

		if (state.speechQueue.length > 0) {
			drainSpeechQueue(ctx).catch(() => {});
			return;
		}

		const buffered = extractBufferedSpeech(false);
		if (buffered) {
			state.speechQueue.push(buffered);
			drainSpeechQueue(ctx).catch(() => {});
			return;
		}

		if (state.isMessageComplete) {
			const remaining = extractBufferedSpeech(true);
			if (remaining) {
				state.speechQueue.push(remaining);
				drainSpeechQueue(ctx).catch(() => {});
			}
		}
	}
}

function addStreamDelta(kind: "text" | "thinking", text: string, ctx: ExtensionContext): void {
	if (!text) return;

	if (kind === "text") {
		maybeQueueThinkingTldr(ctx);
	}

	if (state.bufferKind && state.bufferKind !== kind) {
		flushBufferedSpeech(ctx, true);
	}

	state.bufferKind = kind;
	state.buffer += text;
	scheduleSpeak(ctx);
}

function formatToolAnnouncement(event: { toolName: string; input: Record<string, unknown> }): string {
	const input = event.input ?? {};
	const path = typeof input.path === "string" ? input.path : undefined;
	const command = typeof input.command === "string" ? input.command : undefined;
	const pattern = typeof input.pattern === "string" ? input.pattern : undefined;

	switch (event.toolName) {
		case "read":
			return path ? `Reading ${path}.` : "Reading a file.";
		case "edit":
			return path ? `Editing ${path}.` : "Editing a file.";
		case "write":
			return path ? `Writing ${path}.` : "Writing a file.";
		case "bash":
			if (!command) return "Running a shell command.";
			return `Running bash command. ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`;
		case "grep":
			if (pattern && path) return `Searching ${path} for ${pattern}.`;
			if (pattern) return `Searching for ${pattern}.`;
			return "Searching files.";
		case "find":
			if (pattern) return `Finding files matching ${pattern}.`;
			return "Finding files.";
		case "ls":
			return path ? `Listing ${path}.` : "Listing files.";
		default:
			return `Using ${event.toolName}.`;
	}
}

function resetStreamingState(): void {
	state.buffer = "";
	state.bufferKind = null;
	state.hiddenThinkingBuffer = "";
	state.speechQueue = [];
	state.isMessageComplete = false;
	if (state.speakTimeout) {
		clearTimeout(state.speakTimeout);
		state.speakTimeout = null;
	}
}

/**
 * Ensure speakturbo daemon is running
 */
async function ensureDaemon(): Promise<void> {
	// Quick check if already running
	if (daemonStarted) {
		try {
			const response = await fetch(`${DAEMON_URL}/health`, { method: "GET" });
			if (response.ok) return;
		} catch {
			daemonStarted = false;
		}
	}

	// Prevent concurrent daemon starts
	if (daemonStarting) {
		// Wait for the other start attempt
		for (let i = 0; i < 40; i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (daemonStarted) return;
		}
		throw new Error("Daemon startup timed out");
	}

	daemonStarting = true;

	const { exec } = await import("node:child_process");

	// Start daemon in background
	exec("nohup python3 -m speakturbo.daemon_streaming > /tmp/speakturbo-daemon.log 2>&1 &", (error) => {
		if (error) {
			logError(`Failed to start daemon: ${error}`);
		}
	});

	// Wait for daemon to be ready
	for (let i = 0; i < 40; i++) {
		try {
			const response = await fetch(`${DAEMON_URL}/health`, { method: "GET" });
			if (response.ok) {
				daemonStarted = true;
				daemonStarting = false;
				return;
			}
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	daemonStarting = false;
	throw new Error("Failed to start speakturbo daemon");
}

/**
 * Log error to file (avoids TUI pollution)
 */
function logError(message: string): void {
	import("node:fs").then((fs) => {
		fs.appendFileSync("/tmp/pi-talk.log", `[${new Date().toISOString()}] ${message}\n`);
	}).catch(() => {});
}

function logDebugEvent(message: string): void {
	import("node:fs").then((fs) => {
		fs.appendFileSync("/tmp/pi-talk-events.log", `${message}\n`);
	}).catch(() => {});
}

/**
 * Generate audio and speak chunk
 */
async function speakChunk(text: string, voice: Voice = state.responseVoice): Promise<void> {
	await ensureDaemon();

	const crypto = await import("node:crypto");
	const os = await import("node:os");
	const { exec } = await import("node:child_process");

	const audioFile = `${os.tmpdir()}/pi-talk-${crypto.randomUUID()}.wav`;
	state.tempFiles.push(audioFile);

	const escaped = JSON.stringify(text.trim());
	const command = `~/.local/bin/speakturbo ${escaped} -v ${voice} -o ${audioFile} -q`;

	// Helper to check if error is from us killing the process
	const isKillError = (e: unknown): boolean => 
		state.stopRequested || 
		(e && typeof e === "object" && ("killed" in e || "signal" in e));

	try {
		// Generate audio
		await new Promise<void>((resolve, reject) => {
			const proc = exec(command, { shell: process.env.SHELL || "/bin/sh", timeout: 15000 }, (error) => {
				state.generationProcess = null;
				if (error && !isKillError(error)) reject(error);
				else resolve();
			});
			proc.on("error", (err) => {
				if (!isKillError(err)) {
					logError(`Generation error: ${err.message}`);
				}
			});
			state.generationProcess = proc;
		});

		// Play audio
		await new Promise<void>((resolve, reject) => {
			const playProc = exec(`${AUDIO_PLAYER} "${audioFile}"`, { shell: process.env.SHELL || "/bin/sh", timeout: 30000 }, (error) => {
				state.playbackProcess = null;
				if (error && !isKillError(error)) reject(error);
				else resolve();
			});
			playProc.on("error", (err) => {
				if (!isKillError(err)) {
					logError(`Playback error: ${err.message}`);
				}
			});
			state.playbackProcess = playProc;
		});
	} catch (e) {
		if (!isKillError(e)) {
			logError(`speakChunk error: ${e instanceof Error ? e.message : String(e)}`);
		}
	} finally {
		state.generationProcess = null;
		state.playbackProcess = null;
		// Clean up this specific temp file after playback
		try {
			const fs = await import("node:fs/promises");
			await fs.unlink(audioFile).catch(() => {});
			state.tempFiles = state.tempFiles.filter(f => f !== audioFile);
		} catch {}
	}
}

/**
 * Speak next chunk from buffer
 */
function scheduleSpeak(ctx: ExtensionContext): void {
	if (state.speakTimeout) {
		clearTimeout(state.speakTimeout);
	}

	state.speakTimeout = setTimeout(() => {
		state.speakTimeout = null;
		const buffered = extractBufferedSpeech(false);
		if (buffered) {
			state.speechQueue.push(buffered);
			drainSpeechQueue(ctx).catch(() => {});
		}
	}, ACCUMULATION_MS);
}

/**
 * Stop audio and clear state
 */
function stopAudio(): void {
	// Set flag BEFORE killing so error handlers know it's intentional
	state.stopRequested = true;

	// Kill generation process if running
	if (state.generationProcess) {
		try {
			state.generationProcess.kill("SIGTERM");
		} catch {}
		state.generationProcess = null;
	}

	// Kill playback process if running
	if (state.playbackProcess) {
		try {
			state.playbackProcess.kill("SIGTERM");
		} catch {}
		state.playbackProcess = null;
	}

	state.isSpeaking = false;
	if (state.speakTimeout) {
		clearTimeout(state.speakTimeout);
		state.speakTimeout = null;
	}

	// Reset flag after a short delay to allow error handlers to process
	setTimeout(() => {
		state.stopRequested = false;
	}, 100);
}

/**
 * Cleanup temporary audio files
 */
async function cleanupFiles(): Promise<void> {
	const fs = await import("node:fs/promises");
	await Promise.all(
		state.tempFiles.map((file) => fs.unlink(file).catch(() => {}))
	);
	state.tempFiles = [];
}

/**
 * Update status widget
 */
function updateWidget(ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setWidget("pi-talk", undefined);
		return;
	}

	const icon = state.isSpeaking ? "🔊" : "🔇";
	const indicators = [
		state.readThinking ? "🧠" : state.generateThinkingTldr ? "≈" : "",
		state.announceTools ? "🛠" : "",
	].join("");
	const voiceLabel = ctx.ui.theme.fg(
		"dim",
		`${state.responseVoice}/${state.thinkingVoice}/${state.toolVoice}${indicators}`
	);
	ctx.ui.setWidget("pi-talk", [`${icon} ${voiceLabel}`], { placement: "belowEditor" });
}

// Main extension
export default function piTalk(pi: ExtensionAPI) {
	pi.registerFlag("talk", {
		description: "Start with pi-talk enabled",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("talk", {
		description: "Toggle pi-talk on/off",
		handler: async (_, ctx) => {
			state.enabled = !state.enabled;
			ctx.ui.notify(`pi-talk ${state.enabled ? "enabled" : "disabled"}`, state.enabled ? "success" : "dim");
			updateWidget(ctx);
		},
	});

	pi.registerCommand("voice", {
		description: `Set voices. Usage: /voice <name> or /voice talk|thinking|tools <name>`,
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length === 0 || parts[0] === "list") {
				ctx.ui.notify(
					`Voices: ${VOICES.join(", ")}. Current: talk=${state.responseVoice}, thinking=${state.thinkingVoice}, tools=${state.toolVoice}`,
					"info"
				);
				return;
			}

			const applyVoice = (role: "talk" | "thinking" | "tools", voice: Voice) => {
				if (role === "thinking") {
					state.thinkingVoice = voice;
					return;
				}
				if (role === "tools") {
					state.toolVoice = voice;
					return;
				}
				state.responseVoice = voice;
			};

			if (parts.length === 1 && VOICES.includes(parts[0] as Voice)) {
				const voice = parts[0] as Voice;
				state.responseVoice = voice;
				state.thinkingVoice = voice;
				state.toolVoice = voice;
				ctx.ui.notify(`All voices: ${voice}`, "success");
				updateWidget(ctx);
				return;
			}

			if (parts.length === 2) {
				const role = parts[0]?.toLowerCase();
				const voice = parts[1];
				if ((role === "talk" || role === "response" || role === "thinking" || role === "tools" || role === "tool") && VOICES.includes(voice as Voice)) {
					const normalizedRole = role === "response" ? "talk" : role === "tool" ? "tools" : role;
					applyVoice(normalizedRole as "talk" | "thinking" | "tools", voice as Voice);
					ctx.ui.notify(`${normalizedRole} voice: ${voice}`, "success");
					updateWidget(ctx);
					return;
				}
			}

			if (parts.length === 1) {
				ctx.ui.notify(`Invalid voice. Options: ${VOICES.join(", ")}`, "error");
			} else {
				ctx.ui.notify("Usage: /voice <name> or /voice talk|thinking|tools <name>", "error");
			}
		},
	});

	pi.registerCommand("talk-thinking", {
		description: "Toggle reading thinking blocks aloud (default: on)",
		handler: async (_, ctx) => {
			state.readThinking = !state.readThinking;
			ctx.ui.notify(
				`Thinking blocks: ${state.readThinking ? "will be read aloud" : "hidden; TLDR will be spoken if enabled"}`,
				state.readThinking ? "success" : "dim"
			);
			updateWidget(ctx);
		},
	});

	pi.registerCommand("talk-tools", {
		description: "Toggle brief tool-call announcements",
		handler: async (_, ctx) => {
			state.announceTools = !state.announceTools;
			ctx.ui.notify(
				`Tool announcements: ${state.announceTools ? "enabled" : "disabled"}`,
				state.announceTools ? "success" : "dim"
			);
			updateWidget(ctx);
		},
	});

	pi.registerCommand("talk-tldr", {
		description: "Toggle TLDR playback for hidden thinking blocks",
		handler: async (_, ctx) => {
			state.generateThinkingTldr = !state.generateThinkingTldr;
			ctx.ui.notify(
				`Thinking TLDR: ${state.generateThinkingTldr ? "enabled" : "disabled"}`,
				state.generateThinkingTldr ? "success" : "dim"
			);
			updateWidget(ctx);
		},
	});

	pi.registerCommand("talk-test", {
		description: "Test pi-talk with a sample message",
		handler: async (_, ctx) => {
			try {
				await ensureDaemon();
				ctx.ui.notify("Testing audio...", "info");
				await speakChunk("This is a test of pi talk. If you can hear this, it's working correctly.", state.responseVoice);
				ctx.ui.notify("Test successful!", "success");
			} catch (e: unknown) {
				ctx.ui.notify(`Test failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("t"), {
		description: "Toggle pi-talk on/off",
		handler: async (ctx) => {
			state.enabled = !state.enabled;
			ctx.ui.notify(`pi-talk ${state.enabled ? "enabled" : "disabled"}`, state.enabled ? "success" : "dim");
			updateWidget(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("v"), {
		description: "Cycle through voices",
		handler: async (ctx) => {
			const idx = VOICES.indexOf(state.responseVoice);
			state.responseVoice = VOICES[(idx + 1) % VOICES.length];
			ctx.ui.notify(`Talk voice: ${state.responseVoice}`, "success");
			updateWidget(ctx);
		},
	});

	// Lifecycle
	pi.on("ready", (_, ctx) => {
		// Check if --talk flag was passed
		if (pi.getFlag("talk") === true) {
			state.enabled = true;
			ctx.ui.notify("pi-talk enabled", "success");
		}
		updateWidget(ctx);
	});

	pi.on("turn_start", async () => {
		stopAudio();
		resetStreamingState();
		await cleanupFiles();
	});

	pi.on("message_update", async (event, ctx) => {
		if (!state.enabled) return;

		const assistantEvent = event.assistantMessageEvent as {
			type: string;
			delta?: string;
		};

		// Debug: write to file immediately (sync)
		if (process.env.PI_TALK_DEBUG) {
			logDebugEvent(String(assistantEvent?.type ?? "unknown"));
		}

		// Handle text deltas (normal response)
		if (assistantEvent?.type === "text_delta" && assistantEvent.delta) {
			addStreamDelta("text", assistantEvent.delta, ctx);
			return;
		}

		// Handle thinking deltas, either speaking them live or saving for TLDR.
		if (assistantEvent?.type === "thinking_delta" && assistantEvent.delta) {
			state.hiddenThinkingBuffer += assistantEvent.delta;
			if (state.readThinking) {
				addStreamDelta("thinking", assistantEvent.delta, ctx);
			}
			return;
		}
	});

	pi.on("message_end", async (_, ctx) => {
		if (!state.enabled) return;

		// Mark message as complete
		state.isMessageComplete = true;

		// Clear any pending speak timeout
		if (state.speakTimeout) {
			clearTimeout(state.speakTimeout);
			state.speakTimeout = null;
		}

		maybeQueueThinkingTldr(ctx);
		flushBufferedSpeech(ctx, true);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) return;
		maybeQueueThinkingTldr(ctx);
		flushBufferedSpeech(ctx, true);
		if (state.announceTools) {
			queueSpeech(formatToolAnnouncement(event), ctx, true, state.toolVoice);
		}
	});

	pi.on("user_message", async () => {
		stopAudio();
		resetStreamingState();
		await cleanupFiles();
	});

	// Cleanup on exit
	const exitHandler = () => {
		stopAudio();
		cleanupFiles().catch(() => {});
	};
	process.on("exit", exitHandler);
	process.on("SIGINT", exitHandler);
	process.on("SIGTERM", exitHandler);
}
