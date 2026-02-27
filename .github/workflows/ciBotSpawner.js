const fs = require('fs');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { construct_spawn_packet } = require('./Protocol');

const SERVER = process.env.SERVER_URL;
const BOT_COUNT = parseInt(process.env.BOT_COUNT || "20");
const DURATION = parseInt(process.env.DURATION || "60000");

// Bright Data proxy constants
const BRD_HOST = "brd.superproxy.io";
const BRD_PORT = 33335;

// Provided via GitHub Actions secrets
const BRD_CUSTOMER = process.env.BRD_CUSTOMER;   // e.g. brd-customer-hl_b4cdabd8
const BRD_ZONE = process.env.BRD_ZONE;           // e.g. datacenter_proxy1
const BRD_PASSWORD = process.env.BRD_PASSWORD;   // proxy password

if (!BRD_CUSTOMER || !BRD_ZONE || !BRD_PASSWORD) {
    console.error("Missing Bright Data credentials (BRD_CUSTOMER, BRD_ZONE, BRD_PASSWORD)");
    process.exit(1);
}

function buildProxyAgent(botId) {
    const session = `bot_${botId}`;

    const username =
        `${BRD_CUSTOMER}-zone-${BRD_ZONE}-session-${session}`;

    const proxyUrl =
        `http://${username}:${BRD_PASSWORD}@${BRD_HOST}:${BRD_PORT}`;

    return new HttpsProxyAgent(proxyUrl);
}

let bots = [];

function spawnBot(id) {
    const agent = buildProxyAgent(id);

    const ws = new WebSocket(SERVER, { agent });

    ws.on('open', () => {
        console.log(`Bot ${id} connected via BrightData session bot_${id}`);
        const packet = construct_spawn_packet(`CI_Bot_${id}`, "");
        ws.send(packet);
    });

    ws.on('error', (err) => {
        console.log(`Bot ${id} error: ${err.message}`);
    });

    bots.push(ws);
}

async function main() {
    console.log(`Spawning ${BOT_COUNT} bots using Bright Data session proxies...`);

    for (let i = 0; i < BOT_COUNT; i++) {
        spawnBot(i);
        await new Promise(r => setTimeout(r, 50));
    }

    setTimeout(() => {
        console.log("Closing bots...");
        bots.forEach(b => b.close());
        process.exit(0);
    }, DURATION);
}

main();
