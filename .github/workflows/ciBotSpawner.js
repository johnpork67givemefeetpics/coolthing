const fs = require('fs');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { construct_spawn_packet } = require('./Protocol');

const SERVER = process.env.SERVER_URL;
const BOT_COUNT = parseInt(process.env.BOT_COUNT || "20");
const DURATION = parseInt(process.env.DURATION || "60000");

// Load proxies
const proxyList = fs.readFileSync('proxies.txt', 'utf8')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);

if (proxyList.length === 0) {
    console.error("No proxies found in proxies.txt");
    process.exit(1);
}

function makeAgent(proxy) {
    if (proxy.startsWith("socks")) return new SocksProxyAgent(proxy);
    return new HttpsProxyAgent(proxy);
}

let bots = [];

function spawnBot(id) {
    const proxy = proxyList[id % proxyList.length];
    const agent = makeAgent(proxy);

    const ws = new WebSocket(SERVER, { agent });

    ws.on('open', () => {
        console.log(`Bot ${id} connected via ${proxy}`);
        const packet = construct_spawn_packet(`CI_Bot_${id}`, "");
        ws.send(packet);
    });

    ws.on('error', (err) => {
        console.log(`Bot ${id} error via ${proxy}: ${err.message}`);
    });

    bots.push(ws);
}

async function main() {
    console.log(`Spawning ${BOT_COUNT} bots using ${proxyList.length} proxies...`);

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
