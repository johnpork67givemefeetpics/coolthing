// BotManager.js
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
    const crashFile = path.join(__dirname, 'crash_log.txt');
    const errorMessage = `[${new Date().toISOString()}] STARTUP CRASH: ${err.stack || err}\n`;
    try {
        fs.appendFileSync(crashFile, errorMessage);
        console.error(errorMessage);
    } catch (e) {
        console.error("Failed to write to crash log:", e);
        console.error(errorMessage);
    }
    console.log("Crashed during startup. Exiting in 10 seconds...");
    setTimeout(() => process.exit(1), 10000);
});

const ArrasClient = require('./ArrasClient');
const Dashboard = require('./dashboard');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

class BotManager {
    constructor(wasmPath, defaultProxyPath) {
        this.wasmPath = wasmPath;

        // Load cached proxy path if available
        const cacheFile = path.join(__dirname, 'proxy_path_cache.txt');
        if (fs.existsSync(cacheFile)) {
            this.proxyPath = fs.readFileSync(cacheFile, 'utf8').trim();
        } else {
            this.proxyPath = defaultProxyPath;
        }

        this.proxies = [];
        this.bots = [];
        this.dashboard = new Dashboard();
        this.serverUrl = null;
        this.spoofMode = false;
        this.stats = { total: 0, connected: 0, connecting: 0, failed: 0 };

        if (this.proxyPath) {
            this.loadProxies();
        }

        this.setupDashboard();
    }

    setupDashboard() {
        this.dashboard.on('command', (cmd) => {
            const parts = cmd.trim().split(' ');
            const action = parts[0].toLowerCase();
            const args = parts.slice(1);

            switch (action) {
                case 'help':
                    this.dashboard.log('Commands:');
                    this.dashboard.log('  server <url>           Set target server');
                    this.dashboard.log('  aao <total>            Spawn all bots at once');
                    this.dashboard.log('  single <delay> <total> Spawn bots one by one');
                    this.dashboard.log('  bursts <conc> <total>  Spawn bots in bursts');
                    this.dashboard.log('  check                  Check loaded proxies');
                    this.dashboard.log('  killall                Disconnect all bots');
                    this.dashboard.log('  proxies <file>         Load proxies from file');
                    this.dashboard.log('  spoof                  Toggle IP spoofer mode');
                    break;

                case 'server':
                    this.serverUrl = args.join('').trim().replace(/\s/g, '');
                    if (this.serverUrl && !this.serverUrl.startsWith('ws')) {
                        if (this.serverUrl.startsWith('http')) {
                            this.serverUrl = this.serverUrl.replace('http', 'ws');
                        } else {
                            this.serverUrl = 'ws://' + this.serverUrl;
                        }
                    }
                    if (this.serverUrl) {
                        this.dashboard.log(`Server URL set to: ${this.serverUrl}`);
                        this.dashboard.setServerInfo(this.serverUrl, 'Ready');
                    } else {
                        this.dashboard.error('Please provide a URL.');
                    }
                    break;

                case 'spawn': // Alias for AAO or legacy
                case 'aao': {
                    if (!this.validateSpawn()) return;
                    const count = parseInt(args[0]) || 1;
                    this.dashboard.log(`Spawning ${count} bots (AAO)...`);
                    this.spawnBots(this.serverUrl, count, 'aao').catch(err => {
                        this.dashboard.error(`Spawn error: ${err.message}`);
                    });
                    break;
                }

                case 'single': {
                    if (!this.validateSpawn()) return;
                    const delay = parseInt(args[0]) || 1000;
                    const count = parseInt(args[1]) || 1;
                    this.dashboard.log(`Spawning ${count} bots (Single, ${delay}ms delay)...`);
                    this.spawnBots(this.serverUrl, count, 'single', { delay }).catch(err => {
                        this.dashboard.error(`Spawn error: ${err.message}`);
                    });
                    break;
                }

                case 'bursts': {
                    if (!this.validateSpawn()) return;
                    const concurrency = parseInt(args[0]) || 10;
                    const count = parseInt(args[1]) || concurrency;
                    this.dashboard.log(`Spawning ${count} bots (Bursts of ${concurrency})...`);
                    this.spawnBots(this.serverUrl, count, 'bursts', { concurrency }).catch(err => {
                        this.dashboard.error(`Spawn error: ${err.message}`);
                    });
                    break;
                }

                case 'check':
                    this.dashboard.log('Checking proxies...');
                    this.checkProxies().catch(err => {
                        this.dashboard.error(`Check error: ${err.message}`);
                    });
                    break;

                case 'killall':
                    this.dashboard.log('Killing all bots...');
                    this.bots.forEach(bot => bot.socket && bot.socket.terminate());
                    this.bots = [];
                    this.updateStats();
                    break;

                case 'proxies':
                    this.handleProxiesCommand(args);
                    break;

                case 'spoof':
                    this.spoofMode = !this.spoofMode;
                    this.dashboard.log(`IP Spoof mode: ${this.spoofMode ? 'ON — bots will use random spoofed IPs (no proxies needed)' : 'OFF — bots will use proxies'}`);
                    break;

                default:
                    this.dashboard.error(`Unknown command: ${action}`);
            }
        });
    }

