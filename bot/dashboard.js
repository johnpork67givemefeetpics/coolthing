// dashboard.js
const blessed = require('blessed');

// Exact messages to block
const BLOCKED_MESSAGES = [
    "Stop! background:black;color:red;padding:12px;font-size:64px;font-weight:bold;border-radius:8px",
    "Hackers have been known to trick people into running malicious scripts here"
];

class Dashboard {
    constructor() {
        this.screen = blessed.screen({
            smartCSR: true,
            title: 'Arras.io Bot Dashboard'
        });

        this.statsBox = blessed.box({
            top: 0,
            left: 0,
            width: '30%',
            height: '25%',
            label: ' Statistics ',
            border: { type: 'line' },
            style: { border: { fg: 'cyan' } },
            tags: true
        });

        this.logBox = blessed.log({
            top: '25%',
            left: 0,
            width: '100%',
            height: '65%',
            label: ' Logs ',
            border: { type: 'line' },
            scrollbar: { ch: ' ', track: { bg: 'cyan' }, style: { inverse: true } },
            style: { border: { fg: 'green' } },
            tags: true
        });

        this.statusBox = blessed.box({
            top: 0,
            left: '30%',
            width: '70%',
            height: '25%',
            label: ' Server Info ',
            border: { type: 'line' },
            style: { border: { fg: 'yellow' } },
            tags: true
        });

        this.inputBox = blessed.textbox({
            bottom: 0,
            left: 0,
            width: '100%',
            height: 3,
            label: ' Command (Type "help" for list) ',
            border: { type: 'line' },
            style: { border: { fg: 'magenta' } },
            inputOnFocus: true,
            tags: true
        });

        this.screen.append(this.statsBox);
        this.screen.append(this.logBox);
        this.screen.append(this.statusBox);
        this.screen.append(this.inputBox);

        this.stats = {
            total: 0,
            connected: 0,
            connecting: 0,
            failed: 0
        };

        this.serverInfo = {
            url: 'Not set',
            status: 'Idle'
        };

        this.setupEvents();
        this.updateStats();
        this.updateServerInfo();
        this.screen.render();
    }

    setupEvents() {
        this.screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

        this.inputBox.on('submit', (value) => {
            this.emit('command', value);
            this.inputBox.clearValue();
            this.inputBox.focus();
            this.screen.render();
        });

        this.screen.on('keypress', (ch, key) => {
            if (key.name === 'i') {
                this.inputBox.focus();
            }
        });
    }

    // Internal helper: block only the two exact WASM warnings
    shouldBlock(msg) {
        return BLOCKED_MESSAGES.some(block => msg.includes(block));
    }

    log(msg) {
        if (this.shouldBlock(msg)) return;

        this.logBox.log(`[{cyan-fg}${new Date().toLocaleTimeString()}{/cyan-fg}] ${msg}`);
        this.screen.render();
    }

    error(msg) {
        if (this.shouldBlock(msg)) return;

        this.logBox.log(`[{red-fg}${new Date().toLocaleTimeString()}{/red-fg}] {red-fg}ERROR:{/red-fg} ${msg}`);
        this.screen.render();
    }

    setStat(type, value) {
        this.stats[type] = value;
        this.updateStats();
    }

    updateStats() {
        this.statsBox.setContent(
            `Total:      {bold}${this.stats.total}{/bold}\n` +
            `Connected:  {green-fg}${this.stats.connected}{/green-fg}\n` +
            `Connecting: {yellow-fg}${this.stats.connecting}{/yellow-fg}\n` +
            `Failed:     {red-fg}${this.stats.failed}{/red-fg}`
        );
        this.screen.render();
    }

    setServerInfo(url, status) {
        this.serverInfo.url = url;
        this.serverInfo.status = status;
        this.updateServerInfo();
    }

    updateServerInfo() {
        this.statusBox.setContent(
            `Target URL: {bold}${this.serverInfo.url}{/bold}\n` +
            `Status:     ${this.serverInfo.status}`
        );
        this.screen.render();
    }

    on(event, callback) {
        if (!this._callbacks) this._callbacks = {};
        if (!this._callbacks[event]) this._callbacks[event] = [];
        this._callbacks[event].push(callback);
    }

    emit(event, ...args) {
        if (this._callbacks && this._callbacks[event]) {
            this._callbacks[event].forEach(cb => cb(...args));
        }
    }
}

module.exports = Dashboard;
