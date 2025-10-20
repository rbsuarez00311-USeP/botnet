#!/usr/bin/env node
/**
 * WebSocket System Server
 * Supports:
 * - Admin connections via Telnet
 * - Bot connections via WebSocket
 */

const net = require('net');
const { WebSocketServer } = require('ws');

// Configuration
const TELNET_PORT = 8023;
const WEBSOCKET_PORT = 8765;
const ADMIN_PASSWORD = '111111';

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
 * Handle admin telnet connection
 */
function handleAdminConnection(socket) {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[INFO] Admin connection from ${addr}`);

    let isAuthenticated = false;
    let passwordBuffer = '';

    // Send password prompt
    socket.write('Password: ');

    // Welcome message (shown after authentication)
    const welcome = 
        '============================================================\r\n' +
        'WebSocket System - Admin Console\r\n' +
        '============================================================\r\n' +
        'Commands:\r\n' +
        '  list                  - List all connected bots\r\n' +
        '  stats                 - Show connection statistics\r\n' +
        '  broadcast <message>   - Broadcast message to all bots\r\n' +
        '  send <bot_id> <msg>   - Send message to specific bot\r\n' +
        '  help                  - Show this help message\r\n' +
        '  quit                  - Disconnect from admin console\r\n' +
        '============================================================\r\n';

    let buffer = '';

    socket.on('data', (data) => {
        // Handle password authentication
        if (!isAuthenticated) {
            passwordBuffer += data.toString();
            
            // Check for newline (password submitted)
            const newlineIndex = passwordBuffer.indexOf('\n');
            if (newlineIndex !== -1) {
                const password = passwordBuffer.substring(0, newlineIndex).replace(/\r$/, '').trim();
                passwordBuffer = '';
                
                if (password === ADMIN_PASSWORD) {
                    isAuthenticated = true;
                    manager.addAdmin(socket);
                    socket.write('\r\nAuthentication successful!\r\n');
                    socket.write(welcome);
                    socket.write('admin> ');
                } else {
                    socket.write('\r\nAuthentication failed. Disconnecting...\r\n');
                    console.log(`[WARN] Failed authentication attempt from ${addr}`);
                    socket.end();
                }
            }
            return;
        }

        buffer += data.toString();

        // Process complete lines
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, newlineIndex).replace(/\r$/, '');
            buffer = buffer.substring(newlineIndex + 1);

            const command = line.trim();
            if (!command) {
                socket.write('admin> ');
                continue;
            }

            // Process commands
            if (command.toLowerCase() === 'quit') {
                socket.write('Goodbye!\r\n');
                socket.end();
                return;
            } else if (command.toLowerCase() === 'help') {
                socket.write(welcome);
            } else if (command.toLowerCase() === 'list') {
                const stats = manager.getStats();
                let response = `Connected bots (${stats.bots}):\r\n`;
                stats.bot_ids.forEach(botId => {
                    response += `  - ${botId}\r\n`;
                });
                socket.write(response);
            } else if (command.toLowerCase() === 'stats') {
                const stats = manager.getStats();
                const response = 
                    'Connection Statistics:\r\n' +
                    `  Admins: ${stats.admins}\r\n` +
                    `  Bots: ${stats.bots}\r\n`;
                socket.write(response);
            } else if (command.toLowerCase().startsWith('broadcast ')) {
                const message = command.substring(10).trim();
                if (message) {
                    manager.broadcastToBots({
                        type: 'broadcast',
                        message: message,
                        timestamp: new Date().toISOString()
                    });
                    socket.write(`Broadcasted to ${manager.botConnections.size} bots\r\n`);
                } else {
                    socket.write('Usage: broadcast <message>\r\n');
                }
            } else if (command.toLowerCase().startsWith('send ')) {
                const parts = command.substring(5).trim().split(/\s+/);
                if (parts.length >= 2) {
                    const botId = parts[0];
                    const message = parts.slice(1).join(' ');
                    const success = manager.sendToBot(botId, {
                        type: 'direct',
                        message: message,
                        timestamp: new Date().toISOString()
                    });
                    if (success) {
                        socket.write(`Sent to ${botId}\r\n`);
                    } else {
                        socket.write(`Bot ${botId} not found\r\n`);
                    }
                } else {
                    socket.write('Usage: send <bot_id> <message>\r\n');
                }
            } else {
                socket.write(`Unknown command: ${command}\r\n`);
                socket.write('Type \'help\' for available commands\r\n');
            }

            socket.write('admin> ');
        }
    });

    socket.on('error', (error) => {
        console.error(`[ERROR] Error in admin connection: ${error.message}`);
    });

    socket.on('close', () => {
        if (isAuthenticated) {
            manager.removeAdmin(socket);
        }
        console.log(`[INFO] Admin connection closed: ${addr}`);
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
        manager.broadcastToAdmins(`[SYSTEM] ${botId} connected`);

        // Handle bot messages
        websocket.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log(`[INFO] Message from ${botId}:`, message);

                // Forward bot messages to admins
                manager.broadcastToAdmins(
                    `[${botId}] ${message.message || JSON.stringify(message)}`
                );

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
                manager.broadcastToAdmins(`[SYSTEM] ${botId} disconnected`);
            }
        });
    } catch (error) {
        console.error(`[ERROR] Error handling bot connection: ${error.message}`);
        if (botId) {
            manager.removeBot(botId);
            manager.broadcastToAdmins(`[SYSTEM] ${botId} disconnected`);
        }
    }
}

/**
 * Start both telnet and WebSocket servers
 */
function main() {
    // Start telnet server for admin (port 8023)
    const telnetServer = net.createServer(handleAdminConnection);
    telnetServer.listen(TELNET_PORT, '0.0.0.0', () => {
        console.log(`[INFO] Admin telnet server started on port ${TELNET_PORT}`);
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
        console.log(`Admin: telnet localhost ${TELNET_PORT}`);
        console.log(`Bots: ws://localhost:${WEBSOCKET_PORT}`);
        console.log('============================================================');
    });

    wss.on('error', (error) => {
        console.error(`[ERROR] WebSocket server error: ${error.message}`);
    });

    telnetServer.on('error', (error) => {
        console.error(`[ERROR] Telnet server error: ${error.message}`);
    });

    // Handle shutdown
    process.on('SIGINT', () => {
        console.log('\n[INFO] Server stopped by user');
        telnetServer.close();
        wss.close();
        process.exit(0);
    });
}

// Start the server
if (require.main === module) {
    main();
}

module.exports = { ConnectionManager, handleAdminConnection, handleBotConnection };