    handleProxiesCommand(args) {
        if (!args[0]) {
            this.dashboard.log('Usage: proxies <file>');
            this.dashboard.log(`Current proxy file: ${this.proxyPath || 'none'}`);
            this.dashboard.log(`Loaded proxies: ${this.proxies.length}`);
            return;
        }

        const filePath = path.isAbsolute(args[0])
            ? args[0]
            : path.join(process.cwd(), args[0]);

        if (!fs.existsSync(filePath)) {
            this.dashboard.error(`Proxy file not found: ${filePath}`);
            return;
        }

        this.proxyPath = filePath;
        fs.writeFileSync(path.join(__dirname, 'proxy_path_cache.txt'), filePath, 'utf8');
        this.loadProxies();
        this.dashboard.log(`Proxy file set to: ${filePath}`);
    }

    validateSpawn() {
        if (!this.serverUrl) {
            this.dashboard.error('Set server URL first with "server <url>"');
            return false;
        }
        if (!this.spoofMode && this.proxies.length === 0) {
            this.dashboard.error('You must load proxies or enable spoof mode. Use: proxies <file> or: spoof');
            return false;
        }
        return true;
    }

    updateStats() {
        this.stats.total = this.bots.length;
        this.dashboard.setStat('total', this.stats.total);
        this.dashboard.setStat('connected', this.stats.connected);
        this.dashboard.setStat('connecting', this.stats.connecting);
        this.dashboard.setStat('failed', this.stats.failed);
    }

    loadProxies() {
        if (this.proxyPath && fs.existsSync(this.proxyPath)) {
            const data = fs.readFileSync(this.proxyPath, 'utf8');
            this.proxies = data.split('\n').map(p => p.trim()).filter(p => p.length > 0);
            this.dashboard.log(`Loaded ${this.proxies.length} proxies from ${this.proxyPath}`);
        } else {
            this.proxies = [];
            this.dashboard.error('Proxy file not found, running without proxies');
        }
    }

    generateRandomIP() {
        // Generate a random public IPv4 address (avoids private/reserved ranges)
        let ip;
        do {
            const a = Math.floor(Math.random() * 256);
            const b = Math.floor(Math.random() * 256);
            const c = Math.floor(Math.random() * 256);
            const d = Math.floor(Math.random() * 256);
            ip = `${a}.${b}.${c}.${d}`;
            // Reject private, loopback, link-local, and reserved ranges
        } while (
            ip.startsWith('10.') ||
            ip.startsWith('127.') ||
            ip.startsWith('0.') ||
            ip.startsWith('169.254.') ||
            ip.startsWith('192.168.') ||
            (ip.startsWith('172.') && parseInt(ip.split('.')[1]) >= 16 && parseInt(ip.split('.')[1]) <= 31) ||
            parseInt(ip.split('.')[0]) >= 224 // multicast + reserved
        );
        return ip;
    }

