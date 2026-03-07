# 👻 Ghost Killer — Multiplayer

A real-time multiplayer survival game built with Node.js, Socket.IO, Express, and MongoDB.

## Architecture

```
ghost-killer/
├── server/
│   ├── index.js        — Express + Socket.IO server
│   ├── gameState.js    — Authoritative game logic (tick-based)
│   ├── models.js       — Mongoose schemas (Room, Player)
│   ├── package.json
│   └── .env.example
└── client/
    └── public/
        └── index.html  — Full game client (served by Express)
```

## Setup

### 1. Install dependencies
```bash
cd server
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — set MONGODB_URI if using Atlas or custom host
```

### 3. Start MongoDB (local)
```bash
mongod --dbpath /data/db
# OR use MongoDB Atlas (set MONGODB_URI in .env)
```

### 4. Start the server
```bash
npm start
# dev mode with auto-reload:
npm run dev
```

### 5. Open the game
Visit **http://localhost:3001** in multiple browser tabs or devices on the same network.

---

## How to Play

1. **Enter your name** on the start screen
2. **Create a game** → share the 6-letter Room ID with friends
3. **Or join** an existing game using a Room ID
4. **Lobby**: Chat with players. Host starts when 3–7 players are in.
5. **Game starts**: One random player becomes the **👻 Ghost**, rest are **Survivors**
6. **Survivors**: Find a room, sleep in it, then build defenses from inside
7. **Ghost**: Break down doors and devour sleeping survivors

## Build Categories

| Category | Items |
|----------|-------|
| ⚙ Basic | Turret, Generator, Repair Boost |
| 💰 Money | Copper Mine, Silver Mine, Gold Mine |
| 🗡 Defence | Grenade (1×), Gate Shield (1×), Ghost Net (1×) |

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO 4
- **Database**: MongoDB + Mongoose
- **Game Loop**: Server-side 20 FPS authoritative tick
- **Client**: Vanilla JS Canvas (no framework)
- **Realtime**: Socket.IO rooms + events

## Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `create_room` | C→S | Create a new lobby |
| `join_room` | C→S | Join existing lobby |
| `start_game` | C→S | Host starts match |
| `game_start` | S→C | Initial game state (map, players) |
| `game_tick` | S→C | 20 FPS state broadcast |
| `player_move` | C→S | Movement update |
| `player_sleep` | C→S | Claim a room |
| `player_build` | C→S | Build on tile |
| `player_upgrade` | C→S | Upgrade tile object |
| `player_repair` | C→S | Activate gate repair |
| `player_use_grenade` | C→S | Use grenade (1×) |
| `player_use_net` | C→S | Use ghost net (1×) |
| `game_over` | S→C | Match result |
| `chat_message` | both | Lobby + in-game chat |

## REST API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Server health check |
| `GET /api/room/:id` | Room info (for join validation) |
| `GET /api/leaderboard` | Last 20 finished games |