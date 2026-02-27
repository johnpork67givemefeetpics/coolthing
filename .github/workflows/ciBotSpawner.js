const WebSocket = require('ws');
const { construct_spawn_packet } = require('./Protocol');

const SERVER = process.env.SERVER_URL;
const BOT_COUNT = parseInt(process.env.BOT_COUNT || "20");
const DURATION = parseInt(process.env.DURATION || "60000"); // 60s

let bots = [];

function spawnBot(id) {
    const ws = new WebSocket(SERVER);

    ws.on('open', () => {
        console.log(`Bot ${id} connected`);
        const packet = construct_spawn_packet(`CI_Bot_${id}`, "");
        ws.send(packet);
    });

    ws.on('error', (err) => {
        console.log(`Bot ${id} error: ${err.message}`);
    });

    bots.push(ws);
}

async function main() {
    console.log(`Spawning ${BOT_COUNT} bots...`);

    for (let i = 0; i < BOT_COUNT; i++) {
        spawnBot(i);
        await new Promise(r => setTimeout(r, 50)); // micro-stagger
    }

    setTimeout(() => {
        console.log("Closing bots...");
        bots.forEach(b => b.close());
        process.exit(0);
    }, DURATION);
}

main();
