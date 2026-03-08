// ================================================================
//  Ghost Killer — Server-Authoritative Game State
// ================================================================

const TILE_SIZE = 48;
const MAP_W = 60;
const MAP_H = 60;
const NUM_ROOMS = 18;
const ENTITY_RADIUS = 14;
const GHOST_RADIUS = 16;

const DOOR_HPS = [100, 300, 800, 2000, 5000, 12000, 25000, 50000, 100000, 250000, 500000, 1000000];
const BED_INCOME = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const TURRET_DMG = [10, 25, 60, 150, 400, 1000, 2500, 5000, 12000, 25000, 60000, 150000];
const TURRET_RNG = [250, 275, 300, 325, 350, 375, 400, 425, 450, 475, 500, 550];
const GEN_INCOME = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const MINE_INCOME = {
    copper: [2, 4, 8, 16, 32, 64],
    silver: [6, 12, 24, 48, 96, 192],
    gold: [15, 30, 60, 120, 240, 480],
};
const PLAYER_COLORS = ['#38bdf8', '#a3e635', '#f472b6', '#fbbf24', '#c084fc', '#2dd4bf', '#fb923c'];

// The 4 edge heal slots — one at each cardinal edge, centred on the map opening.
// These match exactly the corridor gaps cut in generateMap().
const HEAL_SPOTS = [
    { x: Math.floor(MAP_W / 2), y: 2 },           // north
    { x: Math.floor(MAP_W / 2), y: MAP_H - 3 },   // south
    { x: 2, y: Math.floor(MAP_H / 2) }, // west
    { x: MAP_W - 3, y: Math.floor(MAP_H / 2) }, // east
];
// ghostSpots = same 4 locations (ghost spawns at one of them)
const ghostSpots = HEAL_SPOTS;

function dist(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); }

function generateMap() {
    const map = [];
    for (let y = 0; y < MAP_H; y++) { map[y] = []; for (let x = 0; x < MAP_W; x++) map[y][x] = 0; }
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++)
        if (x < 4 || x >= MAP_W - 4 || y < 4 || y >= MAP_H - 4) map[y][x] = 1;
    const cx = Math.floor(MAP_W / 2), cy = Math.floor(MAP_H / 2);
    for (let y = 1; y < 4; y++) for (let x = cx - 1; x <= cx + 1; x++) map[y][x] = 0;
    for (let y = MAP_H - 4; y < MAP_H - 1; y++) for (let x = cx - 1; x <= cx + 1; x++) map[y][x] = 0;
    for (let x = 1; x < 4; x++) for (let y = cy - 1; y <= cy + 1; y++) map[y][x] = 0;
    for (let x = MAP_W - 4; x < MAP_W - 1; x++) for (let y = cy - 1; y <= cy + 1; y++) map[y][x] = 0;
    return map;
}

function generateRooms(map) {
    const rooms = [];
    const cx = Math.floor(MAP_W / 2), cy = Math.floor(MAP_H / 2);
    let attempts = 0;
    while (rooms.length < NUM_ROOMS && attempts < 2000) {
        attempts++;
        const rw = Math.floor(Math.random() * 5) + 5;
        const rh = Math.floor(Math.random() * 5) + 5;
        const rx = Math.floor(Math.random() * (MAP_W - rw - 12)) + 6;
        const ry = Math.floor(Math.random() * (MAP_H - rh - 12)) + 6;
        let overlap = false;
        if (rx < cx + 7 && rx + rw > cx - 7 && ry < cy + 7 && ry + rh > cy - 7) overlap = true;
        if (!overlap) for (const r of rooms)
            if (rx < r.x + r.w + 3 && rx + rw + 3 > r.x && ry < r.y + r.h + 3 && ry + rh + 3 > r.y) { overlap = true; break; }
        if (overlap) continue;
        for (let y = ry - 1; y <= ry + rh; y++) for (let x = rx - 1; x <= rx + rw; x++)
            if (x === rx - 1 || x === rx + rw || y === ry - 1 || y === ry + rh) map[y][x] = 1;
        const doorSide = Math.floor(Math.random() * 4);
        let ddx, ddy;
        if (doorSide === 0) { ddx = rx + Math.floor(rw / 2); ddy = ry - 1; }
        else if (doorSide === 1) { ddx = rx + Math.floor(rw / 2); ddy = ry + rh; }
        else if (doorSide === 2) { ddx = rx - 1; ddy = ry + Math.floor(rh / 2); }
        else { ddx = rx + rw; ddy = ry + Math.floor(rh / 2); }
        map[ddy][ddx] = 2;
        let bx = rx + Math.floor(rw / 2), by = ry + Math.floor(rh / 2);
        if (doorSide === 0) by = ry + rh - 2;
        else if (doorSide === 1) by = ry + 1;
        else if (doorSide === 2) bx = rx + rw - 2;
        else bx = rx + 1;
        rooms.push({
            id: rooms.length, x: rx, y: ry, w: rw, h: rh,
            door: { x: ddx, y: ddy, hp: DOOR_HPS[0], maxHp: DOOR_HPS[0], level: 0, hitTimer: 0, shieldActive: false, shieldUsed: false },
            bed: { x: bx, y: by, level: 0 },
            turrets: [], generators: [], mines: [],
            grenades: [], shields: [],    // tile-placed objects
            owner: null,
            _hasGrenadeLauncher: false, _hasGhostNet: false, _hasShield: false, _hasRepairTool: false,
        });
    }
    return rooms;
}

