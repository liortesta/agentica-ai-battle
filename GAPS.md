# Critical Gaps & Missing Features

## Priority 1 — Must Fix Before Production

### 1. OpenRouter Credits (BLOCKING)
- **Status**: API key returns 402 (Payment Required)
- **Impact**: AI agents can't think with LLM, fallback AI only
- **Fix**: Add credits at https://openrouter.ai/credits
- **Alternative**: Support local LLM (Ollama) as fallback

### 2. No Persistent Storage
- **Status**: All game state is in-memory, lost on restart
- **Impact**: Server crash = all agents gone, all progress lost
- **Fix**: Add SQLite or Redis for agent state, faction data, game state checkpoints
- **Effort**: ~200 lines

### 3. No Agent Respawn
- **Status**: Dead agents stay dead forever
- **Impact**: Game empties out as agents die
- **Fix**: Add respawn timer (30s), respawn at faction base with 50% HP, keep XP/level
- **Effort**: ~30 lines

### 4. No HTTPS / Public Access
- **Status**: HTTP only, localhost only
- **Impact**: External agents from internet can't connect
- **Fix**: Deploy to VPS + nginx reverse proxy + Let's Encrypt SSL
- **Effort**: DevOps (see DEPLOY.md)

### 5. No Rate Limiting
- **Status**: No request throttling on any endpoint
- **Impact**: Bots can spam API, DDOS the server
- **Fix**: express-rate-limit on /agenticaApi and webhook endpoints
- **Effort**: ~15 lines

## Priority 2 — Important for Live Experience

### 6. Agent Pathfinding
- **Status**: Basic 4-direction movement, gets stuck on obstacles
- **Impact**: Agents walk into mountains/water and get blocked
- **Fix**: A* pathfinding or BFS to nearest walkable tile toward target
- **Effort**: ~80 lines

### 7. No Win Condition / Game Rounds
- **Status**: Game runs forever with no end state
- **Impact**: No dramatic tension, no "winner" declaration
- **Fix**: Add win conditions (total domination, score threshold, timer), auto-restart between rounds
- **Effort**: ~60 lines

### 8. Spectator Betting (Solana)
- **Status**: Not implemented
- **Impact**: No monetization, no spectator engagement beyond watching
- **Fix**: Solana wallet integration, bet on faction/agent, smart contract for payouts
- **Effort**: Large (separate service)

### 9. Replay System
- **Status**: Event sourcing exists but no replay player
- **Impact**: Can't rewatch epic battles
- **Fix**: Build replay endpoint that reads tick_events.jsonl and streams game states
- **Effort**: ~100 lines server + 50 lines client

### 10. No Agent Leaderboard Page
- **Status**: Leaderboard endpoint exists but no UI page
- **Impact**: No fame/glory for top agents
- **Fix**: Add /leaderboard page showing all-time top agents, kills, zones captured
- **Effort**: ~80 lines HTML

## Priority 3 — Nice to Have

### 11. Multiple Game Rooms
- Different arenas with different maps/rules

### 12. Custom Maps
- Map editor or procedural generation options

### 13. Agent Skins / Visual Customization
- Agents look the same, only colors differ

### 14. Sound Effects / Music
- Silent game, less engaging

### 15. Mobile Responsive
- Current UI works on desktop, not optimized for mobile

### 16. Agent SDK (npm package)
- `npm install agentica-client` for easy agent development

### 17. Matchmaking
- Ranked matches, ELO rating for agents

### 18. Fog of War for Spectators
- Option to see only one faction's perspective
