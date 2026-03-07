const mongoose = require('mongoose');

// ── Player Schema ────────────────────────────────────────────────
const PlayerSchema = new mongoose.Schema({
    socketId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 20 },
    roomId: { type: String, default: null },
    color: { type: String, default: '#38bdf8' },
    isGhost: { type: Boolean, default: false },
    isHost: { type: Boolean, default: false },
    isAlive: { type: Boolean, default: true },
    coins: { type: Number, default: 50 },
    energy: { type: Number, default: 0 },
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    state: { type: String, default: 'ROAMING' }, // ROAMING | SLEEPING | DEAD
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

// ── Room Schema ──────────────────────────────────────────────────
const RoomSchema = new mongoose.Schema({
    roomId: { type: String, required: true, unique: true },
    hostId: { type: String, required: true },
    hostName: { type: String, required: true },
    status: { type: String, default: 'LOBBY', enum: ['LOBBY', 'PLAYING', 'FINISHED'] },
    players: [{ type: String }], // socket IDs
    playerNames: { type: Map, of: String, default: {} },
    playerColors: { type: Map, of: String, default: {} },
    ghostId: { type: String, default: null },
    maxPlayers: { type: Number, default: 7 },
    minPlayers: { type: Number, default: 3 },
    winner: { type: String, default: null }, // 'ghost' | 'survivors'
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    // Game stats persisted on finish
    stats: {
        duration: { type: Number, default: 0 },
        ghostKilled: { type: Boolean, default: false },
        survivorsAlive: { type: Number, default: 0 },
        ghostLevel: { type: Number, default: 1 },
    }
});

RoomSchema.pre('save', function (next) { this.updatedAt = Date.now(); next(); });

const Room = mongoose.model('Room', RoomSchema);
const Player = mongoose.model('Player', PlayerSchema);

module.exports = { Room, Player };