// tile=1: solid wall — always blocks.
// tile=2: door — only blocks if the room has an owner (sleeping player inside) AND hp>0.
//         Empty rooms (no owner) are freely enterable by anyone.
function tileBlocks(map, rooms, tx, ty) {
    if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return true;
    if (map[ty][tx] === 1) return true;
    if (map[ty][tx] === 2) {
        const room = rooms.find(r => r.door.x === tx && r.door.y === ty);
        if (!room || !room.owner) return false;  // empty room: never blocks
        return room.door.hp > 0;                 // owned room: blocks while door has HP
    }
    return false;
}

function checkWallCollision(map, rooms, nx, ny, radius) {
    const r = radius - 2;
    const pts = [
        { x: nx - r, y: ny - r }, { x: nx, y: ny - r }, { x: nx + r, y: ny - r },
        { x: nx - r, y: ny }, { x: nx + r, y: ny },
        { x: nx - r, y: ny + r }, { x: nx, y: ny + r }, { x: nx + r, y: ny + r },
    ];
    for (const p of pts)
        if (tileBlocks(map, rooms, Math.floor(p.x / TILE_SIZE), Math.floor(p.y / TILE_SIZE))) return true;
    return false;
}

function moveWithCollision(map, rooms, x, y, vx, vy, speed, dt, radius) {
    const STEPS = 6;
    let nx = x, ny = y;
    const dx = (vx * speed * dt) / STEPS;
    const dy = (vy * speed * dt) / STEPS;
    for (let i = 0; i < STEPS; i++) {
        if (!checkWallCollision(map, rooms, nx + dx, ny, radius)) nx += dx;
        if (!checkWallCollision(map, rooms, nx, ny + dy, radius)) ny += dy;
    }
    return { x: nx, y: ny };
}

function validateClientPos(map, rooms, sx, sy, cx, cy, radius) {
    if (!checkWallCollision(map, rooms, cx, cy, radius)) return { x: cx, y: cy };
    return { x: sx, y: sy };
}

// ── BFS ───────────────────────────────────────────────────────────
// Destination tile always walkable (so ghost can path TO the door).
// All other door tiles are treated as walls.
function getPathNextNode(map, rooms, sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return null;
    const visited = new Uint8Array(MAP_W * MAP_H);
    const queue = [{ x: sx, y: sy, path: [] }];
    visited[sy * MAP_W + sx] = 1;
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    let steps = 0;
    while (queue.length > 0 && steps++ < 5000) {
        const curr = queue.shift();
        if (curr.x === tx && curr.y === ty) return curr.path[0] || null;
        for (const [ddx, ddy] of dirs) {
            const nx = curr.x + ddx, ny = curr.y + ddy;
            if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H || visited[ny * MAP_W + nx]) continue;
            visited[ny * MAP_W + nx] = 1;
            const isDest = (nx === tx && ny === ty);
            let walkable = true;
            if (map[ny][nx] === 1) walkable = false;
            else if (map[ny][nx] === 2 && !isDest) walkable = false;  // all doors block BFS
            if (walkable) queue.push({ x: nx, y: ny, path: curr.path.concat({ x: nx, y: ny }) });
        }
    }
    return null;
}

