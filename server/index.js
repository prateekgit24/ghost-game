require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Room, Player } = require('./models');
const { ServerGame } = require('./gameState');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 20000,
    pingInterval: 10000,
});

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ghost-killer';

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

// ── IN-MEMORY ─────────────────────────────────────────────────────
// roomId → { room metadata, game instance, tickInterval }
const activeRooms = new Map();
// socketId → { name, roomId }
const connectedPlayers = new Map();

// ── MONGODB ───────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.warn('⚠️  MongoDB not available, running without persistence:', err.message));

// ── REST API ──────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Get room info (for joining)
app.get('/api/room/:roomId', async (req, res) => {
    const { roomId } = req.params;
    const room = activeRooms.get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found or already started' });
    res.json({
        roomId,
        hostName: room.meta.hostName,
        playerCount: room.meta.players.length,
        maxPlayers: 7,
        status: room.meta.status,
    });
});

// Leaderboard — top survivors
app.get('/api/leaderboard', async (req, res) => {
    try {
        const rooms = await Room.find({ status: 'FINISHED' })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();
        res.json(rooms);
    } catch (e) {
        res.json([]);
    }
});

// ── SOCKET.IO ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);

    // ── JOIN / CREATE ────────────────────────────────────────────
    socket.on('create_room', ({ name }, callback) => {
        if (!name || name.trim().length < 1) return callback({ error: 'Name required' });
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        const playerData = { id: socket.id, name: name.trim(), isHost: true };

        const roomMeta = {
            roomId,
            hostId: socket.id,
            hostName: name.trim(),
            status: 'LOBBY',
            players: [playerData],
        };
        activeRooms.set(roomId, { meta: roomMeta, game: null, tickInterval: null });
        connectedPlayers.set(socket.id, { name: name.trim(), roomId });
        socket.join(roomId);

        // Persist to mongo (non-blocking)
        new Room({ roomId, hostId: socket.id, hostName: name.trim(), players: [socket.id], playerNames: { [socket.id]: name.trim() } })
            .save().catch(() => { });

        console.log(`🏠 Room created: ${roomId} by ${name}`);
        callback({ ok: true, roomId, isHost: true, name: name.trim() });
        io.to(roomId).emit('lobby_update', buildLobbyState(roomId));
    });

    socket.on('join_room', ({ name, roomId }, callback) => {
        if (!name || name.trim().length < 1) return callback({ error: 'Name required' });
        const id = roomId?.toUpperCase();
        const roomData = activeRooms.get(id);
        if (!roomData) return callback({ error: 'Room not found. Check the Room ID.' });
        if (roomData.meta.status !== 'LOBBY') return callback({ error: 'Game already started!' });
        if (roomData.meta.players.length >= 7) return callback({ error: 'Room is full (max 7 players).' });

        const playerData = { id: socket.id, name: name.trim(), isHost: false };
        roomData.meta.players.push(playerData);
        connectedPlayers.set(socket.id, { name: name.trim(), roomId: id });
        socket.join(id);

        // Update mongo (non-blocking)
        Room.findOneAndUpdate({ roomId: id }, { $push: { players: socket.id }, $set: { [`playerNames.${socket.id}`]: name.trim() } }).catch(() => { });

        console.log(`👤 ${name} joined room ${id}`);
        callback({ ok: true, roomId: id, isHost: false, name: name.trim() });
        io.to(id).emit('lobby_update', buildLobbyState(id));
    });

    // ── START GAME ───────────────────────────────────────────────
    socket.on('start_game', (callback) => {
        const playerInfo = connectedPlayers.get(socket.id);
        if (!playerInfo) return callback?.({ error: 'Not in a room' });
        const { roomId } = playerInfo;
        const roomData = activeRooms.get(roomId);
        if (!roomData) return callback?.({ error: 'Room not found' });
        if (roomData.meta.hostId !== socket.id) return callback?.({ error: 'Only host can start' });
        if (roomData.meta.players.length < 3) return callback?.({ error: 'Need at least 3 players' });
        if (roomData.meta.status !== 'LOBBY') return callback?.({ error: 'Already started' });

        roomData.meta.status = 'PLAYING';
        const playerList = roomData.meta.players;
        const game = new ServerGame(roomId, playerList);
        roomData.game = game;

        // Tell everyone game is starting with initial state
        io.to(roomId).emit('game_start', game.getInitialState());
        Room.findOneAndUpdate({ roomId }, { status: 'PLAYING' }).catch(() => { });

        // Server tick at 20 FPS
        let lastTick = Date.now();
        roomData.tickInterval = setInterval(() => {
            const now = Date.now();
            const dt = Math.min((now - lastTick) / 1000, 0.1);
            lastTick = now;
            const state = game.tick(dt);
            if (state) io.to(roomId).emit('game_tick', state);
            if (game.gameOver) {
                clearInterval(roomData.tickInterval);
                io.to(roomId).emit('game_over', { winner: game.winner });
                _saveFinishedGame(roomId, game);
                activeRooms.delete(roomId);
            }
        }, 50); // 20 FPS server tick

        console.log(`🎮 Game started in room ${roomId} with ${playerList.length} players`);
        callback?.({ ok: true });
    });

    // ── IN-GAME EVENTS ───────────────────────────────────────────
    socket.on('player_move', ({ x, y, vx, vy, facing }) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return;
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return;
        rd.game.playerMove(socket.id, x, y, vx, vy, facing);
    });

    socket.on('ghost_move', ({ vx, vy, facing }) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return;
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return;
        rd.game.ghostMove(socket.id, vx, vy, facing);
    });

    socket.on('player_sleep', ({ roomIdx }, callback) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return callback?.({ ok: false });
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return callback?.({ ok: false });
        const ok = rd.game.playerSleep(socket.id, roomIdx);
        callback?.({ ok });
        if (ok) io.to(pi.roomId).emit('player_slept', { socketId: socket.id, roomIdx });
    });

    socket.on('player_build', ({ tileX, tileY, buildType }, callback) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return callback?.({ ok: false });
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return callback?.({ ok: false });
        const result = rd.game.playerBuild(socket.id, tileX, tileY, buildType);
        callback?.(result);
    });

    socket.on('player_upgrade', ({ type, tileX, tileY }, callback) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return callback?.({ ok: false });
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return callback?.({ ok: false });
        const result = rd.game.playerUpgrade(socket.id, type, tileX, tileY);
        callback?.(result);
    });

    socket.on('player_repair', (callback) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return callback?.({ ok: false });
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return;
        const ok = rd.game.playerRepair(socket.id);
        callback?.({ ok });
    });

    socket.on('player_use_grenade', (callback) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return;
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return;
        const result = rd.game.playerUseGrenade(socket.id);
        if (result) io.to(pi.roomId).emit('grenade_exploded', { by: socket.id, dmg: result.dmg });
        callback?.(result);
    });

    socket.on('player_use_net', (callback) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return;
        const rd = activeRooms.get(pi.roomId);
        if (!rd?.game) return;
        const ok = rd.game.playerUseGhostNet(socket.id);
        if (ok) io.to(pi.roomId).emit('ghost_netted', { by: socket.id });
        callback?.({ ok });
    });

    // ── CHAT ─────────────────────────────────────────────────────
    socket.on('chat_message', ({ text }) => {
        const pi = connectedPlayers.get(socket.id);
        if (!pi || !text) return;
        const rd = activeRooms.get(pi.roomId);
        if (!rd) return;
        const name = pi.name;
        io.to(pi.roomId).emit('chat_message', { name, text: text.slice(0, 80), time: Date.now() });
    });

    // ── DISCONNECT ───────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`❌ Disconnected: ${socket.id}`);
        const pi = connectedPlayers.get(socket.id);
        if (!pi) return;
        connectedPlayers.delete(socket.id);
        const { roomId } = pi;
        const rd = activeRooms.get(roomId);
        if (!rd) return;

        if (rd.meta.status === 'LOBBY') {
            rd.meta.players = rd.meta.players.filter(p => p.id !== socket.id);
            // If host left, assign new host or close room
            if (rd.meta.hostId === socket.id) {
                if (rd.meta.players.length > 0) {
                    rd.meta.hostId = rd.meta.players[0].id;
                    rd.meta.players[0].isHost = true;
                    io.to(rd.meta.players[0].id).emit('you_are_host');
                } else {
                    activeRooms.delete(roomId);
                    return;
                }
            }
            io.to(roomId).emit('lobby_update', buildLobbyState(roomId));
        } else if (rd.meta.status === 'PLAYING' && rd.game) {
            // Mark player as dead
            const gp = rd.game.players[socket.id];
            if (gp) {
                gp.state = 'DEAD';
                // If the ghost disconnected, hand AI control over the ghost
                if (gp.isGhost) rd.game.ghostDisconnected();
            }
            io.to(roomId).emit('player_disconnected', { id: socket.id, name: pi.name });
        }
    });
});

// ── HELPERS ───────────────────────────────────────────────────────
function buildLobbyState(roomId) {
    const rd = activeRooms.get(roomId);
    if (!rd) return null;
    return {
        roomId,
        hostId: rd.meta.hostId,
        players: rd.meta.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
        status: rd.meta.status,
    };
}

async function _saveFinishedGame(roomId, game) {
    try {
        const survivors = Object.values(game.players).filter(p => !p.isGhost && p.state !== 'DEAD').length;
        await Room.findOneAndUpdate({ roomId }, {
            status: 'FINISHED',
            winner: game.winner,
            stats: {
                duration: game.getDuration(),
                ghostKilled: game.winner === 'survivors',
                survivorsAlive: survivors,
                ghostLevel: game.ghost?.ghostLevel || 1,
            }
        });
    } catch (e) { /* non-critical */ }
}

// ── START ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n🚀 Ghost Killer Server running on http://localhost:${PORT}`);
    console.log(`📡 Socket.IO ready`);
    console.log(`🌍 Serving client from /client/public\n`);
});






