    getAgent(proxy) {
        if (!proxy) return null;

        let proxyUrl = proxy;
        const parts = proxy.split(':');

        if (parts.length === 4) {
            const [host, port, user, pass] = parts;
            proxyUrl = `http://${user}:${pass}@${host}:${port}`;
        } else if (!proxy.startsWith('http') && !proxy.startsWith('socks')) {
            proxyUrl = `http://${proxy}`;
        }

        try {
            if (proxyUrl.startsWith('socks')) {
                return new SocksProxyAgent(proxyUrl);
            } else {
                return new HttpsProxyAgent(proxyUrl);
            }
        } catch (e) {
            this.dashboard.error(`Failed to create proxy agent for ${proxy}: ${e.message}`);
            return null;
        }
    }

    async spawnBots(serverUrl, count, mode = 'aao', options = {}) {
        const namePrefix = 'Bot';
        const delay = options.delay || 1000;
        const concurrency = options.concurrency || 10;

        const spawnTask = async (i) => {
            const botIdx = this.bots.length + i;
            const bot = new ArrasClient(this.wasmPath);

            this.stats.connecting++;
            this.updateStats();

            bot.on('log', msg => this.dashboard.log(`[Bot ${botIdx}] ${msg}`));
            bot.on('error', err => {
                this.dashboard.error(`[Bot ${botIdx}] ${err}`);
                this.stats.failed++;
                this.stats.connecting--;
                this.updateStats();
            });
            bot.on('open', () => {
                this.stats.connected++;
                this.stats.connecting--;
                this.updateStats();
                bot.spawn(`${namePrefix} ${botIdx}`);
            });
            bot.on('ready', () => {
                this.dashboard.log(`[Bot ${botIdx}] REACHED READY STATE`);
            });
            bot.on('close', () => {
                this.stats.connected--;
                this.updateStats();
            });

            await bot.init();

            if (this.spoofMode) {
                const spoofIP = this.generateRandomIP();
                bot.connect(serverUrl, null, spoofIP);
            } else {
                const proxy = this.proxies[botIdx % this.proxies.length] || null;
                const agent = this.getAgent(proxy);
                bot.connect(serverUrl, agent);
            }
            this.bots.push(bot);
        };

        if (mode === 'single') {
            for (let i = 0; i < count; i++) {
                spawnTask(i).catch(e => this.dashboard.error(`Task error: ${e.message}`));
                await new Promise(r => setTimeout(r, delay));
            }
        } else if (mode === 'bursts') {
            for (let i = 0; i < count; i += concurrency) {
                const batchSize = Math.min(concurrency, count - i);
                const batch = [];
                for (let j = 0; j < batchSize; j++) {
                    batch.push(spawnTask(i + j));
                }
                await Promise.all(batch);
                // Optional: small delay between bursts to allow event loop to breathe
                await new Promise(r => setTimeout(r, 100));
            }
        } else {
            // AAO
            const tasks = [];
            for (let i = 0; i < count; i++) {
                tasks.push(spawnTask(i));
            }
            await Promise.all(tasks);
        }
    }