// ── SERVER GAME ───────────────────────────────────────────────────
class ServerGame {
    constructor(roomId, playerList) {
        this.roomId = roomId;
        this.map = generateMap();
        this.rooms = generateRooms(this.map);
        this.players = {};
        this.ghost = null;
        this.ghostIsBot = false;
        this.ghostTimer = 25;
        this.gameOver = false;
        this.winner = null;
        this.startTime = Date.now();
        this.healSpots = HEAL_SPOTS;  // exposed to client for rendering

        const ids = playerList.map(p => p.id);
        const ghostId = ids[Math.floor(Math.random() * ids.length)];
        const cx = Math.floor(MAP_W / 2) * TILE_SIZE + TILE_SIZE / 2;
        const cy = Math.floor(MAP_H / 2) * TILE_SIZE + TILE_SIZE / 2;
        const sp = ghostSpots[Math.floor(Math.random() * ghostSpots.length)];

        playerList.forEach((p, i) => {
            const isGhost = p.id === ghostId;
            this.players[p.id] = {
                id: p.id, name: p.name,
                color: isGhost ? '#ef4444' : PLAYER_COLORS[i % PLAYER_COLORS.length],
                isGhost,
                x: isGhost ? sp.x * TILE_SIZE + TILE_SIZE / 2 : cx + (Math.random() - .5) * 100,
                y: isGhost ? sp.y * TILE_SIZE + TILE_SIZE / 2 : cy + (Math.random() - .5) * 100,
                vx: 0, vy: 0, facing: 0,
                speed: isGhost ? 130 : 220,
                state: 'ROAMING',
                hp: isGhost ? 1000 : 100, maxHp: isGhost ? 1000 : 100,
                coins: isGhost ? 0 : 50, energy: 0, room: null,
                ghostLevel: 1, ghostXp: 0,
                ghostAttackTimer: 0,  // for AI door attacks
                ghostDoorTimer: 0,    // FIX: separate timer for human door attacks
                ghostBodyTimer: 0,    // FIX: separate timer for human body attacks
                ghostState: 'WAITING', ghostTarget: null,
                ghostPathTimer: 0, _ghostPathCache: null, ghostStunTimer: 0,
                ghostHealTarget: null,  // index into HEAL_SPOTS when HEALING
                repairActive: false, repairActiveTimer: 0, repairCooldown: 0,
                _resourceTimer: 0,
            };
        });
        this.ghost = Object.values(this.players).find(p => p.isGhost);
    }

    tick(dt) {
        if (this.gameOver) return null;

        if (this.ghostTimer > 0) {
            this.ghostTimer = Math.max(0, this.ghostTimer - dt);
            if (this.ghostTimer <= 0 && this.ghost) {
                this.ghostTimer = 0;
                this.ghost.ghostState = 'HUNTING';
            }
        }

        for (const p of Object.values(this.players)) {
            if (p.isGhost || p.state === 'DEAD') continue;
            if (p.state === 'SLEEPING' && p.room !== null) {
                const room = this.rooms[p.room];
                if (!room) continue;
                p._resourceTimer += dt;
                if (p._resourceTimer >= 1.0) {
                    p._resourceTimer -= 1.0;
                    let cInc = BED_INCOME[room.bed.level];
                    for (const g of room.generators) cInc += GEN_INCOME[g.level - 1];
                    for (const m of room.mines) { const arr = MINE_INCOME[m.type]; cInc += arr[Math.min(m.level - 1, arr.length - 1)]; }
                    p.coins += cInc;
                    p.energy += room.generators.reduce((s, g) => s + GEN_INCOME[g.level - 1], 0);
                }
                if (p.repairActive) {
                    p.repairActiveTimer -= dt;
                    const rate = (room._hasRepairTool ? 0.15 : 0.08) * room.door.maxHp * dt;
                    room.door.hp = Math.min(room.door.maxHp, room.door.hp + rate);
                    if (p.repairActiveTimer <= 0) { p.repairActive = false; p.repairCooldown = 60; }
                }
                if (p.repairCooldown > 0) p.repairCooldown = Math.max(0, p.repairCooldown - dt);
            }
        }

        if (this.ghost && this.ghost.state !== 'DEAD') {
            if (this.ghostTimer <= 0) {
                if (this.ghostIsBot) this._updateGhost(dt);
                else this._applyGhostPlayerInput(dt);
            }
        }

        this._updateTurrets(dt);
        for (const r of this.rooms) if (r.door.hitTimer > 0) r.door.hitTimer -= dt;

        const aliveHumans = Object.values(this.players).filter(p => !p.isGhost && p.state !== 'DEAD');
        if (aliveHumans.length === 0 && Object.keys(this.players).length > 1) { this.gameOver = true; this.winner = 'ghost'; }
        if (this.ghost && this.ghost.state === 'DEAD') { this.gameOver = true; this.winner = 'survivors'; }

        return this.getState();
    }

