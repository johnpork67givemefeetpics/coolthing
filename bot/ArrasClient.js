// ArrasClient.js
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const EventEmitter = require('events');
const { decode_packet, construct_spawn_packet } = require('./Protocol');

// Mock global objects for WASM
if (typeof global !== 'undefined') {
    global.ramp = { que: [] };
    global.window = global;
    global.document = {
        activeElement: null,
        body: {
            appendChild: () => { },
            append: () => { },
        },
        activeElement: { focus: () => { } },
        createElement: (type) => ({
            style: {},
            getContext: () => ({
                measureText: (txt) => ({ width: txt ? txt.length * 10 : 10 }),
                clearRect: () => { },
                fillRect: () => { },
                fillText: () => { },
                strokeText: () => { },
                beginPath: () => { },
                moveTo: () => { },
                lineTo: () => { },
                stroke: () => { },
                fill: () => { },
                arc: () => { },
                save: () => { },
                restore: () => { },
                scale: () => { },
                translate: () => { },
                rotate: () => { },
                drawImage: () => { },
                createLinearGradient: () => ({ addColorStop: () => { } }),
            }),
            appendChild: () => { },
            width: 1920,
            height: 1080,
            tagName: (type || 'div').toUpperCase()
        }),
        location: { hostname: 'arras.io', protocol: 'https:' },
        addEventListener: () => { },
        removeEventListener: () => { },
    };
    global.navigator = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        webdriver: false,
        hardwareConcurrency: 8,
        keyboard: { lock: () => Promise.resolve() }
    };
    global.localStorage = {
        getItem: () => null,
        setItem: () => { },
        removeItem: () => { },
        clear: () => { }
    };
    global.performance = { now: Date.now };
    global.arrasAdDone = true;
}