    async checkProxies() {
        const workingFile = path.join(__dirname, 'working_proxies.txt');
        let existingWorking = [];
        try {
            if (fs.existsSync(workingFile)) {
                existingWorking = fs.readFileSync(workingFile, 'utf8')
                    .split('\n')
                    .map(p => p.trim())
                    .filter(p => p.length > 0);
            }
        } catch (e) {
            this.dashboard.error(`Error reading existing working proxies: ${e.message}`);
        }

        // Merge loaded proxies and existing working proxies, removing duplicates
        const allProxies = [...new Set([...this.proxies, ...existingWorking])];

        if (allProxies.length === 0) {
            this.dashboard.error('No proxies found to check (neither loaded nor in working file).');
            return;
        }

        this.dashboard.log(`Checking ${allProxies.length} unique proxies (loaded + existing working)...`);

        // Clear file to start fresh with validated ones
        fs.writeFileSync(workingFile, '');
        let workingCount = 0;

        const checkOne = async (proxy) => {
            return new Promise((resolve) => {
                const bot = new ArrasClient(this.wasmPath);
                let isResolved = false;

                const finish = (success) => {
                    if (isResolved) return;
                    isResolved = true;
                    bot.removeAllListeners();
                    try { bot.socket.terminate(); } catch (e) { }
                    resolve(success);
                };

                const timer = setTimeout(() => finish(false), 5000);

                bot.on('open', () => { clearTimeout(timer); finish(true); });
                bot.on('error', () => { clearTimeout(timer); finish(false); });
                bot.on('close', () => { clearTimeout(timer); finish(false); });

                const agent = this.getAgent(proxy);
                const target = this.serverUrl || 'ws://arras.io';

                try {
                    bot.connect(target, agent);
                } catch (e) {
                    finish(false);
                }
            });
        };

        const checkWithRetry = async (proxy) => {
            // First attempt
            if (await checkOne(proxy)) return true;
            // Second attempt
            if (await checkOne(proxy)) return true;
            return false;
        };

        const chunkSize = 50;
        for (let i = 0; i < allProxies.length; i += chunkSize) {
            const chunk = allProxies.slice(i, i + chunkSize);
            const results = await Promise.all(chunk.map(p => checkWithRetry(p).then(ok => ({ proxy: p, ok }))));

            const working = results.filter(r => r.ok).map(r => r.proxy);
            workingCount += working.length;

            if (working.length > 0) {
                fs.appendFileSync(workingFile, working.join('\n') + '\n');
            }

            this.dashboard.log(`Checked ${Math.min(i + chunkSize, allProxies.length)}/${allProxies.length}. Working so far: ${workingCount}`);
        }

        this.dashboard.log(`Check complete. ${workingCount} working proxies saved to ${workingFile}`);
    }
}

if (require.main === module) {
    const logCrash = (error) => {
        const crashFile = path.join(__dirname, 'crash_log.txt');
        const errorMessage = `[${new Date().toISOString()}] CRASH: ${error.stack || error}\n`;
        try {
            fs.appendFileSync(crashFile, errorMessage);
            console.error(errorMessage);
        } catch (e) {
            console.error("Failed to write to crash log:", e);
            console.error(errorMessage);
        }
    };

    let manager;

    process.on('uncaughtException', (err) => {
        logCrash(err);
        if (typeof manager !== 'undefined' && manager && manager.dashboard) {
            try {
                manager.dashboard.error(`Uncaught Exception: ${err.message}`);
                manager.dashboard.log(err.stack);
            } catch (e) {
                // Dashboard might be broken
            }
        }
        console.log("Crashed. Exiting in 10 seconds...");
        setTimeout(() => process.exit(1), 10000);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logCrash(new Error(`Unhandled Rejection: ${reason}`));
        if (typeof manager !== 'undefined' && manager && manager.dashboard) {
            try {
                manager.dashboard.error(`Unhandled Rejection: ${reason}`);
            } catch (e) {
                // ignore
            }
        }
    });

    try {
        manager = new BotManager(
            path.join(__dirname, '../arras.io-reversed_protocol_client_and_library/wasm/arras.wasm'),
            path.join(__dirname, '../proxy1http.txt')
        );

        if (manager.proxyPath) manager.loadProxies();
        manager.dashboard.log('Dashboard ready. Type "help" for commands.');
    } catch (err) {
        logCrash(err);
        console.log("Crashed. Exiting in 10 seconds...");
        setTimeout(() => process.exit(1), 10000);
    }
}

module.exports = BotManager;