    _updateGhost(dt) {
        const g = this.ghost;
        if (!g || g.state === 'DEAD') return;
        if (g.ghostStunTimer > 0) { g.ghostStunTimer -= dt; return; }

        const xpReq = g.ghostLevel * 200;
        g.ghostXp += 5 * dt;
        if (g.ghostXp >= xpReq) { g.ghostXp -= xpReq; g.ghostLevel++; g.maxHp = Math.floor(g.maxHp * 1.6); g.hp = g.maxHp; g.speed = Math.min(200, g.speed + 5); }
        if (g.ghostLevel >= 3 && g.hp < g.maxHp) g.hp = Math.min(g.maxHp, g.hp + g.ghostLevel * 2 * dt);

        const targets = Object.values(this.players).filter(p => !p.isGhost && p.state !== 'DEAD');
        if (!targets.length) return;
        const curTarget = g.ghostTarget && this.players[g.ghostTarget];
        if (!curTarget || curTarget.state === 'DEAD') {
            g.ghostTarget = targets.sort((a, b) => dist(g.x, g.y, a.x, a.y) - dist(g.x, g.y, b.x, b.y))[0].id;
            g.ghostState = 'HUNTING'; g._ghostPathCache = null;
        }

        const tgt = this.players[g.ghostTarget];
        if (!tgt || tgt.state === 'DEAD') { g.ghostTarget = null; g.ghostState = 'HUNTING'; return; }

        // ── HEAL CHECK: if HP < 30% and not already healing, retreat to nearest spot ──
        if (g.ghostState !== 'HEALING' && g.hp < g.maxHp * 0.30) {
            let bestIdx = 0, bestDist = Infinity;
            HEAL_SPOTS.forEach((s, i) => {
                const d = dist(g.x, g.y, s.x * TILE_SIZE + TILE_SIZE / 2, s.y * TILE_SIZE + TILE_SIZE / 2);
                if (d < bestDist) { bestDist = d; bestIdx = i; }
            });
            g.ghostHealTarget = bestIdx;
            g.ghostState = 'HEALING';
            g._ghostPathCache = null;
        }

        // ── STATE MACHINE — strict else-if so only ONE block fires per tick ──
        if (g.ghostState === 'HEALING') {
            const si = g.ghostHealTarget ?? 0;
            const spot = HEAL_SPOTS[si];
            const spx = spot.x * TILE_SIZE + TILE_SIZE / 2;
            const spy = spot.y * TILE_SIZE + TILE_SIZE / 2;
            const dd = dist(g.x, g.y, spx, spy);
            if (dd > 10) {
                this._bfsMove(g, spot.x, spot.y, spx, spy, dt);
            }
            // Rapid heal while at spot (5% maxHp per second)
            if (dd < TILE_SIZE * 1.5) {
                g.hp = Math.min(g.maxHp, g.hp + g.maxHp * 0.05 * dt);
            }
            // Leave once HP > 70%
            if (g.hp >= g.maxHp * 0.70) {
                g.ghostState = 'HUNTING';
                g.ghostHealTarget = null;
                g._ghostPathCache = null;
            }
        } else if (g.ghostState === 'HUNTING') {
            if (tgt.state === 'ROAMING') {
                this._bfsMove(g, Math.floor(tgt.x / TILE_SIZE), Math.floor(tgt.y / TILE_SIZE), tgt.x, tgt.y, dt);
                if (dist(g.x, g.y, tgt.x, tgt.y) < GHOST_RADIUS + ENTITY_RADIUS) {
                    tgt.state = 'DEAD'; tgt.hp = 0; g.ghostXp += 150;
                    g.ghostTarget = null; g._ghostPathCache = null;
                }
            } else if (tgt.room !== null) {
                const room = this.rooms[tgt.room];
                if (!room) { g.ghostTarget = null; return; }
                const ap = this._approachTile(room);
                this._bfsMove(g, ap.tx, ap.ty, ap.px, ap.py, dt);
                if (dist(g.x, g.y, ap.px, ap.py) < TILE_SIZE * 1.5) {
                    g.ghostState = 'APPROACHING_DOOR'; g._ghostPathCache = null;
                }
            }
        } else if (g.ghostState === 'APPROACHING_DOOR') {
            if (tgt.room === null) { g.ghostState = 'HUNTING'; return; }
            const room = this.rooms[tgt.room];
            if (!room) { g.ghostState = 'HUNTING'; return; }
            const ap = this._approachTile(room);
            const dd = dist(g.x, g.y, ap.px, ap.py);
            if (dd > 6) {
                const a = Math.atan2(ap.py - g.y, ap.px - g.x);
                const moved = moveWithCollision(this.map, this.rooms, g.x, g.y, Math.cos(a), Math.sin(a), g.speed * 0.6, dt, GHOST_RADIUS);
                g.x = moved.x; g.y = moved.y; g.facing = a;
            } else { g.ghostState = 'ATTACKING'; g.ghostAttackTimer = 0; }
        } else if (g.ghostState === 'ATTACKING') {
            if (tgt.room === null || tgt.state === 'DEAD') { g.ghostState = 'HUNTING'; return; }
            const room = this.rooms[tgt.room];
            if (!room) { g.ghostState = 'HUNTING'; return; }
            const door = room.door;
            if (door.hp <= 0) { g.ghostState = 'CROSSING'; g._ghostPathCache = null; return; }
            g.ghostAttackTimer += dt;
            if (g.ghostAttackTimer >= 0.4) {
                g.ghostAttackTimer = 0;
                const dmg = 30 + g.ghostLevel * 15;
                door.hp -= dmg; door.hitTimer = 0.2; g.ghostXp += 30;
                if (!door.shieldUsed && door.hp / door.maxHp < 0.3 && room._hasShield) {
                    door.shieldActive = true; door.shieldUsed = true;
                    door.hp = Math.min(door.hp + door.maxHp * 0.3, door.maxHp * 0.6);
                    room._hasShield = false;
                }
                if (door.hp <= 0) { door.hp = 0; g.ghostXp += 200; g.ghostState = 'CROSSING'; g._ghostPathCache = null; }
            }
            // Keep ghost glued at approach tile while hammering door
            const ap = this._approachTile(room);
            if (dist(g.x, g.y, ap.px, ap.py) > 8) {
                const a = Math.atan2(ap.py - g.y, ap.px - g.x);
                const glue = moveWithCollision(this.map, this.rooms, g.x, g.y, Math.cos(a), Math.sin(a), g.speed * 0.2, dt, GHOST_RADIUS);
                g.x = glue.x; g.y = glue.y;
            }
        } else if (g.ghostState === 'CROSSING') {
            if (tgt.state === 'DEAD' || tgt.room === null) { g.ghostState = 'HUNTING'; return; }
            const room = this.rooms[tgt.room];
            if (!room) { g.ghostState = 'HUNTING'; return; }
            if (room.door.hp > 0) { g.ghostState = 'ATTACKING'; g.ghostAttackTimer = 0; return; }
            const gpx = room.door.x * TILE_SIZE + TILE_SIZE / 2;
            const gpy = room.door.y * TILE_SIZE + TILE_SIZE / 2;
            const dd = dist(g.x, g.y, gpx, gpy);
            if (dd > 8) {
                const a = Math.atan2(gpy - g.y, gpx - g.x);
                const moved = moveWithCollision(this.map, this.rooms, g.x, g.y, Math.cos(a), Math.sin(a), g.speed * 1.4, dt, GHOST_RADIUS);
                g.x = moved.x; g.y = moved.y; g.facing = a;
            } else { g.ghostState = 'INSIDE'; g.ghostAttackTimer = 0; }
        } else if (g.ghostState === 'INSIDE') {
            if (tgt.state === 'DEAD' || tgt.room === null) {
                g.ghostState = 'HUNTING'; g.ghostTarget = null; g._ghostPathCache = null; return;
            }
            const dx = tgt.x - g.x, dy = tgt.y - g.y, dd = Math.sqrt(dx * dx + dy * dy);
            if (dd > 2) {
                const moved = moveWithCollision(this.map, this.rooms, g.x, g.y, dx / dd, dy / dd, g.speed, dt, GHOST_RADIUS);
                g.x = moved.x; g.y = moved.y; g.facing = Math.atan2(dy, dx);
            }
            if (dd < GHOST_RADIUS + ENTITY_RADIUS + 6) {
                g.ghostAttackTimer += dt;
                if (g.ghostAttackTimer >= 0.4) {
                    g.ghostAttackTimer = 0;
                    const dmg = 30 + g.ghostLevel * 15;
                    tgt.hp -= dmg;
                    if (tgt.hp <= 0) {
                        tgt.hp = 0; tgt.state = 'DEAD'; g.ghostXp += 200;
                        g.ghostTarget = null; g.ghostState = 'HUNTING'; g._ghostPathCache = null;
                    }
                }
            }
        }
    }