class ArrasClient extends EventEmitter {
    constructor(wasmPath) {
        super();
        this.wasmPath = wasmPath;
        this.wasmInstance = null;
        this.socket = null;
        this.textEncoder = new TextEncoder();
        this.textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

        this.packetQueue = [];
        this.messagePacket = [];
        this.sendPacket = [];
        this.registry = [null, Function];

        this.isReady = false;
        this.pendingSpawn = null;
        this.newPacketMessage = false;
        this.newPacketSend = false;

        // Initialize unique bot fingerprint
        const userAgents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        ];
        this.userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        this.hardwareConcurrency = [2, 4, 8, 12, 16][Math.floor(Math.random() * 5)];
        this.devicePixelRatio = [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)];

        // Randomize screen metrics
        const resolutions = [
            [1920, 1080], [2560, 1440], [1366, 768], [1536, 864], [1440, 900]
        ];
        const res = resolutions[Math.floor(Math.random() * resolutions.length)];
        this.screenWidth = res[0];
        this.screenHeight = res[1];
        this.colorDepth = [24, 32][Math.floor(Math.random() * 2)];

        // Per-bot timing and metric jitter
        this.timeOffset = Math.random() * 1000;
        this.metricJitter = 0.95 + Math.random() * 0.1; // 0.95x to 1.05x jitter
    }

    async init() {
        try {
            if (!fs.existsSync(this.wasmPath)) {
                throw new Error(`WASM file not found at: ${this.wasmPath}`);
            }
            const wasmBuffer = fs.readFileSync(this.wasmPath);
            const e_reg = this.registry;
            const l_dec = this.textDecoder;
            const d_enc = this.textEncoder;
            let f_exports = null;
            const views = { u8: null, i32: null, f64: null };

            const a_u8 = () => {
                if (!views.u8 || views.u8.buffer !== f_exports.e.buffer) {
                    views.u8 = new Uint8Array(f_exports.e.buffer);
                }
                return views.u8;
            };
            const o_i32 = () => {
                if (!views.i32 || views.i32.buffer !== f_exports.e.buffer) {
                    views.i32 = new Int32Array(f_exports.e.buffer);
                }
                return views.i32;
            };

            const t_set = (idx, val) => { e_reg[idx] = val; };
            const u_str = (idx, str) => {
                const buf = d_enc.encode(str || "");
                const ptr = f_exports.d(buf.length, 1);
                a_u8().set(buf, ptr);
                o_i32().set([ptr, buf.length], idx >> 2);
            };
            const y_buf = (idx, buf) => {
                const ptr = f_exports.d(buf.length, 1);
                a_u8().set(buf, ptr);
                o_i32().set([ptr, buf.length], idx >> 2);
            };

            const g_tick = () => { if (f_exports && f_exports.c) f_exports.c(); };

            const s_reg = new Array(1024).fill(null);
            const shims = new Array(1024).fill(null).map((_, i) => (...args) => {
                try {
                    if (s_reg[i]) {
                        return s_reg[i](...args);
                    }
                } catch (e) {
                    console.error(`[FUNCTION ERROR] Shim ${i}: ${e.message}`);
                }
                return 0;
            });
            const s_set = (i, fn) => { s_reg[i] = fn; };

            // --- SHIM DEFINITIONS ---
            s_set(0, (idx, r, n) => { u_str(idx, l_dec.decode(a_u8().subarray(r, r + n))); });
            s_set(1, (idx, r) => { y_buf(idx, (e_reg[r] || []).shift() || new Uint8Array(0)); });
            s_set(2, (idx, r) => { if (e_reg[idx]) e_reg[idx].strokeStyle = `rgb(${r >> 16},${r >> 8 & 255},${255 & r})`; });
            s_set(4, () => { });
            s_set(5, (idx) => (e_reg[idx] || {}).readyState || 0);
            s_set(13, () => 0);
            s_set(15, (p1, l1, p2, l2) => {
                const m1 = l_dec.decode(a_u8().subarray(p1, p1 + l1));
                const m2 = l_dec.decode(a_u8().subarray(p2, p2 + l2));
                this.emit('log', `WASM: ${m1} ${m2}`);
            });
            s_set(16, () => { });
            s_set(23, (idx) => {
                const val = e_reg[idx];
                if (!val || val.length === 0) return 0;
                if (val[0].status) return 1;
                if (val[0].signature) return 2;
                return 3;
            });
            s_set(28, (idx) => (e_reg[idx] || []).shift() ?? -1);
            s_set(29, (idx) => { t_set(idx, global); });
            s_set(30, (idx) => u_str(idx, ""));
            s_set(31, () => 0);
            s_set(35, () => 2);
            s_set(37, () => { });
            s_set(38, () => false);
            s_set(40, (idx) => (e_reg[idx] || []).shift());
            s_set(41, (idx) => typeof e_reg[idx] === 'number');
            s_set(48, (idx) => { let r = (e_reg[idx] || [false])[0]; if (e_reg[idx]) e_reg[idx][0] = false; return r; });

            s_set(49, (t_idx, ptr, len) => {
                const socket = e_reg[t_idx];
                const buf = new Uint8Array(a_u8().subarray(ptr, ptr + len));
                if (socket && socket.readyState === 1) socket.send(buf);
                else if (this.socket && this.socket.readyState === 1) this.socket.send(buf);
                this.newPacketSend = true;
            });

            s_set(51, () => Date.now() + this.timeOffset);
            s_set(53, () => performance.now() + this.timeOffset);
            s_set(56, () => Date.now() + this.timeOffset);
            s_set(57, (idx) => e_reg[idx]);

            s_set(59, (u_off, u_len, r_idx) => {
                let url = l_dec.decode(a_u8().subarray(u_off, u_off + u_len));
                url = url.replace(".uvwx.xyz:2222", "-c.uvwx.xyz:8443/2222");
                if (!url.includes("signature")) {
                    const registry = e_reg[r_idx];
                    if (Array.isArray(registry)) {
                        fetch(url)
                            .then(res => res.json())
                            .then(json => { registry.push(json); g_tick(); })
                            .catch(() => { });
                    }
                }
                return 0;
            });

            s_set(63, () => this.hardwareConcurrency);
            s_set(65, () => Math.floor(Math.random() * 0xFFFFFFFF));
            s_set(68, (idx, w, h) => { if (e_reg[idx]) { e_reg[idx].width = w; e_reg[idx].height = h; } });
            s_set(76, (r, n_idx, o_off, o_len) => {
                const n = e_reg[n_idx];
                if (!n) return;
                const prop = l_dec.decode(a_u8().subarray(o_off, o_off + o_len));
                t_set(r, n[prop]);
            });
            s_set(79, (idx) => { u_str(idx, this.userAgent); });
            s_set(81, () => 0);
            s_set(84, (idx) => { t_set(idx, global.document.createElement()); });
            s_set(85, (idx) => { t_set(idx, [false, false]); });
            s_set(87, (idx) => e_reg[idx]?.());
            s_set(91, (idx) => { if (e_reg[idx]) { e_reg[idx].lineJoin = 'round'; e_reg[idx].lineCap = 'round'; } });
            s_set(92, () => { });
            s_set(96, () => { });
            s_set(105, (idx) => { if (e_reg[idx]) e_reg[idx].style = e_reg[idx].style || {}; });
            s_set(110, (idx) => (e_reg[idx] || { hidden: false }).hidden);
            s_set(112, (idx) => { u_str(idx, "https://arras.io/"); });
            s_set(113, (idx) => { if (e_reg[idx]) e_reg[idx][1] = true; });
            s_set(115, (idx) => {
                const e = [false, false];
                const tick = () => { e[0] = true; g_tick(); if (!e[1]) setTimeout(tick, 16); };
                setTimeout(tick, 16);
                t_set(idx, e);
            });
            s_set(119, () => { });
            s_set(120, (idx) => { e_reg[idx >>> 0] = null; });
            s_set(121, (t, r) => (e_reg[t] || { hidden: false })[r]);
            s_set(122, (idx) => { t_set(idx, null); });
            s_set(123, (idx) => 1);
            s_set(124, (idx, r) => {
                const q = []; t_set(idx, q);
                this.on('input', (data) => { q.push(...data); g_tick(); });
            });
            s_set(125, (idx) => { u_str(idx, 'arras.io'); });
            s_set(127, () => 0);
            s_set(128, () => 0);
            s_set(130, (idx, r) => { u_str(idx, (e_reg[r] || {}).protocol || "https:"); });
            s_set(132, () => 0);
            s_set(134, () => this.hardwareConcurrency);
            s_set(135, (t, r) => { if (e_reg[t] && e_reg[t].appendChild) e_reg[t].appendChild(e_reg[r]); });
            s_set(137, () => 0);
            s_set(145, (idx) => { if (e_reg[idx]) e_reg[idx].style = e_reg[idx].style || {}; });
            s_set(146, (r, a) => { t_set(r, (e_reg[a] || {})[1]); });
            s_set(151, (idx) => { u_str(idx, "{}"); });
            s_set(154, () => 0);
            s_set(158, () => { });
            s_set(161, () => { });
            s_set(165, () => 0);
            s_set(168, (idx) => { t_set(idx, global.localStorage); });
            s_set(175, () => 0);

            // Identity & Fingerprint Bypasses (derived from simulation.html)
            s_set(433, (idx) => { u_str(idx, "WebGL 1.0 (OpenGL ES 2.0 Chromium)"); }); // Renderer
            s_set(434, (idx) => { u_str(idx, this.userAgent); }); // User Agent
            s_set(481, (idx) => { u_str(idx, "arras.io"); }); // Hostname
            s_set(585, (idx) => { u_str(idx, this.spoofIP || "127.0.0.1"); }); // IP Spoof shim
            s_set(587, () => 0); // Block RTCDataChannel
            s_set(616, (idx) => typeof e_reg[idx] === 'string');

            s_set(184, (t_idx, r_off, r_len) => {
                const ctx = e_reg[t_idx];
                const txt = l_dec.decode(a_u8().subarray(r_off, r_off + r_len));
                // Add slight jitter to text measurement to break fingerprinting
                return (ctx && ctx.measureText) ? Math.round(ctx.measureText(txt).width * this.metricJitter) : Math.round(10 * this.metricJitter);
            });
            s_set(190, (idx) => (e_reg[idx] || []).shift() || 0);
            s_set(191, (idx, r) => {
                const s = e_reg[r];
                const q = []; t_set(idx, q);
                if (s) {
                    s.on('open', () => { q.push(1); g_tick(); });
                    s.on('message', (m) => {
                        this.newPacketMessage = true;
                        q.push(2, new Uint8Array(m));
                        g_tick();
                    });
                    s.on('close', (c, code, reason) => { q.push(3, !!c, code || 1000, reason || ""); g_tick(); });
                    s.on('error', () => { q.push(4); g_tick(); });
                }
            });
            s_set(192, () => 0);
            s_set(193, (idx) => e_reg[idx]);
            s_set(195, () => 0);
            s_set(199, (idx) => (e_reg[idx] || [false])[0]);
            s_set(207, () => { });
            s_set(208, () => 0);
            s_set(209, () => 1);
            s_set(210, (idx) => { if (e_reg[idx]) e_reg[idx].style = e_reg[idx].style || {}; });
            s_set(213, () => 0);
            s_set(214, (idx, r) => { u_str(idx, (e_reg[r] || {}).signature || ""); });
            s_set(216, (idx, r, n) => {
                const url = l_dec.decode(a_u8().subarray(r, r + n));
                if (this.socket && url.includes(this.socket.url.split('/')[2])) t_set(idx, this.socket);
                else t_set(idx, { readyState: 0, send: () => { }, close: () => { } });
            });
            s_set(217, (r, n_off, n_len, s_off, s_len, d_idx) => {
                const n = l_dec.decode(a_u8().subarray(n_off, n_off + n_len));
                const s = l_dec.decode(a_u8().subarray(s_off, s_off + s_len));
                const d = e_reg[d_idx];
                try {
                    // Check if this is trying to detect global navigator or screen
                    const res = new Function(n, `
                        const screen = {
                            width: ${this.screenWidth},
                            height: ${this.screenHeight},
                            availWidth: ${this.screenWidth},
                            availHeight: ${this.screenHeight - 40},
                            colorDepth: ${this.colorDepth},
                            pixelDepth: ${this.colorDepth},
                            devicePixelRatio: ${this.devicePixelRatio}
                        };
                        const navigator = {
                            userAgent: "${this.userAgent}",
                            hardwareConcurrency: ${this.hardwareConcurrency},
                            deviceMemory: ${[4, 8, 16][Math.floor(Math.random() * 3)]},
                            languages: ["en-US", "en"],
                            platform: "Win32",
                            maxTouchPoints: 0
                        };
                        return (function(){ ${s} }).call(arguments[0]);
                    `)(d);
                    t_set(r, [false, res]);
                } catch (e) {
                    console.error(`[FUNCTION ERROR] Shim 217: ${e.message}`);
                    t_set(r, [true, e]);
                }
            });
            s_set(220, () => 1);
            s_set(221, () => this.screenWidth);
            s_set(222, () => this.screenHeight);
            s_set(223, (value, xor, type, address) => {
                if (!type) {
                    // Incoming packet byte handler
                    if (this.newPacketMessage) {
                        // Previous packet ended, determine if handshake is done
                        const header = this.messagePacket[0];
                        // 82 = 'R' (Room Info), 117 = 'u' (Update), 74 = 'J' (Join)
                        if (!this.isReady && (header === 82 || header === 117 || header === 74)) {
                            this.isReady = true;
                            this.emit('log', `WASM Handshake complete (detected header ${header})`);
                            this.emit('ready');
                            if (this.pendingSpawn) {
                                this.spawn(this.pendingSpawn.name, this.pendingSpawn.party);
                                this.pendingSpawn = null;
                            }
                        }
                        this.messagePacket = [];
                        this.newPacketMessage = false;
                    }
                    this.messagePacket = this.messagePacket || [];
                    let decoded_value = (value ^ xor) & 255;
                    this.messagePacket.push(decoded_value);
                } else {
                    // Outgoing packet byte handler
                    if (this.newPacketSend) {
                        this.sendPacket = [];
                        this.newPacketSend = false;
                    }
                    this.sendPacket = this.sendPacket || [];
                    this.sendPacket.push(value);
                }
            });

            s_set(224, (index, slice) => {
                // Check if this is an analytics packet (starts with 84 / 'T')
                if (a_u8()[index] === 84) {
                    return 0; // Block analytics
                }

                // Inject our own constructed packets (spawn, etc)
                const next = this.packetQueue.shift();
                if (next) {
                    a_u8().set(next, 0);
                    this.emit('log', `Injected packet (length ${next.byteLength}, type ${next[0]})`);
                    return next.byteLength;
                }
                return 0;
            });
            s_set(225, (idx) => { u_str(idx, 'arras.io'); });

            const importObject = { "0": shims };
            const { instance } = await WebAssembly.instantiate(wasmBuffer, importObject);
            this.wasmInstance = instance;
            f_exports = instance.exports;
            if (f_exports.b) f_exports.b();
        } catch (err) {
            this.emit('error', `Initialization failed: ${err.message}`);
            throw err;
        }
    }

    connect(url, agent = null, spoofIP = null) {
        try {
            url = url.trim().replace(/\s/g, '');
            if (spoofIP) {
                this.emit('log', `Connecting to ${url} (spoofed IP: ${spoofIP})...`);
            } else {
                this.emit('log', `Connecting to ${url}...`);
            }

            let urlObj;
            try {
                urlObj = new URL(url);
            } catch (e) {
                try {
                    urlObj = new URL('ws://' + url);
                } catch (e2) {
                    this.emit('error', `Invalid URL: ${url}`);
                    return;
                }
            }
            // Use normalized URL and extract hostname for the Host header
            url = urlObj.href;
            const host = urlObj.host;
            this.spoofIP = spoofIP;

            // Some servers look for IP in query params
            if (spoofIP) {
                const sep = url.includes('?') ? '&' : '?';
                url += `${sep}ip=${spoofIP}&_client=arras-client`;
            }

            const protocol = ["arras.io#v1.4+sls+et0", "arras.io"];
            const headers = {
                'Host': host,
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache',
                'User-Agent': this.userAgent,
                'Upgrade': 'websocket',
                'Origin': 'https://arras.io',
                'Sec-WebSocket-Version': '13',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Accept-Language': 'en-US,en;q=0.9,pl;q=0.8,is;q=0.7,da;q=0.6,no;q=0.5',
                'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
                'Sec-Fetch-Dest': 'websocket',
                'Sec-Fetch-Mode': 'websocket',
                'Sec-Fetch-Site': 'same-site',
                'Connection': 'Upgrade',
                'Cookie': `__cf_bm=${Math.random().toString(36).substring(2)}; arras-session=${Math.random().toString(36).substring(2)}`
            };

            if (spoofIP) {
                // Shotgun approach: both standard and lowercase versions
                headers['X-Forwarded-For'] = spoofIP;
                headers['x-forwarded-for'] = spoofIP;
                headers['X-Real-IP'] = spoofIP;
                headers['x-real-ip'] = spoofIP;
                headers['X-Client-IP'] = spoofIP;
                headers['x-client-ip'] = spoofIP;
                headers['Client-IP'] = spoofIP;
                headers['client-ip'] = spoofIP;
                headers['X-Originating-IP'] = spoofIP;
                headers['X-Remote-IP'] = spoofIP;
                headers['X-Remote-Addr'] = spoofIP;
                headers['True-Client-IP'] = spoofIP;
                headers['Forwarded'] = `for=${spoofIP};proto=https`;
            }

            const options = {
                headers: headers,
                agent: agent,
                handshakeTimeout: 15000
            };

            this.socket = new WebSocket(url, protocol, options);
            this.socket.binaryType = 'arraybuffer';
            this.socket.on('open', () => { this.emit('open'); this.emit('log', 'WebSocket opened'); });
            this.socket.on('message', (data) => { this.handleMessage(data); });
            this.socket.on('close', () => { this.emit('close'); this.emit('log', 'WebSocket closed'); });
            this.socket.on('error', (err) => { this.emit('error', `WebSocket error: ${err.message}`); });
        } catch (err) {
            this.emit('error', `Connection logic failed: ${err.message}`);
        }
    }

    handleMessage(data) {
        const buf = new Uint8Array(data);
        // Important: We do NOT push incoming data to packetQueue.
        // packetQueue is only for injecting outgoing packets via Shim 224.
        // Incoming messages are already handled by the WASM via the socket listener in Shim 191.

        if (this.wasmInstance && this.wasmInstance.exports.c) {
            this.wasmInstance.exports.c();
        }

        const decoded = decode_packet(buf);
        if (decoded) {
            this.emit('packet', decoded);
        }
    }

    spawn(name, party = "") {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            this.emit('error', 'Cannot spawn: WebSocket not open');
            return;
        }

        if (!this.isReady) {
            this.emit('log', `Spawn requested for "${name}", queueing until WASM is ready...`);
            this.pendingSpawn = { name, party };
            return;
        }

        const packet = construct_spawn_packet(name, party);
        this.packetQueue.push(packet);
        if (this.wasmInstance && this.wasmInstance.exports.c) {
            this.wasmInstance.exports.c();
        }
    }

    destroy() {
        if (this.socket) {
            // Remove checks to prevent firing events during destruction
            this.socket.removeAllListeners('error');
            this.socket.removeAllListeners('close');
            this.socket.removeAllListeners('message');
            this.socket.removeAllListeners('open');
            try {
                this.socket.terminate();
            } catch (e) { }
            this.socket = null;
        }
        this.removeAllListeners();
    }
}

module.exports = ArrasClient;
