const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { construct_spawn_packet } = require('./Protocol');

const SERVER = process.env.SERVER_URL;
const BOT_COUNT = parseInt(process.env.BOT_COUNT || "20");
const DURATION = parseInt(process.env.DURATION || "60000");

// Expect proxy string like:
// brd.superproxy.io:33335:USERNAME:PASSWORD
const RAW_PROXY = process.env.BRD_PROXY; 
if (!RAW_PROXY) {
    console.error("Missing BRD_PROXY env var. Example:");
    console.error('BRD_PROXY="brd.superproxy.io:33335:USER:PASS" node ciBotSpawner.js');
    process.exit(1);
}

const [host, port, baseUser, basePass] = RAW_PROXY.split(":");
if (!host || !port || !baseUser || !basePass) {
    console.error("Invalid BRD_PROXY format. Expected:");
    console.error("host:port:username:password");
    process.exit(1);
}

function buildAgent(botId) {
    const session = `bot_${botId}`;
    const username = `${baseUser}-session-${session}`;
    const proxyUrl = `http://${username}:${basePass}@${host}:${port}`;
    return new HttpsProxyAgent(proxyUrl);
}

let bots = [];

function spawnBot(id) {
    const agent = buildAgent(id);

    const ws = new WebSocket(SERVER, { agent });

    ws.on('open', () => {
        console.log(`Bot ${id} connected via session bot_${id}`);
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