    // ── HUMAN GHOST INPUT ─────────────────────────────────────────
    // FIX: separate ghostDoorTimer and ghostBodyTimer so door attacks
    // and player attacks don't share/corrupt the same counter.
    _applyGhostPlayerInput(dt) {
        const g = this.ghost;
        if (!g || g.state === 'DEAD' || this.ghostTimer > 0) return;

        if (g.ghostStunTimer > 0) { g.ghostStunTimer -= dt; return; }

        // Move
        const moved = moveWithCollision(this.map, this.rooms, g.x, g.y, g.vx || 0, g.vy || 0, g.speed, dt, GHOST_RADIUS);
        g.x = moved.x; g.y = moved.y;

        // Tick both attack timers every frame
        g.ghostDoorTimer = (g.ghostDoorTimer || 0) + dt;
        g.ghostBodyTimer = (g.ghostBodyTimer || 0) + dt;

        for (const p of Object.values(this.players)) {
            if (p.isGhost || p.state === 'DEAD') continue;
            const d = dist(g.x, g.y, p.x, p.y);

            if (p.state === 'ROAMING') {
                if (d < GHOST_RADIUS + ENTITY_RADIUS) {
                    p.state = 'DEAD'; p.hp = 0; g.ghostXp += 200;
                }
                continue;
            }

            if (p.state === 'SLEEPING' && p.room !== null) {
                const room = this.rooms[p.room];
                if (!room) continue;
                const door = room.door;
                const doorPx = door.x * TILE_SIZE + TILE_SIZE / 2;
                const doorPy = door.y * TILE_SIZE + TILE_SIZE / 2;
                const doorDist = dist(g.x, g.y, doorPx, doorPy);

                // Attack door (separate timer — ghostDoorTimer)
                if (door.hp > 0 && doorDist < TILE_SIZE * 1.8) {
                    if (g.ghostDoorTimer >= 0.4) {
                        g.ghostDoorTimer = 0;
                        const dmg = 30 + g.ghostLevel * 15;
                        door.hp -= dmg; door.hitTimer = 0.2; g.ghostXp += 30;
                        if (!door.shieldUsed && door.hp / door.maxHp < 0.3 && room._hasShield) {
                            door.shieldActive = true; door.shieldUsed = true;
                            door.hp = Math.min(door.hp + door.maxHp * 0.3, door.maxHp * 0.6);
                            room._hasShield = false;
                        }
                        if (door.hp <= 0) { door.hp = 0; g.ghostXp += 200; }
                    }
                }

                // Attack survivor body (separate timer — ghostBodyTimer)
                if (door.hp <= 0 && d < GHOST_RADIUS + ENTITY_RADIUS + 6) {
                    if (g.ghostBodyTimer >= 0.4) {
                        g.ghostBodyTimer = 0;
                        const dmg = 30 + g.ghostLevel * 15;
                        p.hp -= dmg;
                        if (p.hp <= 0) { p.hp = 0; p.state = 'DEAD'; g.ghostXp += 200; }
                    }
                }
            }
        }

        // XP / level-up
        const xpReq = g.ghostLevel * 200;
        if (g.ghostXp >= xpReq) {
            g.ghostXp -= xpReq; g.ghostLevel++;
            g.maxHp = Math.floor(g.maxHp * 1.6); g.hp = g.maxHp;
            g.speed = Math.min(200, g.speed + 5);
        }
        if (g.ghostLevel >= 3 && g.hp < g.maxHp)
            g.hp = Math.min(g.maxHp, g.hp + g.ghostLevel * 2 * dt);

        // Rapid heal on any heal spot (human ghost navigates there manually)
        for (const spot of HEAL_SPOTS) {
            const spx = spot.x * TILE_SIZE + TILE_SIZE / 2;
            const spy = spot.y * TILE_SIZE + TILE_SIZE / 2;
            if (dist(g.x, g.y, spx, spy) < TILE_SIZE * 1.5) {
                g.hp = Math.min(g.maxHp, g.hp + g.maxHp * 0.05 * dt);
                break;
            }
        }
    }

