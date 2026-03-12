#!/usr/bin/env node

/**
 * Simulate streaming text like pi's message_update events
 */

const { exec } = require('node:child_process');
const fs = require('node:fs');

const text = "Hello! This is a test of streaming text-to-speech. We want to hear audio as text arrives, not wait for complete sentences. Let me add more text to demonstrate: this should trigger multiple audio chunks.";

// Simulate streaming in chunks
const chunks = text.match(/.{1,50}\b/g) || [];

let i = 0;
const interval = setInterval(() => {
	if (i >= chunks.length) {
		clearInterval(interval);
		console.log('Done streaming');
		return;
	}

	const chunk = chunks[i];
	console.log(`[${new Date().toISOString()}] Streaming: "${chunk}"`);

	// Call speakturbo immediately (no waiting)
	const escaped = JSON.stringify(chunk);
	exec(`~/.local/bin/speakturbo ${escaped} -v alba 2>&1`, (error, stdout, stderr) => {
		if (error) {
			console.error(`  ✗ Error: ${error.message}`);
		} else {
			console.log(`  ✓ Audio played`);
		}
	});

	i++;
}, 300); // New chunk every 300ms
