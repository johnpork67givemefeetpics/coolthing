// runner.js — GitHub Actions headless bot runner
// No dashboard, just console output.
// Reads config from environment variables:
//   PROXY_PASSWORD  - Bright Data proxy password
//   BOT_COUNT       - Number of bots to spawn
//   SERVER_URL      - Target server WebSocket URL

const path = require('path');
const fs = require('fs');
const ArrasClient = require('./ArrasClient');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ─── Config ────────────────────────────────────────────────────────────────────
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;
const BOT_COUNT = parseInt(process.env.BOT_COUNT, 10) || 5;
let SERVER_URL = process.env.SERVER_URL || '';

if (!PROXY_PASSWORD) {
    console.error('[FATAL] PROXY_PASSWORD is not set. Exiting.');
    process.exit(1);
}
if (!SERVER_URL) {
    console.error('[FATAL] SERVER_URL is not set. Exiting.');
    process.exit(1);
}

// Normalize the server URL to ws/wss
SERVER_URL = SERVER_URL.trim().replace(/\s/g, '');
if (!SERVER_URL.startsWith('ws')) {
    if (SERVER_URL.startsWith('http')) {
        SERVER_URL = SERVER_URL.replace('http', 'ws');
    } else {
        SERVER_URL = 'wss://' + SERVER_URL;
    }
}

// ─── Bright Data session proxy builder ─────────────────────────────────────────
// Each bot gets a unique session ID so they each get a different IP.
// Format: brd-customer-hl_b4cdabd8-zone-datacenter_proxy1-session-<unique>
function buildProxyAgent(botIndex) {
    const sessionId = `bot${botIndex}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const username = `brd-customer-hl_b4cdabd8-zone-datacenter_proxy1-session-${sessionId}`;
    const proxyUrl = `http://${username}:${PROXY_PASSWORD}@brd.superproxy.io:33335`;
    return new HttpsProxyAgent(proxyUrl);
}

// ─── WASM path ────────────────────────────────────────────────────────────────
const WASM_PATH = path.join(
    __dirname,
    '../arras.io-reversed_protocol_client_and_library/wasm/arras.wasm'
);

if (!fs.existsSync(WASM_PATH)) {
    console.error(`[FATAL] WASM file not found at: ${WASM_PATH}`);
    process.exit(1);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
const stats = { total: 0, connected: 0, connecting: 0, failed: 0 };
const bots = [];

function printStats() {
    console.log(
        `[STATS] Total: ${stats.total} | Connected: ${stats.connected} | ` +
        `Connecting: ${stats.connecting} | Failed: ${stats.failed}`
    );
}

// Print stats every 30 seconds
const statsInterval = setInterval(printStats, 30000);

// ─── Spawn a single bot ──────────────────────────────────────────────────────
async function spawnBot(index) {
    const bot = new ArrasClient(WASM_PATH);

    stats.total++;
    stats.connecting++;
    printStats();

    bot.on('log', (msg) => {
        // Only log important messages to avoid flooding CI output
        if (
            msg.includes('Handshake') ||
            msg.includes('READY') ||
            msg.includes('opened') ||
            msg.includes('closed') ||
            msg.includes('Connecting')
        ) {
            console.log(`[Bot ${index}] ${msg}`);
        }
    });

    bot.on('error', (err) => {
        console.error(`[Bot ${index}] ERROR: ${err}`);
        stats.failed++;
        stats.connecting = Math.max(0, stats.connecting - 1);
        printStats();
    });

    bot.on('open', () => {
        stats.connected++;
        stats.connecting = Math.max(0, stats.connecting - 1);
        console.log(`[Bot ${index}] Connected!`);
        printStats();
        bot.spawn(`Bot ${index}`);
    });

    bot.on('ready', () => {
        console.log(`[Bot ${index}] ✅ READY — in game!`);
    });

    bot.on('close', () => {
        console.log(`[Bot ${index}] Disconnected.`);
        stats.connected = Math.max(0, stats.connected - 1);
        printStats();
    });

    await bot.init();

    const agent = buildProxyAgent(index);
    bot.connect(SERVER_URL, agent);
    bots.push(bot);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  Arras.io Bot Runner — GitHub Actions Edition');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Server:    ${SERVER_URL}`);
    console.log(`  Bot Count: ${BOT_COUNT}`);
    console.log(`  Proxy:     brd.superproxy.io:33335 (session per bot)`);
    console.log('═══════════════════════════════════════════════════════');
    console.log();

    // Spawn bots with a small stagger to avoid hammering the proxy
    for (let i = 0; i < BOT_COUNT; i++) {
        try {
            await spawnBot(i);
        } catch (err) {
            console.error(`[Bot ${i}] Failed to spawn: ${err.message}`);
            stats.failed++;
        }

        // 500ms delay between each bot to avoid rate limiting
        if (i < BOT_COUNT - 1) {
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    console.log();
    console.log('[INFO] All bot spawn tasks complete.');
    printStats();
    console.log('[INFO] Bots are running. The workflow will keep alive until timeout or cancellation.');

    // Keep the process alive
    // GitHub Actions will kill the job when it hits the timeout-minutes limit
    // or when someone cancels the workflow run.
}

// ─── Error handling ──────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error(`[CRASH] Uncaught Exception: ${err.stack || err}`);
    // Don't exit — let other bots keep running
});

process.on('unhandledRejection', (reason) => {
    console.error(`[CRASH] Unhandled Rejection: ${reason}`);
});

// Graceful shutdown on SIGTERM/SIGINT (Docker/CI stop signals)
process.on('SIGTERM', () => {
    console.log('[INFO] Received SIGTERM, shutting down...');
    clearInterval(statsInterval);
    bots.forEach((bot) => bot.destroy());
    printStats();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[INFO] Received SIGINT, shutting down...');
    clearInterval(statsInterval);
    bots.forEach((bot) => bot.destroy());
    printStats();
    process.exit(0);
});

main().catch((err) => {
    console.error(`[FATAL] ${err.stack || err}`);
    process.exit(1);
});