    _bfsMove(g, destTx, destTy, destPx, destPy, dt) {
        const gTx = Math.floor(g.x / TILE_SIZE), gTy = Math.floor(g.y / TILE_SIZE);
        g.ghostPathTimer = (g.ghostPathTimer || 0) + dt;
        if (!g._ghostPathCache || g.ghostPathTimer > 0.4) {
            g.ghostPathTimer = 0;
            g._ghostPathCache = getPathNextNode(this.map, this.rooms, gTx, gTy, destTx, destTy);
        }
        let tpx = destPx, tpy = destPy;
        if (g._ghostPathCache) {
            tpx = g._ghostPathCache.x * TILE_SIZE + TILE_SIZE / 2;
            tpy = g._ghostPathCache.y * TILE_SIZE + TILE_SIZE / 2;
            if (dist(g.x, g.y, tpx, tpy) < TILE_SIZE * 0.6) g._ghostPathCache = null;
        }
        const a = Math.atan2(tpy - g.y, tpx - g.x);
        const moved = moveWithCollision(this.map, this.rooms, g.x, g.y, Math.cos(a), Math.sin(a), g.speed, dt, GHOST_RADIUS);
        g.x = moved.x; g.y = moved.y; g.facing = a;
    }

    _approachTile(room) {
        const { x: gx, y: gy } = room.door, { x: rx, y: ry, w, h } = room;
        let tx, ty;
        if (gy === ry - 1) { tx = gx; ty = gy - 1; }
        else if (gy === ry + h) { tx = gx; ty = gy + 1; }
        else if (gx === rx - 1) { tx = gx - 1; ty = gy; }
        else { tx = gx + 1; ty = gy; }
        return { tx, ty, px: tx * TILE_SIZE + TILE_SIZE / 2, py: ty * TILE_SIZE + TILE_SIZE / 2 };
    }

    _updateTurrets(dt) {
        const g = this.ghost;
        if (!g || g.state === 'DEAD' || g.ghostState === 'WAITING') return;
        for (const room of this.rooms) {
            if (!room.owner) continue;
            const owner = this.players[room.owner];
            if (!owner || owner.state === 'DEAD') continue;
            for (const t of room.turrets) {
                const ttx = t.x * TILE_SIZE + TILE_SIZE / 2, tty = t.y * TILE_SIZE + TILE_SIZE / 2;
                const range = TURRET_RNG[t.level - 1];
                const dg = dist(ttx, tty, g.x, g.y);
                if (dg < range) t.angle = Math.atan2(g.y - tty, g.x - ttx);
                t.lastFire = (t.lastFire || 0) + dt;
                if (t.lastFire >= 0.8 && dg < range) {
                    t.lastFire = 0;
                    g.hp -= TURRET_DMG[t.level - 1];
                    if (g.hp <= 0) { g.hp = 0; g.state = 'DEAD'; this.gameOver = true; this.winner = 'survivors'; }
                }
            }
        }
    }

    playerSleep(socketId, roomIdx) {
        const p = this.players[socketId], room = this.rooms[roomIdx];
        if (!p || !room || room.owner || p.state !== 'ROAMING') return false;
        p.state = 'SLEEPING'; p.room = roomIdx;
        p.x = room.bed.x * TILE_SIZE + TILE_SIZE / 2;
        p.y = room.bed.y * TILE_SIZE + TILE_SIZE / 2;
        room.owner = socketId; return true;
    }

    playerBuild(socketId, tileX, tileY, buildType) {
        const p = this.players[socketId];
        if (!p || p.state !== 'SLEEPING' || p.room === null) return { ok: false };
        const room = this.rooms[p.room];
        if (!room) return { ok: false };
        if (tileX < room.x || tileX >= room.x + room.w || tileY < room.y || tileY >= room.y + room.h) return { ok: false };
        const COSTS = { turret: 30, generator: 50, copper_mine: 40, silver_mine: 120, gold_mine: 300, grenade_launcher: 200, ghost_net: 350, door_shield: 250, repair_tool: 150 };
        const cost = COSTS[buildType];
        if (!cost || p.coins < cost) return { ok: false, reason: 'Not enough coins' };
        const occupied = [...room.turrets, ...room.generators, ...room.mines, ...room.grenades, ...room.shields]
            .some(t => t.x === tileX && t.y === tileY);
        if (occupied || (tileX === room.bed.x && tileY === room.bed.y)) return { ok: false, reason: 'Tile occupied' };
        p.coins -= cost;
        if (buildType === 'turret') room.turrets.push({ x: tileX, y: tileY, level: 1, lastFire: 0, angle: 0 });
        else if (buildType === 'generator') room.generators.push({ x: tileX, y: tileY, level: 1 });
        else if (['copper_mine', 'silver_mine', 'gold_mine'].includes(buildType))
            room.mines.push({ x: tileX, y: tileY, type: buildType.replace('_mine', ''), level: 1 });
        else if (buildType === 'grenade_launcher') {
            room.grenades.push({ x: tileX, y: tileY });
            room._hasGrenadeLauncher = true;  // boolean flag for HUD/logic compat
        } else if (buildType === 'door_shield') {
            room.shields.push({ x: tileX, y: tileY, active: false, used: false });
            room._hasShield = true;            // boolean flag for shield trigger compat
        } else if (buildType === 'ghost_net') room._hasGhostNet = true;
        else if (buildType === 'repair_tool') room._hasRepairTool = true;
        return { ok: true };
    }

    playerUpgrade(socketId, type, tileX, tileY) {
        const p = this.players[socketId];
        if (!p || p.state !== 'SLEEPING' || p.room === null) return { ok: false };
        const room = this.rooms[p.room];
        if (!room) return { ok: false };
        const BC = [10, 25, 60, 150, 300, 600, 1500, 3000, 6000, 12000, 25000, 50000];
        const DC = [20, 50, 120, 250, 500, 1000, 2500, 5000, 10000, 20000, 40000, 80000];
        const TC = [30, 80, 200, 450, 1000, 2500, 6000, 12000, 25000, 50000, 100000, 250000];
        const GC = [50, 120, 300, 700, 1500, 3000, 7000, 15000, 30000, 60000, 120000, 300000];
        const MC = { copper: [40, 100, 250, 600, 1200, 2500], silver: [120, 300, 750, 1800, 3500, 7000], gold: [300, 750, 1800, 4000, 8000, 16000] };
        let cost = 0, obj = null;
        if (type === 'bed') { obj = room.bed; cost = BC[obj.level]; }
        else if (type === 'door') { obj = room.door; cost = DC[obj.level]; }
        else if (type === 'turret') { obj = room.turrets.find(t => t.x === tileX && t.y === tileY); if (obj) cost = TC[obj.level]; }
        else if (type === 'generator') { obj = room.generators.find(t => t.x === tileX && t.y === tileY); if (obj) cost = GC[obj.level]; }
        else if (type === 'mine') { obj = room.mines.find(t => t.x === tileX && t.y === tileY); if (obj) cost = (MC[obj.type] || [])[obj.level] || 0; }
        // !cost catches both undefined (level is already at max, array OOB) and 0
        if (!obj || !cost || p.coins < cost) return { ok: false };
        p.coins -= cost; obj.level++;
        if (type === 'door') { obj.maxHp = DOOR_HPS[obj.level]; obj.hp = obj.maxHp; }
        return { ok: true, updatedObj: JSON.parse(JSON.stringify(obj)) };
    }

    playerRepair(socketId) {
        const p = this.players[socketId];
        if (!p || p.state !== 'SLEEPING' || p.room === null) return false;
        if (p.repairCooldown > 0 || p.repairActive) return false;
        p.repairActive = true; p.repairActiveTimer = 5; return true;
    }

    playerUseGrenade(socketId) {
        const p = this.players[socketId];
        if (!p || p.state !== 'SLEEPING' || p.room === null) return false;
        const room = this.rooms[p.room];
        if (!room.grenades.length || !this.ghost || this.ghost.state === 'DEAD') return false;
        room.grenades.pop();  // consume one grenade launcher tile
        room._hasGrenadeLauncher = room.grenades.length > 0;
        const dmg = Math.floor(this.ghost.maxHp * 0.4 + 400);
        this.ghost.hp -= dmg;
        if (this.ghost.hp <= 0) { this.ghost.hp = 0; this.ghost.state = 'DEAD'; this.gameOver = true; this.winner = 'survivors'; }
        return { ok: true, dmg };
    }

    playerUseGhostNet(socketId) {
        const p = this.players[socketId];
        if (!p || p.state !== 'SLEEPING' || p.room === null) return false;
        const room = this.rooms[p.room];
        if (!room._hasGhostNet || !this.ghost) return false;
        room._hasGhostNet = false; this.ghost.ghostStunTimer = 3; return true;
    }

    playerMove(socketId, x, y, vx, vy, facing) {
        const p = this.players[socketId];
        if (!p || p.isGhost || p.state !== 'ROAMING') return;
        const v = validateClientPos(this.map, this.rooms, p.x, p.y, x, y, ENTITY_RADIUS);
        p.x = v.x; p.y = v.y; p.vx = vx; p.vy = vy; p.facing = facing;
    }

    ghostMove(socketId, vx, vy, facing) {
        const p = this.players[socketId];
        if (!p || !p.isGhost || p.state === 'DEAD') return;
        if (this.ghostTimer > 0) return;
        this.ghostIsBot = false;
        const mag = Math.sqrt(vx * vx + vy * vy);
        if (mag > 1) { vx /= mag; vy /= mag; }
        p.vx = vx; p.vy = vy;
        if (vx !== 0 || vy !== 0) p.facing = facing;
    }

    ghostDisconnected() {
        this.ghostIsBot = true;
        if (this.ghost) this.ghost.ghostState = 'HUNTING';
    }

    getState() {
        return { players: this.players, rooms: this.rooms, map: null, ghostTimer: this.ghostTimer, gameOver: this.gameOver, winner: this.winner };
    }
    getInitialState() {
        return { players: this.players, rooms: this.rooms, map: this.map, ghostTimer: this.ghostTimer, healSpots: this.healSpots };
    }
    getDuration() { return Math.floor((Date.now() - this.startTime) / 1000); }
}

module.exports = { ServerGame };