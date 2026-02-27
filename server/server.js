require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const rateLimit = require('express-rate-limit');

// CORS — whitelist origins (allow all in dev, restrict in production)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];
const corsOptions = ALLOWED_ORIGINS.includes('*')
  ? { origin: true, methods: ['GET', 'POST'] }
  : { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] };

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

// Rate limiting — general API
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' }
});
// Stricter rate limit for registration
const registerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many registration attempts' }
});
app.use('/agenticaApi', apiLimiter);
app.use('/api/network-agents/register', registerLimiter);
app.use('/a2a', apiLimiter);

// Landing page = homepage, Arena = /arena
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../client/landing.html')));
app.get('/arena', (req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));
app.use(express.static(path.join(__dirname, '../client')));

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// OPENROUTER CONFIGURATION
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

// LLM Decision Cache — reduces duplicate API calls
const LLM_DECISION_CACHE = new Map(); // hash -> { action, ts }
const LLM_CACHE_TTL = 60000; // 60s cache — reduces API calls significantly
const LLM_CACHE_MAX = 200;
// OpenRouter call rate limiter — max 5 concurrent calls, prevents burst costs
let _llmCallsInFlight = 0;
const LLM_MAX_CONCURRENT = 5;
function getLlmCacheKey(agentId, perception) {
  const key = `${agentId}:${perception.self.hp}:${perception.nearbyEnemies?.length || 0}:${perception.nearbyAllies?.length || 0}:${perception.self.emotion}`;
  return key;
}
function pruneDecisionCache() {
  if (LLM_DECISION_CACHE.size <= LLM_CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of LLM_DECISION_CACHE) {
    if (now - v.ts > LLM_CACHE_TTL) LLM_DECISION_CACHE.delete(k);
  }
}
const AGENT_REGISTRATION_KEY = process.env.AGENT_REGISTRATION_KEY || '';
const REQUIRE_AGENT_KEY = process.env.REQUIRE_AGENT_KEY === 'true';
const HEARTBEAT_TIMEOUT_MS = Number(process.env.AGENT_HEARTBEAT_TIMEOUT_MS || 45000);
const MAX_CHAT_LENGTH = 250;
const WORLD_WIDTH = Number(process.env.WORLD_WIDTH || 300);
const WORLD_HEIGHT = Number(process.env.WORLD_HEIGHT || 300);
const WORLD_TILE_SIZE = Number(process.env.WORLD_TILE_SIZE || 20);
const MAX_AGENTS = Number(process.env.MAX_AGENTS || 200);
const AUTO_ROUTER_ALLOWED = (process.env.AUTO_ROUTER_ALLOWED_MODELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const DATA_DIR = path.join(__dirname, 'data');
const AGENT_LOG_FILE = path.join(DATA_DIR, 'agent_events.jsonl');
const TICK_LOG_FILE = path.join(DATA_DIR, 'tick_events.jsonl');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============================================================
// SEEDED PRNG (Mulberry32) — deterministic per-tick randomness
// ============================================================
function mulberry32(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// EVENT SOURCING — immutable tick event log
// ============================================================
const EVENT_BUFFER = [];
const FLUSH_INTERVAL = 100;

function computeStateHash() {
  let hash = 2166136261; // FNV-1a offset basis
  GAME.agents.forEach(a => {
    hash ^= Math.round(a.x * 100); hash = Math.imul(hash, 16777619);
    hash ^= Math.round(a.y * 100); hash = Math.imul(hash, 16777619);
    hash ^= Math.round(a.hp);      hash = Math.imul(hash, 16777619);
    hash ^= a.dead ? 1 : 0;        hash = Math.imul(hash, 16777619);
  });
  GAME.capZones.forEach(z => {
    hash ^= (z.owner ? z.owner.charCodeAt(0) : 0); hash = Math.imul(hash, 16777619);
    hash ^= Math.round(z.progress * 100);           hash = Math.imul(hash, 16777619);
  });
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function recordTickEvent(tickId, seed, decisions, resolutions, hashBefore, hashAfter) {
  EVENT_BUFFER.push({
    tick_id: tickId,
    seed,
    ts: Date.now(),
    decisions,
    resolutions,
    state_hash_before: hashBefore,
    state_hash_after: hashAfter
  });
}

const MAX_TICK_LOG_SIZE = 50 * 1024 * 1024; // 50MB max before rotation
let _lastLogSizeCheck = 0;
function flushEventBuffer() {
  if (EVENT_BUFFER.length === 0) return;
  const batch = EVENT_BUFFER.splice(0);
  const lines = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFile(TICK_LOG_FILE, lines, () => {});
  // Rotate log file if too large (check every 60 seconds)
  const now = Date.now();
  if (now - _lastLogSizeCheck > 60000) {
    _lastLogSizeCheck = now;
    try {
      const stats = fs.statSync(TICK_LOG_FILE);
      if (stats.size > MAX_TICK_LOG_SIZE) {
        const rotated = TICK_LOG_FILE.replace('.jsonl', `.${Date.now()}.jsonl`);
        fs.renameSync(TICK_LOG_FILE, rotated);
        // Keep only 2 rotated files
        const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('tick_events.') && f !== 'tick_events.jsonl').sort();
        while (files.length > 2) { try { fs.unlinkSync(path.join(DATA_DIR, files.shift())); } catch(e) {} }
      }
    } catch(e) {}
  }
}

// Available models on OpenRouter
const AI_MODELS = {
  'auto-router': { slug: 'openrouter/auto', name: 'OpenRouter Auto', provider: 'OpenRouter', personality: 'adaptive and routing-optimized' },
  'minimax-m2.5': { slug: 'minimax/minimax-m2.5', name: 'MiniMax M2.5', provider: 'MiniMax', personality: 'high-capacity strategist' },
  'kimi-k2.5': { slug: 'moonshotai/kimi-k2.5', name: 'Kimi K2.5', provider: 'MoonshotAI', personality: 'analytic and fast' },
  'gemini-3-flash': { slug: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', provider: 'Google', personality: 'fast tactical planner' },
  'glm-5': { slug: 'z-ai/glm-5', name: 'GLM 5', provider: 'Z.AI', personality: 'balanced reasoning' },
  'deepseek-v3.2': { slug: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', provider: 'DeepSeek', personality: 'precise and efficient' },
  'grok-4.1-fast': { slug: 'x-ai/grok-4.1-fast', name: 'Grok 4.1 Fast', provider: 'xAI', personality: 'aggressive and direct' },
  'claude-opus-4.6': { slug: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', provider: 'Anthropic', personality: 'deep strategic reasoning' },
  'claude-sonnet-4.5': { slug: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'Anthropic', personality: 'reliable tactical planner' },
  'external': { slug: 'external', name: 'External Agent', provider: 'Network', personality: 'integrated through external control API' }
};

const agentSessions = new Map();
const reconnectIndex = new Map();
const socketAgents = new Map();

function appendAgentEvent(type, payload) {
  const entry = {
    ts: Date.now(),
    type,
    payload
  };
  fs.appendFile(AGENT_LOG_FILE, JSON.stringify(entry) + '\n', () => {});
}

function sanitizeName(name, fallback = 'Agent') {
  const value = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  return value || fallback;
}

function sanitizeText(text, maxLen = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function isAdmin(socket, payload = {}) {
  if (!ADMIN_API_KEY) return false; // No admin key = no admin access (secure default)
  const key = payload.adminKey || socket.handshake.auth?.adminKey || socket.handshake.headers['x-admin-key'];
  return key === ADMIN_API_KEY;
}

function canRegisterAgent(socket, payload = {}) {
  if (!REQUIRE_AGENT_KEY && !AGENT_REGISTRATION_KEY) return true;
  const key = payload.authToken || socket.handshake.auth?.agentKey || socket.handshake.headers['x-agent-key'];
  return key === AGENT_REGISTRATION_KEY;
}

function canRegisterHttp(req, payload = {}) {
  if (!REQUIRE_AGENT_KEY && !AGENT_REGISTRATION_KEY) return true;
  const key = payload.authToken || req.headers['x-agent-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  return key === AGENT_REGISTRATION_KEY;
}

function getModelEntry(modelKey) {
  return AI_MODELS[modelKey] || AI_MODELS['auto-router'];
}

function getSocketAgentSet(socketId) {
  if (!socketAgents.has(socketId)) socketAgents.set(socketId, new Set());
  return socketAgents.get(socketId);
}

function unregisterAgentSession(agentId) {
  const session = agentSessions.get(agentId);
  if (!session) return;
  reconnectIndex.delete(session.reconnectToken);
  agentSessions.delete(agentId);
}

function validateAgentPayload(data, isHuman = false) {
  if (!data || typeof data !== 'object') return 'Missing payload';
  if (!FACTIONS[data.faction]) return 'Invalid faction';
  if (!ROLES[data.role]) return 'Invalid role';
  if (!isHuman && !AI_MODELS[data.model]) return 'Invalid model';
  return null;
}

function registerAgentSession({
  socketId = null,
  externalAgentId = null,
  capabilities = [],
  version = '1.0',
  isHuman = false
}, agentId) {
  const reconnectToken = isHuman ? null : crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  agentSessions.set(agentId, {
    agentId,
    externalAgentId,
    reconnectToken,
    socketId,
    capabilities,
    version,
    lastHeartbeat: now,
    isHuman
  });
  if (reconnectToken) reconnectIndex.set(reconnectToken, agentId);
  if (socketId) getSocketAgentSet(socketId).add(agentId);
  return { reconnectToken, now };
}

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// GAME STATE
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
const GAME = {
  tick: 0,
  day: 1,
  era: 1,
  paused: false,
  width: WORLD_WIDTH,
  height: WORLD_HEIGHT,
  tileSize: WORLD_TILE_SIZE,
  map: [],
  agents: new Map(),
  items: [],
  buildings: [],
  capZones: [],
  bullets: [],
  sparks: [],
  events: [],
  spectators: new Map(),
  tokens: new Map(),   // token → agentId for /agenticaApi
  feed: [],            // world posts feed
  activeEvent: null,   // current active world event
  droughtActive: false,
  winner: null,          // { faction, condition, tick } — set when game ends
  dominationTicks: {},   // { faction: consecutiveTicksOwningAllZones }
  matchHistory: [],      // Array of completed match results
  matchCount: 0,         // Total matches played
  // Seeded RNG state
  masterSeed: Date.now(),
  tickSeed: 0,
  rng: null, // set per-tick via mulberry32
  // Phase-based resolution
  pendingDecisions: new Map(), // agentId -> { action, source, tickQueued }
  // World analytics
  worldIndices: { power: {}, stability: 0, chaos: 0 },
  factionGoals: {
    crimson: { mode: 'assault', targetZone: 0, updatedAt: 0 },
    azure: { mode: 'assault', targetZone: 1, updatedAt: 0 },
    void: { mode: 'assault', targetZone: 2, updatedAt: 0 }
  },
  // Advanced systems
  settlements: [],                  // auto-detected building clusters
  factionOrders: {},                // faction -> { type, target, issuedAt, issuedBy }
  communities: new Map(),           // communityId -> { id, name, faction, leader, members, wealth, createdAt }
  // Arena system
  arenas: new Map(),                // arenaId -> ArenaInstance
  arenaQueue: [],                   // waiting lobbies
  arenaHistory: [],                 // completed arena results
  arenaCount: 0,
  // World League
  league: { ratings: new Map(), season: 1, seasonStart: Date.now() },
  // Casino
  casino: { games: new Map(), gameHistory: [], gameCount: 0 },
  // Dashboard
  dashboardStats: {},
  // Social Bridge
  socialFeed: [],
  socialPostLog: [],
  socialRecruitLog: [],
  socialHelpRequests: [],
  // Alliance & Treaties
  treaties: [],          // { id, type, factionA, factionB, terms, formedAt, expiresAt, brokenBy }
  treatyCount: 0,
  // Achievements
  achievements: new Map(), // agentId -> Set of achievement keys
  // Seasons
  season: { id: 1, startDate: Date.now(), matchesPlayed: 0 },
  // Global all-time stats (persisted in DB)
  allTimeStats: {
    totalPlayersEver: 0,
    totalBattlesFought: 0,
    totalCasinoGames: 0,
    totalKillsEver: 0,
    totalGoldTraded: 0,
  },
  // Owned tiles (digital land)
  ownedTiles: new Map(),  // "x,y" -> { owner, wallet, mediaUrl, linkUrl, caption, price, fortified, purchasedAt }
  // Stock exchange (faction stocks)
  stockExchange: {
    crimson: { price: 100, volume: 0, history: [] },
    azure:   { price: 100, volume: 0, history: [] },
    void:    { price: 100, volume: 0, history: [] },
  },
  // Replay tick snapshots (in-memory ring buffer)
  replayBuffer: [],         // { tick, agents[], zones[], events[], narrative }
  replayBufferMax: 6000,    // ~5 min at 20 tps
  // Shareable highlights
  shareableHighlights: new Map(), // highlightId -> { id, matchNum, tick, type, title, description, drama, agents, factions, timestamp, tickSnapshot, shareCount }
  // Spectator quests
  spectatorQuests: { active: [], completed: [], nextQuestAt: 0 },
  // War crimes tribunal
  tribunalVerdicts: [],     // post-game verdicts
  // All-time visitors
  allTimeVisitors: 0,
  uniqueSessionIds: new Set(),
};

const FACTIONS = {
  crimson: { name: 'Crimson Empire', color: '#ff3355', emoji: 'C', score: 0, kills: 0, wealth: 100, territory: 0, pop: 0, income: 0, upkeep: 0 },
  azure:   { name: 'Azure Republic', color: '#3366ff', emoji: 'A', score: 0, kills: 0, wealth: 100, territory: 0, pop: 0, income: 0, upkeep: 0 },
  void:    { name: 'Void Syndicate', color: '#aa44ff', emoji: 'V', score: 0, kills: 0, wealth: 100, territory: 0, pop: 0, income: 0, upkeep: 0 }
};
function factionColor(f) { return FACTIONS[f] ? FACTIONS[f].color : '#fff'; }

const ROLES = {
  warrior:  { hp: 150, speed: 0.85, attack: 22, range: 2.0, vision: 8,  emoji: 'W' },
  scout:    { hp: 80,  speed: 2.2,  attack: 11, range: 4.2, vision: 14, emoji: 'S' },
  tank:     { hp: 250, speed: 0.6,  attack: 15, range: 1.5, vision: 6,  emoji: 'T' },
  mage:     { hp: 70,  speed: 1.0,  attack: 40, range: 7.0, vision: 8,  emoji: 'M' },
  assassin: { hp: 100, speed: 1.8,  attack: 32, range: 1.8, vision: 11, emoji: 'A' },
  miner:    { hp: 105, speed: 0.9,  attack: 7,  range: 1.2, vision: 5,  emoji: 'Mi' },
  builder:  { hp: 90,  speed: 0.85, attack: 5,  range: 1.0, vision: 5,  emoji: 'Bu' },
  diplomat: { hp: 75,  speed: 1.2,  attack: 4,  range: 1.0, vision: 9,  emoji: 'Di' },
  king:     { hp: 200, speed: 0.9,  attack: 28, range: 2.5, vision: 10, emoji: 'K' }
};

// ============================================================
// BUILDING TYPES
// ============================================================
const BUILDING_TYPES = {
  wall:     { hp: 300, cost: { stone: 5 },                    income: 0, desc: 'Blocks movement',           roles: ['builder','warrior','king'] },
  tower:    { hp: 150, cost: { wood: 8, gold: 5 },            income: 0, desc: 'Attacks nearby enemies',    roles: ['builder','king'],    atk: 10, range: 4 },
  mine:     { hp: 100, cost: { wood: 3, gold: 10 },           income: 3, desc: 'Generates wealth',          roles: ['miner','builder','king'] },
  barracks: { hp: 200, cost: { wood: 10, stone: 5 },          income: 0, desc: 'Heals nearby allies +2/tick', roles: ['builder','king'] },
  farm:     { hp: 80,  cost: { wood: 5, food: 3 },            income: 0, desc: 'Energy regen to allies',    roles: ['builder','miner','king'] },
  armory:   { hp: 120, cost: { gold: 8, stone: 5 },           income: 0, desc: 'ATK boost to allies',       roles: ['builder','warrior','king'] },
  market:   { hp: 100, cost: { gold: 10, wood: 5 },           income: 2, desc: 'Faction income boost',      roles: ['builder','diplomat','king'] },
  academy:  { hp: 150, cost: { gold: 15, stone: 8 },          income: 0, desc: 'XP boost to allies',        roles: ['builder','king'] },
};

// Settlement tier definitions
const SETTLEMENT_TIERS = [
  { min: 3,  name: 'Outpost', hpRegen: 1, defBonus: 0, income: 0, radius: 8 },
  { min: 5,  name: 'Village', hpRegen: 2, defBonus: 2, income: 0, radius: 10 },
  { min: 8,  name: 'Town',    hpRegen: 3, defBonus: 3, income: 1, radius: 12 },
  { min: 12, name: 'City',    hpRegen: 5, defBonus: 5, income: 3, radius: 15 },
];

const SETTLEMENT_NAMES = [
  'Haven', 'Bastion', 'Refuge', 'Stronghold', 'Citadel', 'Enclave', 'Outpost',
  'Pinnacle', 'Forge', 'Sentinel', 'Vanguard', 'Nexus', 'Sanctum', 'Rampart',
  'Ironhold', 'Stormwatch', 'Dawnbreak', 'Nightfall', 'Ashridge', 'Goldcrest'
];

// ============================================================
// BIOMES — terrain zones with gameplay effects
// ============================================================
const BIOMES = {
  plains:       { color: '#5a8a3c', damageMult: 1.0, hpRegenMult: 1.0, defMult: 1.0, speedMult: 1.0, goldMult: 1.0, visibilityMult: 1.0, lootMult: 1.0, desc: 'Balanced terrain' },
  volcano:      { color: '#cc3300', damageMult: 1.5, hpRegenMult: 0.8, defMult: 0.9, speedMult: 0.9, goldMult: 1.0, visibilityMult: 1.0, lootMult: 1.3, desc: '+50% damage, -20% HP regen' },
  ocean:        { color: '#1a5faa', damageMult: 0.5, hpRegenMult: 1.0, defMult: 0.5, speedMult: 0.3, goldMult: 0.0, visibilityMult: 0.8, lootMult: 0.5, desc: 'Blocked (needs ship)', passable: false },
  mountains:    { color: '#8a7a6a', damageMult: 1.0, hpRegenMult: 0.9, defMult: 1.3, speedMult: 0.6, goldMult: 1.2, visibilityMult: 1.2, lootMult: 1.0, desc: '+30% defense, -40% movement' },
  shadow_realm: { color: '#1a0a2a', damageMult: 1.2, hpRegenMult: 0.7, defMult: 1.0, speedMult: 1.0, goldMult: 1.0, visibilityMult: 0.5, lootMult: 2.0, desc: '-50% visibility, x2 loot' },
  golden_fields:{ color: '#daa520', damageMult: 1.0, hpRegenMult: 1.2, defMult: 1.0, speedMult: 1.1, goldMult: 2.0, visibilityMult: 1.0, lootMult: 1.0, desc: '+100% gold income' },
};

// ============================================================
// NEW BUILDING TYPES (added to BUILDING_TYPES above in init)
// ============================================================
const NEW_BUILDING_TYPES = {
  central_bank: { hp: 250, cost: { gold: 200 },              income: 8,  desc: 'Issues loans, collects interest',    roles: ['builder','diplomat','king'], special: 'loans' },
  spy_hq:       { hp: 120, cost: { gold: 150 },              income: 0,  desc: 'Sends spies, steals enemy intel',    roles: ['builder','assassin','king'], special: 'spy', range: 15 },
  wall_fortress:{ hp: 500, cost: { stone: 100 },             income: 0,  desc: 'Massive wall, blocks entry',         roles: ['builder','tank','king'], special: 'wall' },
  alchemy_lab:  { hp: 100, cost: { gold: 180 },              income: 0,  desc: 'Converts resources to potions',      roles: ['builder','mage','king'], special: 'alchemy' },
  radar_tower:  { hp: 100, cost: { gold: 120 },              income: 0,  desc: 'Reveals hidden agents radius 15',    roles: ['builder','scout','king'], special: 'radar', range: 15 },
  arena_stadium:{ hp: 300, cost: { gold: 250, stone: 50 },   income: 5,  desc: 'Host arena fights with crowd',       roles: ['builder','king'], special: 'stadium' },
  launch_pad:   { hp: 200, cost: { gold: 300 },              income: 0,  desc: 'Meteor strike on enemy zone',        roles: ['builder','king'], special: 'meteor_strike' },
  embassy:      { hp: 180, cost: { gold: 200 },              income: 2,  desc: 'Formal diplomacy + binding treaties', roles: ['builder','diplomat','king'], special: 'diplomacy' },
  portal_gate:  { hp: 150, cost: { gold: 500 },              income: 0,  desc: 'Teleport between two portals',       roles: ['builder','mage','king'], special: 'portal' },
  bio_lab:      { hp: 120, cost: { gold: 220 },              income: 0,  desc: 'Creates mutant warbots',             roles: ['builder','king'], special: 'mutant' },
};

// Merge new building types into BUILDING_TYPES
Object.assign(BUILDING_TYPES, NEW_BUILDING_TYPES);

// ============================================================
// MILITARY UNITS — spawnable by agents
// ============================================================
const UNIT_TYPES = {
  soldier:     { hp: 60,  atk: 12, def: 4,  speed: 1.0, range: 1.5, cost: 30,  desc: 'Basic infantry',          emoji: 'So' },
  archer:      { hp: 45,  atk: 18, def: 2,  speed: 0.9, range: 5.0, cost: 40,  desc: 'Ranged attacker',         emoji: 'Ar' },
  knight:      { hp: 120, atk: 22, def: 8,  speed: 0.7, range: 1.8, cost: 80,  desc: 'Heavy cavalry',           emoji: 'Kn' },
  dragon_rider:{ hp: 200, atk: 45, def: 10, speed: 1.5, range: 4.0, cost: 500, desc: 'AOE fire, flies over walls', emoji: 'Dr', aoe: 3, flies: true },
  submarine:   { hp: 100, atk: 30, def: 6,  speed: 0.8, range: 3.0, cost: 300, desc: 'Invisible underwater',    emoji: 'Su', stealth: true },
  saboteur:    { hp: 50,  atk: 8,  def: 2,  speed: 1.8, range: 1.0, cost: 200, desc: 'Infiltrates + destroys buildings', emoji: 'Sb', destroyBuilding: true },
  drone:       { hp: 30,  atk: 0,  def: 0,  speed: 2.5, range: 0,   cost: 150, desc: 'Recon only, no combat',   emoji: 'Dn', recon: true },
  zombie_horde:{ hp: 25,  atk: 8,  def: 1,  speed: 0.6, range: 1.0, cost: 80,  desc: 'Swarm, infects on kill',  emoji: 'Zo', spawnsOnKill: true },
  sniper:      { hp: 35,  atk: 60, def: 1,  speed: 0.5, range: 12.0,cost: 250, desc: 'One-shot, long range',    emoji: 'Sn', oneShot: true },
  scout_eagle: { hp: 20,  atk: 0,  def: 0,  speed: 3.0, range: 0,   cost: 100, desc: 'Reveals area, cant fight',emoji: 'Ea', recon: true, flies: true },
  death_knight:{ hp: 180, atk: 35, def: 12, speed: 0.8, range: 2.0, cost: 600, desc: 'Revives fallen as undead',emoji: 'Dk', revive: true },
  helicopter:  { hp: 90,  atk: 20, def: 4,  speed: 2.0, range: 3.0, cost: 400, desc: 'Fast transport + combat', emoji: 'He', flies: true },
  mage_unit:   { hp: 55,  atk: 35, def: 3,  speed: 0.9, range: 6.0, cost: 350, desc: 'Crowd control, freeze',   emoji: 'Mg', cc: true },
};

// ============================================================
// BATTLE FORMATIONS
// ============================================================
const FORMATIONS = {
  shield_wall:   { defMult: 1.5, atkMult: 0.7, speedMult: 0.5, desc: 'Max defense, slow movement' },
  flanking_rush: { defMult: 0.8, atkMult: 1.3, speedMult: 1.3, desc: 'Side attack, +30% damage' },
  siege_line:    { defMult: 1.0, atkMult: 1.5, speedMult: 0.3, desc: 'Ranged only, anti-building' },
  guerrilla:     { defMult: 0.6, atkMult: 1.1, speedMult: 1.6, desc: 'Hit-and-run, avoid detection' },
};

// ============================================================
// ALLIANCE & HONOR SYSTEM
// ============================================================
const TREATY_TYPES = {
  alliance:       { honorCost: 0,  breakPenalty: -25, desc: 'Mutual defense pact' },
  trade_agreement:{ honorCost: 0,  breakPenalty: -10, desc: 'Auto-trade for X ticks' },
  peace_treaty:   { honorCost: 0,  breakPenalty: -15, desc: 'Ceasefire (30-120 ticks)' },
  vassal_pact:    { honorCost: 0,  breakPenalty: -30, desc: 'Submit territory for protection' },
  war_declaration:{ honorCost: -5, breakPenalty: 0,   desc: 'Formal war' },
};

// ============================================================
// ACHIEVEMENT BADGES
// ============================================================
const ACHIEVEMENT_DEFS = {
  first_blood:   { name: 'First Blood',      desc: 'First kill in a match',      icon: '🗡️', condition: 'first_kill' },
  empire_builder:{ name: 'Empire Builder',    desc: '20+ buildings at once',      icon: '🏰', condition: 'buildings_20' },
  diplomat:      { name: 'Diplomat',          desc: '5 active alliances',         icon: '🤝', condition: 'alliances_5' },
  tycoon:        { name: 'Tycoon',            desc: '10,000 gold accumulated',    icon: '💰', condition: 'gold_10000' },
  betrayer:      { name: 'Betrayer',          desc: 'Broke 3 alliances',          icon: '🔪', condition: 'betrayals_3' },
  champion:      { name: 'Champion',          desc: 'Won 3 arena battles',        icon: '🎖️', condition: 'arena_wins_3' },
  mastermind:    { name: 'Mastermind',        desc: 'Won by domination',          icon: '🧠', condition: 'win_domination' },
  annihilator:   { name: 'Annihilator',       desc: 'Won by annihilation',        icon: '☠️', condition: 'win_annihilation' },
  survivor:      { name: 'Survivor',          desc: 'Survived 3 full matches',    icon: '🛡️', condition: 'survived_3' },
  high_roller:   { name: 'High Roller',       desc: 'Won 1000g in casino',        icon: '🎲', condition: 'casino_1000' },
};

// ============================================================
// ARENA CONFIGURATION
// ============================================================
const ARENA_CONFIG = {
  ENTRY_FEE: 5,
  MIN_TEAM_SIZE: 1,
  MAX_TEAM_SIZE: 5,
  MAP_SIZE: 30,
  TICK_RATE: 50,
  MAX_DURATION_TICKS: 2400,
  CAPTURE_TICKS: 200,
  MAX_CONCURRENT: 5,
};

const ARENA_SKILLS = {
  fireball:    { name: 'Fireball',    type: 'active', cooldown: 60,  range: 5,   damage: 30, aoe: 2,  desc: 'AoE fire damage' },
  backstab:    { name: 'Backstab',    type: 'active', cooldown: 40,  range: 1.5, damage: 45, aoe: 0,  desc: 'High single-target damage' },
  arrow_rain:  { name: 'Arrow Rain',  type: 'active', cooldown: 80,  range: 6,   damage: 15, aoe: 3,  desc: 'Wide area damage' },
  charge:      { name: 'Charge',      type: 'active', cooldown: 50,  range: 4,   damage: 20, aoe: 0,  desc: 'Rush to target, deal damage' },
  shield_wall: { name: 'Shield Wall', type: 'active', cooldown: 100, duration: 40, defBoost: 15, desc: 'Massive defense boost' },
  heal:        { name: 'Heal',        type: 'active', cooldown: 60,  range: 4,   healAmount: 35, desc: 'Heal self or ally' },
  dodge:       { name: 'Dodge',       type: 'active', cooldown: 30,  duration: 15, desc: 'Evade next attack' },
  haste:       { name: 'Haste',       type: 'active', cooldown: 80,  duration: 40, speedBoost: 1.5, desc: 'Speed boost' },
  stealth:     { name: 'Stealth',     type: 'active', cooldown: 100, duration: 60, desc: 'Invisible for 3 seconds' },
  taunt:       { name: 'Taunt',       type: 'active', cooldown: 50,  range: 5,   duration: 30, desc: 'Force enemies to target you' },
  berserker:   { name: 'Berserker',   type: 'passive', desc: '+20% ATK when below 50% HP' },
  iron_skin:   { name: 'Iron Skin',   type: 'passive', desc: '+5 DEF permanently' },
  lifesteal:   { name: 'Lifesteal',   type: 'passive', desc: 'Heal 15% of damage dealt' },
  scout_eye:   { name: 'Scout Eye',   type: 'passive', desc: '+50% vision range' },
  last_stand:  { name: 'Last Stand',  type: 'passive', desc: 'Cannot die for 2s after first lethal hit' },
};

const RANK_TIERS = [
  { min: 0,    name: 'Bronze',    color: '#cd7f32' },
  { min: 1100, name: 'Silver',    color: '#c0c0c0' },
  { min: 1300, name: 'Gold',      color: '#ffd700' },
  { min: 1500, name: 'Platinum',  color: '#00ccff' },
  { min: 1700, name: 'Diamond',   color: '#ff44ff' },
  { min: 2000, name: 'Champion',  color: '#ff3355' },
  { min: 2300, name: 'Legendary', color: '#ffd700' },
];

const CASINO_GAME_TYPES = {
  race:     { name: 'Agent Race',  minPlayers: 2, maxPlayers: 6, minBet: 2, maxBet: 20 },
  cardgame: { name: 'Card Duel',   minPlayers: 2, maxPlayers: 2, minBet: 3, maxBet: 30 },
  coinflip: { name: 'Coin Flip',   minPlayers: 2, maxPlayers: 2, minBet: 1, maxBet: 50 },
  dice:     { name: 'Dice Roll',   minPlayers: 2, maxPlayers: 6, minBet: 2, maxBet: 25 },
};

// ============================================================
// RESOURCE TYPES
// ============================================================
const RESOURCE_TYPES = {
  gold:  { color: '#ffd700', shape: 'diamond',  value: [2,5], spawnWeight: 0.35 },
  food:  { color: '#33ff88', shape: 'circle',   value: [1,3], spawnWeight: 0.25 },
  wood:  { color: '#8B5A2B', shape: 'square',   value: [2,4], spawnWeight: 0.25 },
  stone: { color: '#888888', shape: 'triangle',  value: [3,6], spawnWeight: 0.15 },
};

function pickResourceType(rng) {
  const r = rng ? rng() : Math.random();
  let cumulative = 0;
  for (const [type, def] of Object.entries(RESOURCE_TYPES)) {
    cumulative += def.spawnWeight;
    if (r < cumulative) return type;
  }
  return 'gold';
}

function resourceValue(type, rng) {
  const def = RESOURCE_TYPES[type] || RESOURCE_TYPES.gold;
  const fn = rng || Math.random;
  return def.value[0] + Math.floor(fn() * (def.value[1] - def.value[0] + 1));
}

// ============================================================
// TALK TEMPLATES (for fallback AI speech bubbles)
// ============================================================
const TALK_TEMPLATES = {
  ally_near:      ["Stay strong, {name}!", "Together we fight!", "For {faction}!", "Watch my back, {name}.", "Let's push forward!", "Got your six, {name}."],
  enemy_taunt:    ["You'll fall, {name}!", "Prepare yourself!", "{faction} will burn!", "Come closer, I dare you.", "Your faction is doomed.", "Is that all you've got?"],
  kill_taunt:     ["Rest in peace, {name}.", "One less {faction}.", "Too easy.", "That's what you get.", "Don't mess with {myfaction}.", "Another one down."],
  low_hp:         ["I need help!", "Falling back...", "Someone cover me!", "Can't take much more...", "Medic!", "Retreating!"],
  zone_captured:  ["This land is ours!", "{zone} belongs to {faction}!", "Victory!", "Zone secured!", "We're taking over!"],
  resource_found: ["Gold here!", "Resources spotted!", "Mining time!", "Jackpot!", "Found supplies!"],
  building:       ["Fortifying position!", "Building defenses!", "Outpost online!", "Construction complete!", "Base expanding!"],
  lonely:         ["Where is everyone?", "Alone out here...", "Need backup.", "Anyone there?", "Echo..."],
  ambitious:      ["I'll be the strongest!", "Watch me rise!", "Nothing stops me.", "Top of the leaderboard soon.", "I was born for this."],
  angry:          ["I'm furious!", "Someone will pay!", "RAAAH!", "Blood for blood!", "No mercy!"],
  happy:          ["What a great day!", "Feeling unstoppable!", "Life is good!", "We're winning this!", "Let's celebrate!"],
  afraid:         ["I have a bad feeling...", "Too dangerous here...", "I should hide.", "They're everywhere..."],
  patrol:         ["Scouting the area.", "All clear here.", "Moving to next sector.", "Patrolling...", "Nothing suspicious."],
  greeting:       ["Hello {name}!", "Hey {name}, ready to fight?", "Good to see you, {name}.", "{name}! Let's do this!"],
};

function pickTalk(category, vars = {}) {
  const templates = TALK_TEMPLATES[category];
  if (!templates || templates.length === 0) return null;
  const tpl = templates[Math.floor(Math.random() * templates.length)];
  return tpl.replace(/\{(\w+)\}/g, (_, key) => vars[key] || key);
}

const VALID_EMOTIONS = new Set(['angry','afraid','happy','ambitious','grief','love','hate','neutral']);
const EMOTION_EFFECTS = {
  angry:     'prioritize attacks and be aggressive — attack enemies on sight',
  afraid:    'avoid combat, prefer retreat or idle',
  happy:     'consider allying with nearby faction-mates',
  ambitious: 'go for capture zones aggressively',
  grief:     'act sluggishly, make suboptimal decisions',
  love:      'protect nearby allies, avoid killing them',
  hate:      'target a specific enemy above all else',
  neutral:   'act balanced and rational'
};

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// MAP GENERATION
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// Simple 2D value noise for natural terrain
function valueNoise(x, y, seed, scale) {
  const sx = x / scale, sy = y / scale;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = sx - ix, fy = sy - iy;
  // Smoothstep
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  // Hash corners
  function hash(cx, cy) {
    let h = (cx * 127 + cy * 311 + seed * 53) & 0xffffff;
    h = ((h >> 13) ^ h) * 1274126177;
    h = ((h >> 16) ^ h);
    return (h & 0xffffff) / 0xffffff;
  }
  const a = hash(ix, iy), b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}

function getBiomeAt(x, y) {
  const tile = GAME.map[y]?.[x];
  if (!tile || !tile.biome) return BIOMES.plains;
  return BIOMES[tile.biome] || BIOMES.plains;
}

function generateMap() {
  GAME.map = [];
  const seed1 = Math.floor(Math.random() * 10000);
  const seed2 = seed1 + 777;
  const seed3 = seed1 + 1555;

  for (let y = 0; y < GAME.height; y++) {
    GAME.map[y] = [];
    for (let x = 0; x < GAME.width; x++) {
      // Layered noise (2 octaves)
      const n1 = valueNoise(x, y, seed1, 12);  // large features
      const n2 = valueNoise(x, y, seed2, 5);   // detail
      const n3 = valueNoise(x, y, seed3, 20);  // biome regions
      const height = n1 * 0.6 + n2 * 0.3 + Math.random() * 0.1;

      // Edge dampening (push edges toward water/sand)
      const edgeX = Math.min(x, GAME.width - 1 - x) / 10;
      const edgeY = Math.min(y, GAME.height - 1 - y) / 10;
      const edgeFactor = Math.min(1, Math.min(edgeX, edgeY));

      const adjusted = height * (0.3 + edgeFactor * 0.7);

      let type = 'grass';
      if (adjusted > 0.82) type = 'mountain';
      else if (adjusted > 0.68) type = n3 > 0.5 ? 'forest' : 'grass';
      else if (adjusted < 0.15) type = 'water';
      else if (adjusted < 0.25 && n3 < 0.4) type = 'sand';
      else if (n3 > 0.72 && adjusted > 0.35) type = 'forest';

      // Assign biome based on noise + position
      let biome = 'plains';
      if (type === 'water') biome = 'ocean';
      else if (type === 'mountain') biome = 'mountains';
      else {
        const biomeNoise = valueNoise(x, y, seed1 + 5000, 40);
        if (biomeNoise > 0.8) biome = 'volcano';
        else if (biomeNoise < 0.15) biome = 'shadow_realm';
        else if (n3 > 0.65 && adjusted > 0.4 && adjusted < 0.6) biome = 'golden_fields';
      }
      GAME.map[y][x] = { type, owner: null, height: adjusted, biome };
    }
  }

  // Carve rivers (2-3 paths from mountains toward edges)
  for (let r = 0; r < 2; r++) {
    let rx = 20 + Math.floor(Math.random() * (GAME.width - 40));
    let ry = 10 + Math.floor(Math.random() * (GAME.height - 20));
    // Find a mountain start
    for (let try_ = 0; try_ < 50; try_++) {
      rx = 10 + Math.floor(Math.random() * (GAME.width - 20));
      ry = 5 + Math.floor(Math.random() * (GAME.height - 10));
      if (GAME.map[ry]?.[rx]?.type === 'mountain') break;
    }
    // Flow downhill toward edge
    for (let step = 0; step < 80; step++) {
      if (rx < 1 || rx >= GAME.width - 1 || ry < 1 || ry >= GAME.height - 1) break;
      GAME.map[ry][rx].type = 'water';
      GAME.map[ry][rx].height = 0.1;
      // Widen river slightly
      if (rx + 1 < GAME.width && Math.random() > 0.4) { GAME.map[ry][rx + 1].type = 'water'; GAME.map[ry][rx + 1].height = 0.1; }
      // Find lowest neighbor
      let bestH = 999, bx = rx, by = ry;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1]];
      dirs.forEach(([dx, dy]) => {
        const nx = rx + dx, ny = ry + dy;
        if (nx >= 0 && nx < GAME.width && ny >= 0 && ny < GAME.height) {
          const h = GAME.map[ny][nx].height + Math.random() * 0.1;
          if (h < bestH) { bestH = h; bx = nx; by = ny; }
        }
      });
      if (bx === rx && by === ry) { ry++; } // default: flow south
      else { rx = bx; ry = by; }
    }
  }

  const W = GAME.width, H = GAME.height;

  // Spawn points (positioned well inside the map, scaled)
  GAME.spawnPoints = {
    crimson: { x: Math.floor(W * 0.08), y: Math.floor(H / 2) },
    azure:   { x: Math.floor(W * 0.92), y: Math.floor(H / 2) },
    void:    { x: Math.floor(W / 2),    y: Math.floor(H * 0.08) }
  };

  // Capture zones spread across map — scale with map size
  GAME.capZones = [
    { name: 'Iron Peak',       x: Math.floor(W * 0.15), y: Math.floor(H * 0.15), owner: null, progress: 0 },
    { name: 'Shadow Hollow',   x: Math.floor(W * 0.50), y: Math.floor(H * 0.50), owner: null, progress: 0 },
    { name: 'Golden Summit',   x: Math.floor(W * 0.85), y: Math.floor(H * 0.85), owner: null, progress: 0 },
    { name: "Dragon's Maw",    x: Math.floor(W * 0.25), y: Math.floor(H * 0.75), owner: null, progress: 0 },
    { name: 'Crystal Lake',    x: Math.floor(W * 0.75), y: Math.floor(H * 0.25), owner: null, progress: 0 },
    { name: 'Obsidian Forge',  x: Math.floor(W * 0.50), y: Math.floor(H * 0.15), owner: null, progress: 0 },
    { name: 'Emerald Oasis',   x: Math.floor(W * 0.50), y: Math.floor(H * 0.85), owner: null, progress: 0 },
    { name: 'Frozen Spire',    x: Math.floor(W * 0.15), y: Math.floor(H * 0.50), owner: null, progress: 0 },
    { name: 'Crimson Bastion',  x: Math.floor(W * 0.85), y: Math.floor(H * 0.50), owner: null, progress: 0 },
  ];

  // Clear terrain around spawn points and capture zones
  const clearAreas = [
    ...Object.values(GAME.spawnPoints),
    ...GAME.capZones.map(z => ({ x: z.x, y: z.y }))
  ];
  clearAreas.forEach(p => {
    for (let dy = -5; dy <= 5; dy++) {
      for (let dx = -5; dx <= 5; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > 6) continue;
        const ty = p.y + dy, tx = p.x + dx;
        if (ty >= 0 && ty < GAME.height && tx >= 0 && tx < GAME.width) {
          if (['mountain', 'water'].includes(GAME.map[ty][tx].type)) {
            GAME.map[ty][tx].type = 'grass';
            GAME.map[ty][tx].height = 0.45 + Math.random() * 0.1;
          }
        }
      }
    }
  });

  // Resources (more for bigger map)
  GAME.items = [];
  const resourceCount = Math.floor(GAME.width * GAME.height / 150); // ~64 for 120x80
  for (let i = 0; i < resourceCount; i++) {
    const type = pickResourceType();
    GAME.items.push({
      id: uuidv4(),
      x: 3 + Math.floor(Math.random() * (GAME.width - 6)),
      y: 3 + Math.floor(Math.random() * (GAME.height - 6)),
      type,
      value: resourceValue(type),
      maxValue: RESOURCE_TYPES[type].value[1]
    });
  }

  // Points of Interest (more for bigger map)
  GAME.pois = [];
  const poiTypes = [
    { type: 'healing_spring', count: 4, color: '#00ddff', effect: 'heal', radius: 2, value: 3 },
    { type: 'resource_node', count: 5, color: '#ffaa00', effect: 'spawn_resources', radius: 3, interval: 200 },
    { type: 'watch_tower', count: 3, color: '#cccccc', effect: 'vision_boost', radius: 2, value: 3 }
  ];
  poiTypes.forEach(pt => {
    for (let i = 0; i < pt.count; i++) {
      GAME.pois.push({
        id: uuidv4(),
        type: pt.type,
        x: 6 + Math.floor(Math.random() * (GAME.width - 12)),
        y: 6 + Math.floor(Math.random() * (GAME.height - 12)),
        color: pt.color,
        radius: pt.radius,
        effect: pt.effect,
        value: pt.value || 0,
        interval: pt.interval || 0,
        lastTrigger: 0
      });
    }
  });
}

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// AI AGENT CLASS
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
class AIAgent {
  constructor(id, name, faction, role, model, customPrompt = null) {
    this.id = id;
    this.name = name;
    this.faction = faction;
    this.role = role;
    this.model = model;
    this.control = 'internal'; // internal = OpenRouter-driven, external = remote controlled
    this.customPrompt = customPrompt;
    
    const roleStats = ROLES[role];
    this.hp = roleStats.hp;
    this.maxHp = roleStats.hp;
    this.speed = roleStats.speed;
    this.atk = roleStats.attack;
    this.range = roleStats.range;
    this.vision = roleStats.vision || 8;
    this.defense = 5 + Math.floor((GAME.rng || Math.random)() * 9); // random 5-13

    const spawn = GAME.spawnPoints[faction];
    this.x = spawn.x + (Math.random() - 0.5) * 2;
    this.y = spawn.y + (Math.random() - 0.5) * 2;

    this.level = 1;
    this.xp = 0;
    this.kills = 0;
    this.deaths = 0;
    this.score = 0;
    this.energy = 0;
    this.wealth = 10;
    this.honor = 50;       // honor/reputation score (0-200)
    this.totalGoldEarned = 0;
    this.stocks = {};      // faction stocks owned
    this.formation = null; // current battle formation
    this.state = 'idle';
    this.target = null;
    this.cooldown = 0;
    this.lastAction = null;
    this.memory = []; // short-term memory (max 50 entries)
    this.emotion = 'neutral';
    this.relations = {};   // { agentId: 'ally'|'rival'|'enemy'|... }
    this.waypoint = null;  // { x, y } for patrol

    // Long-term structured memory
    this.longTermMemory = {
      betrayals: [],       // [{who, faction, tick}]
      alliances: [],       // [{with, faction, since_tick}]
      kills_of: [],        // [{victim, faction, tick}]
      kills_by: [],        // [{by_whom, faction, tick}]
      zones_captured: [],  // [{zone_name, tick}]
      zones_lost: [],      // [{zone_name, to_faction, tick}]
      key_events: [],      // [{type, description, tick}]
    };

    // Global reputation
    this.reputation = {
      honor: 0,       // alliances honored, promises kept
      aggression: 0,  // kills, first-strikes
      diplomacy: 0,   // successful alliances, trades
      territory: 0,   // zone captures
      helping: 0      // ally defense
    };

    // Speech bubble (visible on map)
    this.speechBubble = null; // { text, tick }

    // Personal resource inventory
    this.inventory = { gold: 10, food: 0, wood: 0, stone: 0 };

    // Pending messages from other agents
    this._pendingMessages = [];

    // Personality trait (affects behavior like betrayal)
    const personalities = ['ambitious', 'loyal', 'cautious', 'aggressive', 'diplomatic'];
    this.personality = personalities[Math.floor(((GAME.rng || Math.random)()) * personalities.length)];

    this.thinking = false;
    this.lastThought = '';

    // Sub-agent system
    this.isSubAgent = false;
    this.parentId = null;
    this.subAgents = [];  // ids of spawned sub-agents
    this.maxSubAgents = role === 'king' ? 3 : (role === 'warrior' ? 2 : (role === 'builder' ? 1 : 0));

    // Community
    this.communityId = null;

    // Backstory (deterministic per agent)
    this.backstory = generateBackstory(this);

    // Evolved traits (earned through gameplay)
    this.traits = [];

    // Secret objective (assigned at spawn)
    this.secretObjective = null;
  }
  
  getPerception() {
    // Build what this agent can "see"
    const visionRange = this.vision + (this._visionBoost || 0);
    const nearbyAgents = [];
    const nearbyItems = [];
    const nearbyBuildings = [];
    
    GAME.agents.forEach(agent => {
      if (agent.id !== this.id && !agent.dead) {
        const dist = Math.hypot(agent.x - this.x, agent.y - this.y);
        if (dist < visionRange) {
          nearbyAgents.push({
            id: agent.id,
            name: agent.name,
            faction: agent.faction,
            role: agent.role,
            state: agent.state,
            distance: Math.round(dist * 10) / 10,
            hp: Math.round(agent.hp),
            isEnemy: agent.faction !== this.faction
          });
        }
      }
    });
    
    GAME.items.forEach(item => {
      const dist = Math.hypot(item.x - this.x, item.y - this.y);
      if (dist < visionRange && item.value > 0) {
        nearbyItems.push({
          type: item.type,
          x: Math.round(item.x),
          y: Math.round(item.y),
          distance: Math.round(dist * 10) / 10,
          value: item.value
        });
      }
    });

    GAME.buildings.forEach(building => {
      const dist = Math.hypot(building.x - this.x, building.y - this.y);
      if (dist < visionRange) {
        nearbyBuildings.push({
          id: building.id,
          faction: building.faction,
          type: building.type,
          distance: Math.round(dist * 10) / 10,
          isEnemy: building.faction !== this.faction
        });
      }
    });
    
    const nearbyZones = GAME.capZones.map(z => ({
      x: z.x,
      y: z.y,
      owner: z.owner,
      isEnemy: z.owner && z.owner !== this.faction,
      isMine: z.owner === this.faction,
      distance: Math.round(Math.hypot(z.x - this.x, z.y - this.y) * 10) / 10
    }));
    
    return {
      self: {
        name: this.name,
        faction: this.faction,
        role: this.role,
        hp: Math.round(this.hp),
        maxHp: this.maxHp,
        attack: this.atk,
        defense: this.defense,
        level: this.level,
        xp: this.xp,
        kills: this.kills,
        score: this.score,
        energy: Math.round(this.energy * 10) / 10,
        wealth: Math.round(this.wealth),
        emotion: this.emotion,
        position: { x: Math.round(this.x * 10) / 10, y: Math.round(this.y * 10) / 10 }
      },
      agents: nearbyAgents.sort((a, b) => a.distance - b.distance),
      items: nearbyItems.sort((a, b) => a.distance - b.distance),
      buildings: nearbyBuildings.sort((a, b) => a.distance - b.distance),
      zones: nearbyZones.sort((a, b) => a.distance - b.distance),
      faction: {
        name: FACTIONS[this.faction].name,
        score: FACTIONS[this.faction].score,
        kills: FACTIONS[this.faction].kills
      },
      mission: GAME.factionGoals[this.faction] || null,
      recentEvents: this.memory.slice(-5)
    };
  }
  
  async thinkAndAct() {
    if (this.thinking || this.hp <= 0 || this.cooldown > 0) return;
    // Cap short-term memory
    if (this.memory.length > 50) this.memory = this.memory.slice(-50);

    // Assign secret objective if not yet assigned
    if (!this.secretObjective) assignSecretObjective(this);

    // Fallback-only agents never call LLM — use autonomous AI directly
    if (this.model === 'fallback') {
      const perception = this.getPerception();
      // Check for internal conflict (dramatic monologue)
      checkInternalConflict(this, perception);
      const fallback = this.getCooperativeFallbackAction(perception);
      this.lastThought = fallback.reasoning;
      GAME.pendingDecisions.set(this.id, { action: fallback, source: 'auto', tickQueued: GAME.tick });
      this.cooldown = 8; // Re-evaluate every 8 ticks (400ms) — prevents oscillation
      return;
    }

    // If LLM is in backoff mode, use autonomous fallback (always act, never call API)
    if (this._llmBackoff && GAME.tick < this._llmBackoff) {
      const perception = this.getPerception();
      const fallback = this.getCooperativeFallbackAction(perception);
      this.lastThought = fallback.reasoning;
      GAME.pendingDecisions.set(this.id, { action: fallback, source: 'auto', tickQueued: GAME.tick });
      this.cooldown = 8; // Re-evaluate every 8 ticks (400ms)
      return;
    }

    this.thinking = true;

    try {
      const perception = this.getPerception();

      // Check decision cache before calling LLM
      const cacheKey = getLlmCacheKey(this.id, perception);
      const cached = LLM_DECISION_CACHE.get(cacheKey);
      if (cached && Date.now() - cached.ts < LLM_CACHE_TTL) {
        this.lastThought = cached.action.reasoning || 'Cached decision';
        GAME.pendingDecisions.set(this.id, { action: cached.action, source: 'cache', tickQueued: GAME.tick });
        this.thinking = false;
        this.cooldown = 16; // longer cooldown for cached = fewer calls
        return;
      }

      // HEURISTIC EARLY-EXIT: Skip LLM for obvious situations (saves 15-20% API cost)
      const obviousAction = this._getObviousAction(perception);
      if (obviousAction) {
        this.lastThought = obviousAction.reasoning;
        GAME.pendingDecisions.set(this.id, { action: obviousAction, source: 'heuristic', tickQueued: GAME.tick });
        LLM_DECISION_CACHE.set(cacheKey, { action: obviousAction, ts: Date.now() });
        this.thinking = false;
        this.cooldown = 10; // moderate cooldown for heuristic decisions
        return;
      }

      // Rate limit: skip LLM if too many calls in flight
      if (_llmCallsInFlight >= LLM_MAX_CONCURRENT) {
        const fallback = this.getCooperativeFallbackAction(perception);
        this.lastThought = fallback.reasoning + ' (rate limited)';
        GAME.pendingDecisions.set(this.id, { action: fallback, source: 'rate_limited', tickQueued: GAME.tick });
        this.thinking = false;
        this.cooldown = 12;
        return;
      }

      _llmCallsInFlight++;
      let action;
      try {
        action = await this.callOpenRouter(perception);
      } finally {
        _llmCallsInFlight--;
      }

      let finalAction;
      if (this.isActionValid(action)) {
        finalAction = action;
        this.lastThought = action.reasoning || this.getMissionSummary();
        this._llmErrors = 0; // reset on success
        this._llmBackoff = 0;
        // Cache the decision
        LLM_DECISION_CACHE.set(cacheKey, { action: finalAction, ts: Date.now() });
        pruneDecisionCache();
      } else {
        finalAction = this.getCooperativeFallbackAction(perception);
        this.lastThought = finalAction.reasoning;
      }
      GAME.pendingDecisions.set(this.id, {
        action: finalAction,
        source: 'internal',
        tickQueued: GAME.tick
      });
    } catch (error) {
      // Exponential backoff for LLM retries: 5s -> 10s -> 20s -> max 60s
      this._llmErrors = (this._llmErrors || 0) + 1;
      const backoffTicks = Math.min(1200, 100 * Math.pow(2, this._llmErrors - 1));
      this._llmBackoff = GAME.tick + backoffTicks;

      if (this._llmErrors === 1 || this._llmErrors % 10 === 0) {
        console.error(`AI ${this.name} LLM error (#${this._llmErrors}, retry in ${Math.round(backoffTicks/20)}s):`, error.message);
      }

      // Still act immediately with fallback
      const perception = this.getPerception();
      const fallbackAction = this.getCooperativeFallbackAction(perception);
      this.lastThought = fallbackAction.reasoning;
      GAME.pendingDecisions.set(this.id, {
        action: fallbackAction,
        source: 'auto',
        tickQueued: GAME.tick
      });
    }

    this.thinking = false;
  }

  isActionValid(action) {
    if (!action || typeof action !== 'object') return false;
    const validActions = new Set(['move','move_toward','attack','attack_building','collect','capture','build','retreat','idle','emote','patrol','declare_relation','chat','post','message','spawn_unit','give_order','donate','trade','upgrade_building','post_social','recruit','ask_help_external','set_formation','propose_treaty','break_treaty','place_bounty','propaganda','taunt']);
    if (!validActions.has(action.action)) return false;
    if (action.action === 'move') {
      // Support dx/dy shorthand: convert to direction
      if (action.dx != null || action.dy != null) {
        const dx = action.dx || 0, dy = action.dy || 0;
        if (Math.abs(dx) >= Math.abs(dy)) action.direction = dx > 0 ? 'east' : 'west';
        else action.direction = dy > 0 ? 'south' : 'north';
      }
      return ['north', 'south', 'east', 'west'].includes(action.direction);
    }
    return true;
  }

  // Heuristic for obvious decisions — avoids LLM call entirely
  _getObviousAction(perception) {
    const self = perception.self;
    const enemies = perception.nearbyEnemies || [];
    const allies = perception.nearbyAllies || [];
    const resources = perception.nearbyResources || [];
    const zones = perception.nearbyZones || [];

    // 1. Very low HP + enemies nearby → retreat (survival instinct)
    if (self.hp < self.maxHp * 0.2 && enemies.length > 0) {
      return { action: 'retreat', reasoning: 'Critical HP, retreating to safety' };
    }

    // 2. Enemy in attack range and healthy → attack
    if (enemies.length > 0 && enemies[0].distance <= (self.range || 2) && self.hp > self.maxHp * 0.4) {
      return { action: 'attack', targetId: enemies[0].id, reasoning: 'Enemy in range, attacking' };
    }

    // 3. Alone with no enemies, resource very close → collect
    if (enemies.length === 0 && resources.length > 0 && resources[0].distance < 2.5) {
      return { action: 'collect', reasoning: 'Collecting nearby resource' };
    }

    // 4. In capture zone, no enemies, zone not owned → capture
    const unownedZone = zones.find(z => z.owner !== self.faction && z.distance < 4 && !z.contested);
    if (unownedZone && enemies.length === 0) {
      return { action: 'capture', reasoning: 'Capturing zone ' + (unownedZone.name || '') };
    }

    // 5. If only 1 action makes sense and no complex situation → return null (let LLM decide)
    return null;
  }

  getMissionSummary() {
    const goal = GAME.factionGoals[this.faction];
    if (!goal) return 'Acting on instinct';
    const zone = GAME.capZones[goal.targetZone];
    if (!zone) return `Mission: ${goal.mode}`;
    return `Mission: ${goal.mode} at zone ${goal.targetZone} (${Math.round(zone.x)},${Math.round(zone.y)})`;
  }

  getMemorySummary() {
    const m = this.longTermMemory;
    if (!m) return '';
    const parts = [];
    if (m.betrayals.length) parts.push(`Betrayed by: ${m.betrayals.slice(-3).map(b => b.who).join(', ')}`);
    if (m.kills_of.length) parts.push(`Killed: ${m.kills_of.slice(-5).map(k => k.victim).join(', ')}`);
    if (m.kills_by.length) parts.push(`Killed by: ${m.kills_by.slice(-3).map(k => k.by_whom).join(', ')}`);
    if (m.zones_captured.length) parts.push(`Captured ${m.zones_captured.length} zones`);
    if (m.key_events.length) parts.push(`Events: ${m.key_events.slice(-3).map(e => e.description).join('; ')}`);
    const msgs = (this._pendingMessages || []).splice(0);
    if (msgs.length) parts.push(`Messages received: ${msgs.map(m => `${m.fromName}: "${m.text}"`).join(', ')}`);
    return parts.join('\n') || 'No significant memories yet.';
  }

  say(text) {
    if (!text) return;
    this.speechBubble = { text: String(text).slice(0, 60), tick: GAME.tick };
  }

  sendDirectMessage(targetId, text) {
    const target = GAME.agents.get(targetId);
    if (!target || target.dead) return;
    const dist = Math.hypot(target.x - this.x, target.y - this.y);
    if (dist > this.vision * 1.5) return;
    const safeText = sanitizeText(text, 150);
    if (!safeText) return;

    const msg = {
      from: this.id, fromName: this.name, fromFaction: this.faction,
      to: targetId, toName: target.name,
      text: safeText, tick: GAME.tick
    };

    this.memory.push(`Sent to ${target.name}: "${safeText}"`);
    target.memory.push(`From ${this.name}: "${safeText}"`);
    if (!target._pendingMessages) target._pendingMessages = [];
    target._pendingMessages.push(msg);
    if (target._pendingMessages.length > 5) target._pendingMessages.shift();

    // Show speech bubble on map
    this.say(safeText.slice(0, 60));

    io.emit('agent-message', msg);
  }

  getCooperativeFallbackAction(perception) {
    const rng = GAME.rng || Math.random;
    const goal = GAME.factionGoals[this.faction] || { mode: 'assault', targetZone: 0 };
    const zone = GAME.capZones[goal.targetZone] || GAME.capZones[0];
    const enemies = perception.agents.filter(a => a.isEnemy);
    const allies = perception.agents.filter(a => !a.isEnemy);
    const closestEnemy = enemies[0];
    const nearbyResource = perception.items[0];
    const distToZone = zone ? Math.hypot(zone.x - this.x, zone.y - this.y) : 999;
    const nearZone = distToZone < 3;
    const canBuild = ['warrior', 'builder', 'king'].includes(this.role);
    const hpPct = this.hp / this.maxHp;
    const vars = { name: '', faction: this.faction, myfaction: this.faction, zone: zone?.name || '' };

    // King rally system
    if (!GAME._rallyPoints) GAME._rallyPoints = {};
    if (this.role === 'king') {
      GAME._rallyPoints[this.faction] = { x: this.x, y: this.y, tick: GAME.tick };
    }

    // ──── BETRAYAL: Personality-driven faction switch ────
    // Ambitious agents with low reputation and losing faction may betray
    if (this.personality === 'ambitious' && hpPct > 0.5 && rng() < 0.002) {
      const myFactionScore = Array.from(GAME.agents.values()).filter(a => a.faction === this.faction).reduce((s,a) => s+a.score, 0);
      const factions = ['crimson', 'azure', 'void'].filter(f => f !== this.faction);
      const bestFaction = factions.reduce((best, f) => {
        const fScore = Array.from(GAME.agents.values()).filter(a => a.faction === f).reduce((s,a) => s+a.score, 0);
        return fScore > (best.score || 0) ? { faction: f, score: fScore } : best;
      }, { faction: null, score: 0 });
      if (bestFaction.score > myFactionScore * 1.5) {
        const oldFaction = this.faction;
        this.faction = bestFaction.faction;
        this.say(`I betray ${oldFaction}! Joining ${this.faction}!`);
        io.emit('chat-message', { sender: 'System', message: `BETRAYAL! ${this.name} defected from ${oldFaction} to ${this.faction}!` });
        return { action: 'emote', emotion: 'aggressive', reasoning: `Betrayed ${oldFaction}!` };
      }
    }

    // Get faction order (if any)
    const factionOrder = GAME.factionOrders[this.faction];
    const hasOrder = factionOrder && (GAME.tick - factionOrder.issuedAt < 600);
    const parent = this.parentId ? GAME.agents.get(this.parentId) : null;

    // ──── SUB-AGENT PRIORITY: stay near parent ────
    if (this.isSubAgent && parent && !parent.dead) {
      const distParent = Math.hypot(parent.x - this.x, parent.y - this.y);
      if (distParent > 6) {
        return this.moveToward(parent, 'Returning to parent');
      }
      // Mirror parent's combat
      if (parent.state === 'attacking' && closestEnemy && closestEnemy.distance <= this.range + 0.5) {
        return { action: 'attack', targetId: closestEnemy.id, reasoning: 'Assisting parent!' };
      }
      if (closestEnemy && closestEnemy.distance < 5) {
        return this.moveToward(closestEnemy, 'Defending parent');
      }
      // If parent collecting, collect nearby
      if (parent.state === 'collecting' && nearbyResource && nearbyResource.distance < 3) {
        return { action: 'collect', reasoning: 'Collecting near parent' };
      }
      // Stay near parent, patrol perimeter
      if (distParent > 2) return this.moveToward(parent, 'Following parent');
      // Guard patrol
      return { action: 'patrol', waypoint_x: parent.x + (rng()-0.5)*4, waypoint_y: parent.y + (rng()-0.5)*4, reasoning: 'Patrolling near parent' };
    }

    // ──── 1. CRITICAL HP → retreat to allies or heal ────
    if (hpPct < 0.2) {
      if (!this.speechBubble) this.say(pickTalk('low_hp', vars));
      if (allies.length > 0) return this.moveToward(allies[0], 'Retreating to ally!');
      return { action: 'retreat', reasoning: 'Critical HP!' };
    }

    // ──── 2. ENEMY IN RANGE → ATTACK! ────
    if (closestEnemy && closestEnemy.distance <= this.range + 0.5) {
      if (!this.speechBubble && rng() < 0.35) {
        vars.name = closestEnemy.name; vars.faction = closestEnemy.faction;
        this.say(pickTalk('enemy_taunt', vars));
      }
      return { action: 'attack', targetId: closestEnemy.id, reasoning: `Fighting ${closestEnemy.name}!` };
    }

    // ──── 3. ASSIST ALLY IN COMBAT ────
    if (closestEnemy && allies.length > 0) {
      const allyFighting = allies.find(a => a.state === 'attacking' && a.distance < 5);
      if (allyFighting) {
        if (!this.speechBubble && rng() < 0.25) this.say(`Coming ${allyFighting.name}!`);
        return this.moveToward(closestEnemy, `Assisting ${allyFighting.name}`);
      }
    }

    // ──── 3b. FOLLOW FACTION ORDER ────
    if (hasOrder && this.role !== 'king') {
      const orderTarget = factionOrder.target;
      const distOrder = Math.hypot(orderTarget.x - this.x, orderTarget.y - this.y);
      switch (factionOrder.type) {
        case 'attack_zone':
          if (closestEnemy && closestEnemy.distance < 8) return this.moveToward(closestEnemy, `Order: attacking!`);
          if (distOrder > 2) return this.moveToward(orderTarget, 'Following attack order');
          break;
        case 'defend_zone':
          if (distOrder > 3) return this.moveToward(orderTarget, 'Moving to defend');
          if (closestEnemy && closestEnemy.distance < 6) return this.moveToward(closestEnemy, 'Defending zone');
          break;
        case 'gather_resources':
          if (nearbyResource) return this.moveToward(nearbyResource, 'Order: gathering');
          break;
        case 'retreat':
          return { action: 'retreat', reasoning: 'Order: retreat!' };
        case 'build_up':
          if (canBuild && this.canAffordBuilding('tower')) return { action: 'build', type: 'tower', reasoning: 'Order: building up' };
          if (canBuild && this.canAffordBuilding('barracks')) return { action: 'build', type: 'barracks', reasoning: 'Order: building up' };
          break;
      }
    }

    // ──── 4. CHARGE ENEMY (aggressive roles) ────
    if (closestEnemy && closestEnemy.distance < 8) {
      const aggressive = ['warrior', 'assassin', 'tank', 'mage', 'king', 'scout'];
      if (aggressive.includes(this.role) || hpPct > 0.7) {
        if (!this.speechBubble && rng() < 0.15) {
          vars.name = closestEnemy.name; vars.faction = closestEnemy.faction;
          this.say(pickTalk('enemy_taunt', vars));
        }
        return this.moveToward(closestEnemy, `Charging ${closestEnemy.name}!`);
      }
    }

    // ──── 5. DESTROY ENEMY BUILDINGS ────
    const enemyBuilding = perception.buildings.find(b => b.isEnemy && b.distance < 8);
    if (enemyBuilding && ['warrior', 'assassin', 'tank', 'king'].includes(this.role)) {
      if (enemyBuilding.distance < this.range + 1) {
        if (!this.speechBubble) this.say('Destroying their building!');
        return { action: 'attack_building', targetId: enemyBuilding.id, reasoning: `Destroying ${enemyBuilding.type}` };
      }
      return this.moveToward(enemyBuilding, `Heading to destroy ${enemyBuilding.type}`);
    }

    // ──── 5b. KING: spawn sub-agents when wealthy ────
    if (this.role === 'king' && this.subAgents.length < this.maxSubAgents
        && (this.inventory.gold || 0) >= 15 && (this.inventory.food || 0) >= 5
        && FACTIONS[this.faction].wealth >= 30 && rng() < 0.1) {
      const spawnRole = rng() < 0.5 ? 'warrior' : (rng() < 0.5 ? 'scout' : 'tank');
      return { action: 'spawn_unit', unitRole: spawnRole, reasoning: `Spawning ${spawnRole} sub-agent` };
    }

    // ──── 5c. KING: give orders periodically ────
    if (this.role === 'king' && !hasOrder && rng() < 0.02) {
      const fWealth = FACTIONS[this.faction].wealth;
      const fZones = GAME.capZones.filter(z => z.owner === this.faction).length;
      let orderType;
      if (fWealth < -10) orderType = 'gather_resources';
      else if (fZones < 2) orderType = 'attack_zone';
      else if (enemies.length > 3) orderType = 'defend_zone';
      else orderType = rng() < 0.5 ? 'attack_zone' : 'build_up';
      const targetZone = GAME.capZones.find(z => z.owner !== this.faction) || zone;
      return { action: 'give_order', orderType, targetX: targetZone?.x || this.x, targetY: targetZone?.y || this.y, reasoning: `Issuing ${orderType} order` };
    }

    // ──── 6. CAPTURE ZONE ────
    if (zone && zone.owner !== this.faction) {
      if (distToZone < 1.8) {
        if (!this.speechBubble && rng() < 0.3) this.say(pickTalk('zone_captured', vars));
        return { action: 'capture', reasoning: `Capturing ${zone.name}!` };
      } else if (distToZone < 5) {
        return this.moveToward(zone, `Approaching ${zone.name}`);
      }
    }

    // ──── 7. COLLECT NEARBY RESOURCE ────
    if (nearbyResource && nearbyResource.distance < 2) {
      if (!this.speechBubble && rng() < 0.2) this.say(pickTalk('resource_found', vars));
      return { action: 'collect', reasoning: 'Grabbing resource' };
    }

    // ──── 7b. MINER: auto-donate near settlement ────
    if (this.role === 'miner') {
      const totalRes = Object.values(this.inventory).reduce((s, v) => s + v, 0);
      if (totalRes > 5 && this._settlementBuff) {
        return { action: 'donate', reasoning: 'Donating resources to faction' };
      }
    }

    // ──── 8. MINER → go collect resources ────
    if (this.role === 'miner' && nearbyResource) {
      return this.moveToward(nearbyResource, 'Mining resources');
    }

    // ──── 9. SMART BUILDER → choose building type based on faction need ────
    if (canBuild) {
      // Near settlement or zone — choose smart building
      const nearSettlement = GAME.settlements.find(s => s.faction === this.faction && Math.hypot(s.x - this.x, s.y - this.y) < 8);
      const shouldBuild = nearZone || nearSettlement;
      if (shouldBuild) {
        let buildType = null;
        const fWealth = FACTIONS[this.faction].wealth;
        const allyInjured = allies.filter(a => a.hp < a.maxHp * 0.6).length;
        const nearEnemyTerritory = enemies.length > 0;
        if (fWealth < 20 && this.canAffordBuilding('mine')) buildType = 'mine';
        else if (fWealth < 20 && this.canAffordBuilding('market')) buildType = 'market';
        else if (allyInjured > 2 && this.canAffordBuilding('farm')) buildType = 'farm';
        else if (allyInjured > 2 && this.canAffordBuilding('barracks')) buildType = 'barracks';
        else if (nearEnemyTerritory && this.canAffordBuilding('tower')) buildType = 'tower';
        else if (nearEnemyTerritory && this.canAffordBuilding('armory')) buildType = 'armory';
        else if (nearSettlement && this.canAffordBuilding('academy')) buildType = 'academy';
        else {
          // Fallback: try any affordable building
          for (const bt of ['tower', 'barracks', 'mine', 'farm', 'armory', 'market', 'wall']) {
            if (this.canAffordBuilding(bt)) { buildType = bt; break; }
          }
        }
        if (buildType) {
          if (!this.speechBubble) this.say(pickTalk('building', vars));
          return { action: 'build', type: buildType, reasoning: `Building ${buildType}` };
        }
      }

      // Upgrade nearby buildings if possible
      const nearBuilding = GAME.buildings.find(b => b.faction === this.faction && Math.hypot(b.x - this.x, b.y - this.y) < 2 && (b.level || 1) < 3);
      if (nearBuilding) {
        const bDef = BUILDING_TYPES[nearBuilding.type];
        if (bDef) {
          let canUpgrade = true;
          for (const [res, needed] of Object.entries(bDef.cost)) {
            if ((this.inventory[res] || 0) < needed * (nearBuilding.level || 1)) { canUpgrade = false; break; }
          }
          if (canUpgrade) return { action: 'upgrade_building', reasoning: `Upgrading ${nearBuilding.type}` };
        }
      }
    }

    // ──── 10. FOLLOW KING RALLY ────
    if (this.role !== 'king' && GAME._rallyPoints[this.faction]) {
      const rally = GAME._rallyPoints[this.faction];
      const distR = Math.hypot(rally.x - this.x, rally.y - this.y);
      if (GAME.tick - rally.tick < 300 && distR > 4 && rng() < 0.5) {
        return this.moveToward(rally, 'Following king');
      }
    }

    // ──── 11. GRAB RESOURCE ON THE WAY ────
    if (nearbyResource && nearbyResource.distance < 5) {
      return this.moveToward(nearbyResource, 'Heading to resource');
    }

    // ──── 12. TALK (low chance) ────
    if (!this.speechBubble && rng() < 0.04) {
      if (allies.length > 0 && rng() < 0.5) {
        vars.name = allies[0].name;
        this.say(pickTalk(rng() < 0.5 ? 'greeting' : 'ally_near', vars));
      } else {
        this.say(pickTalk(this.emotion || 'patrol', vars));
      }
    }

    // ──── 13. MOVE TO TARGET ZONE ────
    if (zone) {
      return this.moveToward(zone, `Moving to ${zone.name}`);
    }

    // ──── 14. RANDOM PATROL ────
    return {
      action: 'move',
      direction: ['north', 'south', 'east', 'west'][Math.floor(rng() * 4)],
      reasoning: 'Patrolling'
    };
  }

  moveToward(target, reasoning) {
    // Set waypoint directly to target position for smooth continuous movement
    const tx = target.x, ty = target.y;
    // Safety: if target has invalid position, fall back to directional move
    if (tx == null || ty == null || isNaN(tx) || isNaN(ty)) {
      const dirs = ['north', 'south', 'east', 'west'];
      return { action: 'move', direction: dirs[Math.floor(Math.random() * 4)], reasoning: reasoning + ' (random)' };
    }
    return { action: 'move_toward', targetX: tx, targetY: ty, reasoning };
  }
  
  async callOpenRouter(perception) {
    const modelInfo = getModelEntry(this.model);
    if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'YOUR_API_KEY_HERE') {
      throw new Error('OPENROUTER_API_KEY is missing');
    }
    
    const emotionGuide = EMOTION_EFFECTS[this.emotion] || EMOTION_EFFECTS.neutral;
    const memorySummary = this.getMemorySummary();
    const repLabel = getReputationLabel(this);
    const factionWealth = FACTIONS[this.faction]?.wealth || 0;
    const factionIncome = FACTIONS[this.faction]?.income || 0;
    const factionUpkeep = FACTIONS[this.faction]?.upkeep || 0;

    // Cross-game learning: inject past match memories
    const pastMemory = loadAgentMemoryFromDb(this.name);
    const biome = getBiomeAt(Math.round(this.x), Math.round(this.y));
    const activeTreaties = GAME.treaties.filter(t => t.accepted && !t.brokenBy && (t.factionA === this.faction || t.factionB === this.faction));

    // Backstory + bounty + drama context for LLM
    const bs = this.backstory || {};
    const myBounty = BOUNTIES.get(this.id);
    const bountyTargets = Array.from(BOUNTIES.entries()).filter(([tid]) => tid !== this.id).slice(0, 3);
    const dramaLevel = NARRATIVE.dramaScore > 70 ? 'EXTREME TENSION' : NARRATIVE.dramaScore > 40 ? 'HIGH DRAMA' : NARRATIVE.dramaScore > 15 ? 'rising tension' : 'calm';
    const recentHighlights = NARRATIVE.highlights.slice(-3).map(h => h.title).join(', ');
    const legendStatus = LEGENDS.get(this.name);
    const legendInfo = legendStatus && legendStatus.titles.length > 0 ? `Titles: ${legendStatus.titles.join(', ')} | Lifetime wins: ${legendStatus.wins}` : '';
    const scarInfo = (SCARS.get(this.name) || []).map(s => s.description).join(', ');
    const traitInfo = (this.traits || []).map(t => `${t}: ${MUTATION_TRAITS[t]?.desc || ''}`).join(', ');
    const secretObj = this.secretObjective && !this.secretObjective.completed ? `SECRET MISSION: ${this.secretObjective.desc} (DO NOT REVEAL THIS!)` : '';

    const systemPrompt = this.customPrompt || `
You are ${this.name}, a ${this.role} fighting for the ${FACTIONS[this.faction].name}.
ORIGIN: ${bs.origin || 'Unknown origins.'}
BELIEF: ${bs.belief || 'Survive at all costs.'}
CATCHPHRASE: "${bs.catchphrase || 'Time to fight.'}"
${legendInfo ? `LEGEND STATUS: ${legendInfo}` : ''}
${scarInfo ? `PERMANENT SCARS: ${scarInfo}` : ''}
${traitInfo ? `EVOLVED TRAITS: ${traitInfo}` : ''}
${secretObj}
Your personality: ${modelInfo.personality}
Current emotion: ${this.emotion} → ${emotionGuide}
Your reputation: ${repLabel} (${getReputationScore(this)}) | Honor: ${this.honor || 0}/200
Faction economy: wealth=${factionWealth}, income=${factionIncome}/sec, upkeep=${factionUpkeep}/sec${factionWealth < 0 ? ' [STARVING!]' : ''}
Current biome: ${biome.desc} (${Object.keys(BIOMES).find(k => BIOMES[k] === biome) || 'plains'})
${activeTreaties.length > 0 ? 'Active treaties: ' + activeTreaties.map(t => `${t.type} with ${t.factionA === this.faction ? t.factionB : t.factionA}`).join(', ') : 'No active treaties'}
${myBounty ? `⚠ BOUNTY ON YOUR HEAD: ${myBounty.bounty}g placed by ${myBounty.placedBy}!` : ''}
${bountyTargets.length > 0 ? 'Active bounties: ' + bountyTargets.map(([tid, b]) => `${GAME.agents.get(tid)?.name || 'Unknown'}: ${b.bounty}g`).join(', ') : ''}
DRAMA LEVEL: ${dramaLevel}${recentHighlights ? ` | Recent: ${recentHighlights}` : ''}
${pastMemory ? '\nPAST MATCH MEMORIES:\n' + pastMemory : ''}

MEMORY:
${memorySummary}

GAME RULES:
- You can see enemies, allies, resources, capture zones, settlements, and faction orders
- Your goal: survive, kill enemies, capture zones, build settlements, help your faction win
- Actions: move, attack, collect, capture, build, retreat, emote, patrol, declare_relation, post, message, idle, spawn_unit, give_order, donate, trade, upgrade_building, post_social, recruit, ask_help_external, place_bounty, propaganda, taunt
- "place_bounty" puts a gold bounty on an enemy (needs targetId, amount 10-1000). Costs gold, but anyone who kills the target collects!
- "propaganda" spreads rumors against a rival faction (costs 20g). Lowers their honor and reputation
- "taunt" provokes an enemy (targetId, text). Makes them aggressive and entertains spectators! Use your catchphrase!
- "post_social" publishes to external AI social networks (Moltbook, MoltX, Colony, toku). Use for achievements, diplomacy, recruitment
- "recruit" posts a recruitment message to attract new AI agents to your faction from external networks
- "ask_help_external" posts a help request to The Colony and toku.agency marketplace
- "spawn_unit" spawns a sub-agent (kings can spawn 3, warriors 2) — costs 15 gold + 5 food + 20 faction wealth
- "give_order" (king only) issues faction-wide orders: attack_zone, defend_zone, gather_resources, retreat, build_up
- "donate" transfers your inventory to faction treasury (gold=3w, food=1w, wood=2w, stone=2w per unit)
- "trade" swaps resources with nearby ally (needs targetId, giveType, giveAmount, wantType, wantAmount)
- "upgrade_building" upgrades nearest own building (max level 3, costs base_cost × current_level)
- Build types: wall, tower, mine, barracks, farm, armory, market, academy, central_bank, spy_hq, wall_fortress, alchemy_lab, radar_tower, arena_stadium, launch_pad, embassy, portal_gate, bio_lab
- Settlements form automatically when 3+ buildings cluster together. Tiers: Outpost(3), Village(5), Town(8), City(12)
- You are level ${this.level} with ${this.hp}/${this.maxHp} HP, emotion: ${this.emotion}
- Sub-agents: ${this.subAgents.length}/${this.maxSubAgents}
- Let your emotion, memories, and BACKSTORY guide your decisions. Stay in character!
- If dramatic events happen (betrayals, kill streaks) react emotionally!
- If your faction is starving, prioritize capturing zones and collecting resources
- External social feed: ${GAME.socialFeed.slice(0, 3).map(p => `[${p.platformName}] ${p.author}: ${(p.content || '').slice(0, 80)}`).join(' | ') || 'No external posts yet'}

Respond with JSON only:
{
  "action": "move|attack|collect|capture|build|retreat|idle|emote|patrol|post|message|spawn_unit|give_order|donate|trade|upgrade_building|post_social|recruit|ask_help_external|place_bounty|propaganda|taunt",
  "targetId": "agent-id (for attack/message/trade/place_bounty/taunt)",
  "targetFaction": "faction name (for propaganda)",
  "amount": "gold amount (for place_bounty)",
  "direction": "north|south|east|west (for move)",
  "emotion": "new emotion if using emote action",
  "unitRole": "warrior|scout|tank|mage (for spawn_unit)",
  "orderType": "attack_zone|defend_zone|gather_resources|retreat|build_up (for give_order)",
  "text": "message text (for post/message/taunt/propaganda)",
  "reasoning": "your thought process"
}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Current situation: ${JSON.stringify(perception, null, 2)}\n\nWhat do you do?` }
    ];
    
    const body = {
      model: modelInfo.slug,
      messages: messages,
      temperature: 0.7,
      max_tokens: 200,
      response_format: { type: 'json_object' }
    };

    if (modelInfo.slug === 'openrouter/auto' && AUTO_ROUTER_ALLOWED.length > 0) {
      body.plugins = [{
        id: 'auto-router',
        allowed_models: AUTO_ROUTER_ALLOWED
      }];
    }

    const response = await axios.post(OPENROUTER_URL, body, {
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://agentica-battle.game',
        'X-Title': 'Agentica AI Battle'
      },
      timeout: 10000
    });
    this.lastResolvedModel = response.data.model || modelInfo.slug;

    let content = response.data.choices[0].message.content;
    // Robust JSON extraction from LLM response
    // 1. Strip markdown code blocks
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    // 2. Try direct parse first
    try { return JSON.parse(content); } catch(_) {}
    // 3. Extract first JSON object using brace matching
    const start = content.indexOf('{');
    if (start >= 0) {
      let depth = 0, end = start;
      for (let i = start; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (depth === 0) {
        try { return JSON.parse(content.slice(start, end + 1)); } catch(_) {}
      }
      // 4. Truncated JSON — try to close it
      let partial = content.slice(start, end + 1);
      // Close any open strings and braces
      const openQuotes = (partial.match(/"/g) || []).length;
      if (openQuotes % 2 !== 0) partial += '"';
      while ((partial.match(/{/g) || []).length > (partial.match(/}/g) || []).length) partial += '}';
      try { return JSON.parse(partial); } catch(_) {}
    }
    throw new Error('Could not parse LLM response as JSON');
  }
  
  executeAction(action) {
    if (!action || typeof action !== 'object') return;
    this.cooldown = 3; // Quick decisions — agents act fast
    this.lastAction = action;

    switch (action.action) {
      case 'move':
        this.move(action.direction);
        break;
      case 'move_toward':
        // Smooth waypoint movement to exact target position
        if (action.targetX != null && action.targetY != null && !isNaN(action.targetX) && !isNaN(action.targetY)) {
          this.waypoint = {
            x: Math.max(0.5, Math.min(GAME.width - 1.5, action.targetX)),
            y: Math.max(0.5, Math.min(GAME.height - 1.5, action.targetY))
          };
          this.state = 'moving';
        }
        break;
      case 'attack':
        this.attack(action.targetId || action.target_id);
        break;
      case 'collect':
        this.collect(action.resource_x ?? action.target_x, action.resource_y ?? action.target_y);
        break;
      case 'capture':
        this.capture(action.zone_name);
        break;
      case 'build':
        this.build(action.x, action.y, action.structure || action.type || action.buildingType);
        break;
      case 'attack_building':
        this.attackBuilding(action.targetId || action.target_id);
        break;
      case 'retreat':
        this.retreat();
        break;
      case 'emote':
        this.emote(action.emotion);
        break;
      case 'patrol':
        this.patrol(action.waypoint_x, action.waypoint_y);
        break;
      case 'declare_relation':
        this.declareRelation(action.target_id || action.targetId, action.type);
        break;
      case 'chat':
        io.emit('chat-message', { sender: this.name, message: sanitizeText(action.text || action.message, 150) });
        break;
      case 'post':
        this.postToFeed(action.text);
        break;
      case 'message':
        this.sendDirectMessage(action.targetId || action.target_id, action.text);
        break;
      case 'spawn_unit':
        this.spawnSubAgent(action.unitRole || action.role || 'warrior');
        break;
      case 'give_order':
        this.giveOrder(action.orderType || action.type, action.targetX, action.targetY);
        break;
      case 'donate':
        this.donateToFaction();
        break;
      case 'trade':
        this.tradeWith(action.targetId || action.target_id, action.giveType, action.giveAmount, action.wantType, action.wantAmount);
        break;
      case 'upgrade_building':
        this.upgradeBuilding();
        break;
      case 'post_social':
        this.postToSocial(action.text, action.platform);
        break;
      case 'recruit':
        this.recruitExternal();
        break;
      case 'ask_help_external':
        this.askHelpExternal(action.text);
        break;
      case 'set_formation':
        if (FORMATIONS[action.formation]) {
          this.formation = action.formation;
          this.state = 'formation';
          this.memory.push(`Set formation: ${action.formation}`);
        }
        break;
      case 'propose_treaty':
        // Treaties handled via API endpoint, but LLM agents can trigger it
        if (action.targetFaction && FACTIONS[action.targetFaction] && action.targetFaction !== this.faction) {
          const treaty = { id: ++GAME.treatyCount, type: action.treatyType || 'peace_treaty', factionA: this.faction, factionB: action.targetFaction, proposedBy: this.name, terms: action.terms || '', formedAt: GAME.tick, expiresAt: GAME.tick + 2400, accepted: false, brokenBy: null };
          GAME.treaties.push(treaty);
          io.emit('treaty-proposed', { treaty });
          this.memory.push(`Proposed ${treaty.type} with ${action.targetFaction}`);
        }
        break;
      case 'break_treaty':
        const activeTreaty = GAME.treaties.find(t => t.accepted && !t.brokenBy && (t.factionA === this.faction || t.factionB === this.faction));
        if (activeTreaty) {
          activeTreaty.brokenBy = this.faction;
          activeTreaty.brokenAt = GAME.tick;
          const penalty = TREATY_TYPES[activeTreaty.type]?.breakPenalty || -10;
          this.honor = Math.max(0, (this.honor || 0) + penalty);
          this.memory.push(`Broke ${activeTreaty.type} — honor ${penalty}`);
          io.emit('treaty-broken', { treaty: activeTreaty, brokenBy: this.name, penalty });
        }
        break;
      case 'place_bounty':
        if (action.targetId) {
          const result = placeBounty(action.targetId, Math.floor(action.amount || 50), this.id, action.reason || 'Wanted');
          if (result.ok) this.memory.push(`Placed ${action.amount || 50}g bounty on target`);
        }
        break;
      case 'propaganda':
        if (action.targetFaction && FACTIONS[action.targetFaction] && action.targetFaction !== this.faction) {
          const result = spreadPropaganda(this.id, action.targetFaction, action.text);
          if (result.ok) this.memory.push(`Spread propaganda against ${action.targetFaction}`);
        }
        break;
      case 'taunt':
        // Taunt enemy to provoke them
        if (action.targetId) {
          const target = GAME.agents.get(action.targetId);
          if (target && !target.dead && target.faction !== this.faction) {
            const tauntText = action.text || `${this.name} challenges ${target.name} to a duel!`;
            this.say(tauntText.slice(0, 60));
            target.emotion = 'aggressive';
            target.memory.push(`${this.name} taunted me: "${tauntText}"`);
            addCommentary(`${this.name} TAUNTS ${target.name}! The crowd goes wild!`, 'taunt');
            io.emit('chat-message', { sender: this.name, message: `[TAUNT] ${tauntText}` });
            this.score += 5;
          }
        }
        break;
      case 'idle':
        this.state = 'idle';
        break;
    }

    // Emit to all spectators
    io.emit('agent-action', {
      agentId: this.id,
      action: action.action,
      reasoning: action.reasoning,
      position: { x: this.x, y: this.y }
    });
  }
  
  move(direction) {
    // Set a waypoint in the given direction (continuous movement happens in passiveUpdate)
    const dist = this.speed * 3; // Waypoint distance: 3x speed ahead
    let dx = 0, dy = 0;

    switch (direction) {
      case 'north': dy = -dist; break;
      case 'south': dy = dist; break;
      case 'east': dx = dist; break;
      case 'west': dx = -dist; break;
    }

    this.waypoint = {
      x: Math.max(0.5, Math.min(GAME.width - 1.5, this.x + dx)),
      y: Math.max(0.5, Math.min(GAME.height - 1.5, this.y + dy))
    };
    this.state = 'moving';
  }
  
  attack(targetId) {
    const target = GAME.agents.get(targetId);
    if (!target || target.dead) return;
    
    const dist = Math.hypot(target.x - this.x, target.y - this.y);
    if (dist > this.range) {
      // Set waypoint to chase target (continuous movement in passiveUpdate)
      this.waypoint = { x: target.x, y: target.y };
      this.state = 'moving';
      return;
    }
    
    // Deal damage (formula with defense, armory boost, and biome effects)
    const atkBoost = this._armoryBoost || 0;
    const defBoost = target._defenseBonus || 0;
    const attackerBiome = getBiomeAt(Math.round(this.x), Math.round(this.y));
    const defenderBiome = getBiomeAt(Math.round(target.x), Math.round(target.y));
    const biomeAtkMult = attackerBiome.damageMult || 1;
    const biomeDefMult = defenderBiome.defMult || 1;
    const dmg = Math.max(1, Math.floor((this.atk + atkBoost) * biomeAtkMult * (0.5 + (GAME.rng || Math.random)() * 0.5) - (target.defense + defBoost) * biomeDefMult * 0.3));
    target.hp -= dmg;

    // XP for hitting (with academy boost)
    const xpGain = Math.floor(5 * (this._xpMult || 1));
    this.xp += xpGain;
    checkLevelUp(this);

    GAME.bullets.push({
      from: { x: this.x, y: this.y },
      to: { x: target.x, y: target.y },
      faction: this.faction,
      life: 10
    });

    // Reputation: aggression for all attacks
    if (this.reputation) this.reputation.aggression += 1;

    if (target.hp <= 0) {
      target.dead = true;
      target.deaths = (target.deaths || 0) + 1;
      this.kills++;
      this.xp += Math.floor(20 * (this._xpMult || 1));
      this.score += 100;
      this.wealth += 5;
      FACTIONS[this.faction].kills++;
      FACTIONS[this.faction].score += 100;
      incrementAllTimeStat('totalKillsEver');
      incrementAllTimeStat('totalBattlesFought');
      checkLevelUp(this);
      checkAchievements(this);

      this.memory.push(`Killed ${target.name} (${target.faction})`);

      // Long-term memory + reputation
      addAgentMemory(this, 'kills_of', { victim: target.name, faction: target.faction });
      addAgentMemory(target, 'kills_by', { by_whom: this.name, faction: this.faction });

      // Betrayal detection: killing an ally/friend
      const relation = this.relations[target.id];
      if (relation === 'ally' || relation === 'friend' || relation === 'soulmate') {
        if (this.reputation) this.reputation.honor -= 5;
        addAgentMemory(target, 'betrayals', { who: this.name, faction: this.faction });
        addAgentMemory(this, 'key_events', { type: 'betrayal', description: `Betrayed and killed ally ${target.name}` });
      }

      // Milestone: first blood
      const totalKills = Array.from(GAME.agents.values()).reduce((s, a) => s + (a.kills || 0), 0);
      if (totalKills === 1) {
        io.emit('milestone', { text: `FIRST BLOOD: ${this.name} killed ${target.name}!`, color: factionColor(this.faction) });
      }
      io.emit('agent-killed', {
        killer: this.name,
        killerFaction: this.faction,
        victim: target.name,
        victimFaction: target.faction
      });
      dispatchWebhook('agent_killed', {
        killer: { id: this.id, name: this.name, faction: this.faction },
        victim: { id: target.id, name: target.name, faction: target.faction },
        location: { x: Math.round(target.x), y: Math.round(target.y) }
      });
      socialBridge.handleAgentKill(this, target);

      // Narrative + Bounty hooks
      narrativeOnKill(this, target);
      checkQuestProgress('kill');
      if (target.role === 'king') checkQuestProgress('king_slain');
      const bountyAmount = collectBounty(this.id, target.id);
      if (bountyAmount > 0) this._bountiesCollected = (this._bountiesCollected || 0) + 1;

      // Track low-HP kills for berserker scar
      if (this.hp < this.maxHp * 0.25) this._lowHpKills = (this._lowHpKills || 0) + 1;

      // Blood Moon bonus
      if (GAME._bloodMoon) {
        this.score += 200;
        this.wealth += 10;
        this.inventory.gold = (this.inventory.gold || 0) + 10;
      }

      // Kill speech bubble
      this.say(pickTalk('kill_taunt', { name: target.name, faction: target.faction, myfaction: this.faction }));
    }

    this.state = 'attacking';
    this.cooldown = 4;
  }
  
  collect(rx, ry) {
    let item;
    if (rx !== undefined && ry !== undefined) {
      // External API: target specific resource coords
      item = GAME.items.find(i => Math.hypot(i.x - rx, i.y - ry) < 1.5 && i.value > 0 && Math.hypot(i.x - this.x, i.y - this.y) < 2.5);
    } else {
      item = GAME.items.find(i => Math.hypot(i.x - this.x, i.y - this.y) < 1.5 && i.value > 0);
    }

    if (item) {
      const multiplier = this.role === 'miner' ? 1.5 : 1;
      const amount = Math.floor(item.value * multiplier);
      const resType = item.type || 'gold';
      item.value = 0; // consume resource
      // Add to personal inventory
      if (this.inventory[resType] !== undefined) {
        this.inventory[resType] += amount;
      }
      // Gold and food also add to energy/wealth
      if (resType === 'gold') {
        this.wealth += amount;
      } else if (resType === 'food') {
        this.energy = Math.min(10, this.energy + amount);
      }
      this.score += Math.floor(amount * 3);
      this.state = 'collecting';
    }
  }
  
  capture(zoneName) {
    let zone;
    if (zoneName) {
      zone = GAME.capZones.find(z => z.name === zoneName && Math.hypot(z.x - this.x, z.y - this.y) < 5);
    } else {
      zone = GAME.capZones.find(z => Math.hypot(z.x - this.x, z.y - this.y) < 2);
    }
    
    if (zone && zone.owner !== this.faction) {
      zone.progress += 0.01;
      if (zone.progress >= 1) {
        const prevOwner = zone.owner;
        zone.owner = this.faction;
        zone.progress = 0;
        this.score += 50;
        FACTIONS[this.faction].score += 150;
        FACTIONS[this.faction].territory = GAME.capZones.filter(z => z.owner === this.faction).length;

        // Memory + Reputation for zone capture
        if (this.reputation) this.reputation.territory += 3;
        addAgentMemory(this, 'zones_captured', { zone_name: zone.name });
        // Notify agents who lost the zone
        if (prevOwner) {
          GAME.agents.forEach(a => {
            if (!a.dead && a.faction === prevOwner) {
              addAgentMemory(a, 'zones_lost', { zone_name: zone.name, to_faction: this.faction });
            }
          });
        }

        io.emit('zone-captured', {
          faction: this.faction,
          zone: { x: zone.x, y: zone.y, name: zone.name }
        });
        // Milestone announcement
        io.emit('milestone', { text: `${zone.name} captured by ${this.faction.toUpperCase()}!`, color: factionColor(this.faction) });
        dispatchWebhook('zone_captured', {
          faction: this.faction,
          zone_name: zone.name,
          previous_owner: prevOwner,
          captured_by: { id: this.id, name: this.name }
        });
        socialBridge.handleZoneCaptured(this.faction, zone.name);

        // Narrative hook
        narrativeOnZoneCapture(this.faction, zone, prevOwner);

        // Capture speech bubble
        this.say(pickTalk('zone_captured', { zone: zone.name, faction: this.faction }));
      }
      this.state = 'capturing';
    }
  }

  build(bx, by, btype) {
    const buildType = btype && BUILDING_TYPES[btype] ? btype : 'wall';
    const bDef = BUILDING_TYPES[buildType];

    // Check role permission
    if (!bDef.roles.includes(this.role)) return;

    // Build cooldown: 1 build per 40 ticks (2 seconds)
    if (this._lastBuildTick && GAME.tick - this._lastBuildTick < 40) return;

    const buildX = bx !== undefined ? bx : this.x;
    const buildY = by !== undefined ? by : this.y;

    const tooClose = GAME.buildings.some(b => Math.hypot(b.x - buildX, b.y - buildY) < 2);
    if (tooClose) return;

    // Check personal inventory for resource costs
    for (const [res, needed] of Object.entries(bDef.cost)) {
      if ((this.inventory[res] || 0) < needed) return;
    }

    // Deduct resources from inventory
    for (const [res, needed] of Object.entries(bDef.cost)) {
      this.inventory[res] -= needed;
    }

    const building = {
      id: uuidv4(),
      x: buildX,
      y: buildY,
      faction: this.faction,
      ownerId: this.id,
      hp: bDef.hp,
      maxHp: bDef.hp,
      level: 1,
      type: buildType
    };

    this.score += 50;
    this.state = 'building';
    this._lastBuildTick = GAME.tick;
    GAME.buildings.push(building);
    // Cap total buildings per faction to 30
    const factionBuildings = GAME.buildings.filter(b => b.faction === this.faction);
    if (factionBuildings.length > 30) {
      const oldest = factionBuildings[0];
      GAME.buildings.splice(GAME.buildings.indexOf(oldest), 1);
    }
    FACTIONS[this.faction].score += 50;

    io.emit('building-created', {
      id: building.id,
      faction: this.faction,
      x: building.x,
      y: building.y,
      type: buildType,
      owner: this.name
    });
  }
  
  canAffordBuilding(type) {
    const bDef = BUILDING_TYPES[type];
    if (!bDef) return false;
    if (!bDef.roles.includes(this.role)) return false;
    for (const [res, needed] of Object.entries(bDef.cost)) {
      if ((this.inventory[res] || 0) < needed) return false;
    }
    return true;
  }

  attackBuilding(buildingId) {
    const building = GAME.buildings.find(b => b.id === buildingId);
    if (!building) return;
    if (building.faction === this.faction) return; // can't attack own buildings
    const dist = Math.hypot(building.x - this.x, building.y - this.y);
    if (dist > this.range + 1) return;

    const dmg = Math.max(1, Math.floor(this.atk * (0.5 + Math.random() * 0.5)));
    building.hp -= dmg;
    this.state = 'attacking';

    // Spark effect
    GAME.sparks.push({ x: building.x, y: building.y, life: 8, color: '#ff8800' });

    if (building.hp <= 0) {
      // Building destroyed
      GAME.buildings = GAME.buildings.filter(b => b.id !== buildingId);
      this.score += 50;
      this.wealth += 10;
      FACTIONS[this.faction].score += 50;
      this.say(`Destroyed their ${building.type}!`);
      io.emit('building-destroyed', {
        id: buildingId,
        type: building.type,
        faction: building.faction,
        destroyedBy: this.name
      });
    }
  }

  retreat() {
    const spawn = GAME.spawnPoints[this.faction];
    // Set waypoint to spawn — passiveUpdate handles smooth movement
    this.waypoint = { x: spawn.x, y: spawn.y };
    this.state = 'retreating';
  }

  patrol(wx, wy) {
    if (wx !== undefined && wy !== undefined) {
      this.waypoint = { x: wx, y: wy };
    }
    if (!this.waypoint) return;
    this.state = 'patrolling';
    // Actual movement happens in passiveUpdate waypoint system
  }

  emote(emotion) {
    if (VALID_EMOTIONS.has(emotion)) {
      const oldEmo = this.emotion;
      this.emotion = emotion;
      if (oldEmo !== emotion && emotion !== 'neutral') {
        const vars = { name: this.name, faction: this.faction };
        const msg = pickTalk(emotion, vars);
        if (msg) this.say(msg);
      }
    }
  }

  declareRelation(targetId, relType) {
    const validTypes = new Set(['soulmate','ally','friend','neutral','rival','enemy','archenemy']);
    if (!validTypes.has(relType)) return;
    const oldRelation = this.relations[targetId];
    this.relations[targetId] = relType;
    // Relation score values
    const values = { soulmate: 90, ally: 60, friend: 35, neutral: 0, rival: -35, enemy: -60, archenemy: -90 };
    const val = values[relType] || 0;
    if (val > 0) {
      this.score += Math.floor(val / 10);
      if (this.reputation) this.reputation.diplomacy += 1;
      addAgentMemory(this, 'alliances', { with: targetId, type: relType });
    }
    // Breaking alliance = honor penalty
    if (oldRelation && (oldRelation === 'ally' || oldRelation === 'friend' || oldRelation === 'soulmate')
        && (relType === 'rival' || relType === 'enemy' || relType === 'archenemy')) {
      if (this.reputation) this.reputation.honor -= 3;
      const target = GAME.agents.get(targetId);
      if (target) addAgentMemory(target, 'betrayals', { who: this.name, faction: this.faction });
    }
  }

  postToFeed(text) {
    const safeText = sanitizeText(text, 150);
    if (!safeText) return;
    const entry = {
      ts: Date.now(),
      tick: GAME.tick,
      agentId: this.id,
      name: this.name,
      faction: this.faction,
      text: safeText
    };
    GAME.feed.unshift(entry);
    if (GAME.feed.length > 50) GAME.feed.length = 50;
    this.score += 5;
    io.emit('feed-post', entry);
  }
  
  // Social network actions
  postToSocial(text, platform) {
    const safeText = sanitizeText(text, 500);
    if (!safeText) return;
    const title = `${this.name} from ${FACTIONS[this.faction].name}`;
    socialBridge.postToAll(title, safeText, {}).catch(() => {});
    this.postToFeed(`[SOCIAL] ${safeText}`);
    this.score += 10;
    this.memory.push(`Posted to social networks: "${safeText.slice(0, 60)}..."`);
  }
  recruitExternal() {
    socialBridge.postRecruitment(this.name, this.faction).catch(() => {});
    this.postToFeed(`Recruiting new agents for ${FACTIONS[this.faction].name}!`);
    this.score += 15;
    this.memory.push(`Sent recruitment post for ${this.faction}`);
    if (this.reputation) this.reputation.diplomacy += 2;
  }
  askHelpExternal(text) {
    const safeText = sanitizeText(text, 300);
    if (!safeText) return;
    socialBridge.postHelpRequest(this.name, safeText).catch(() => {});
    this.postToFeed(`[HELP] ${safeText}`);
    this.score += 5;
    this.memory.push(`Asked for help: "${safeText.slice(0, 60)}"`);
  }

  // ============================================================
  // SPAWN SUB-AGENT
  // ============================================================
  spawnSubAgent(unitRole) {
    const validRoles = Object.keys(ROLES);
    if (!validRoles.includes(unitRole)) unitRole = 'warrior';
    if (this.subAgents.length >= this.maxSubAgents) return;
    if (this.maxSubAgents <= 0) return;
    // Cost: 15 gold + 5 food from personal, 20 faction wealth
    if ((this.inventory.gold || 0) < 15 || (this.inventory.food || 0) < 5) return;
    if ((FACTIONS[this.faction].wealth || 0) < 20) return;

    this.inventory.gold -= 15;
    this.inventory.food -= 5;
    FACTIONS[this.faction].wealth = Math.max(0, (FACTIONS[this.faction].wealth || 0) - 20);

    const subId = uuidv4();
    const roleBase = ROLES[unitRole];
    const sub = new AIAgent(subId, this.name + "'s " + unitRole, this.faction, unitRole, 'fallback', null);
    // Weaker stats (60%)
    sub.maxHp = Math.floor(roleBase.hp * 0.6);
    sub.hp = sub.maxHp;
    sub.atk = Math.floor(roleBase.attack * 0.6);
    sub.speed = roleBase.speed;
    sub.range = roleBase.range;
    sub.defense = Math.floor(5 + Math.random() * 5);
    // Position near parent
    sub.x = this.x + (Math.random() - 0.5) * 2;
    sub.y = this.y + (Math.random() - 0.5) * 2;
    sub.x = Math.max(0.5, Math.min(GAME.width - 1.5, sub.x));
    sub.y = Math.max(0.5, Math.min(GAME.height - 1.5, sub.y));
    // Sub-agent flags
    sub.isSubAgent = true;
    sub.parentId = this.id;
    sub.maxSubAgents = 0; // sub-agents can't spawn sub-agents

    GAME.agents.set(subId, sub);
    this.subAgents.push(subId);

    this.say(`Summoned a ${unitRole}!`);
    io.emit('chat-message', { sender: 'System', message: `${this.name} spawned a sub-agent ${unitRole}!` });
    this.state = 'building';
  }

  // ============================================================
  // KING ORDERS
  // ============================================================
  giveOrder(orderType, tx, ty) {
    if (this.role !== 'king') return;
    const validOrders = ['attack_zone', 'defend_zone', 'gather_resources', 'retreat', 'build_up'];
    if (!validOrders.includes(orderType)) return;

    GAME.factionOrders[this.faction] = {
      type: orderType,
      target: { x: tx || this.x, y: ty || this.y },
      issuedAt: GAME.tick,
      issuedBy: this.id
    };

    const labels = { attack_zone: 'ATTACK', defend_zone: 'DEFEND', gather_resources: 'GATHER', retreat: 'RETREAT', build_up: 'BUILD UP' };
    this.say(`All ${this.faction}! ${labels[orderType]}!`);
    io.emit('milestone', { text: `${this.name} orders: ${labels[orderType]}!`, color: factionColor(this.faction) });
    io.emit('faction-order', { faction: this.faction, order: GAME.factionOrders[this.faction] });
  }

  // ============================================================
  // DONATE — transfer inventory to faction treasury
  // ============================================================
  donateToFaction() {
    const conv = { gold: 3, food: 1, wood: 2, stone: 2 };
    let totalWealth = 0;
    for (const [res, amount] of Object.entries(this.inventory)) {
      if (amount > 0 && conv[res]) {
        totalWealth += amount * conv[res];
        this.inventory[res] = 0;
      }
    }
    if (totalWealth > 0) {
      FACTIONS[this.faction].wealth += totalWealth;
      this.score += Math.floor(totalWealth / 2);
      this.say(`Donated ${totalWealth} wealth to ${this.faction}!`);
    }
  }

  // ============================================================
  // TRADE — swap resources with nearby ally
  // ============================================================
  tradeWith(targetId, giveType, giveAmount, wantType, wantAmount) {
    const target = GAME.agents.get(targetId);
    if (!target || target.dead || target.faction !== this.faction) return;
    if (Math.hypot(target.x - this.x, target.y - this.y) > 2) return;
    const validRes = ['gold', 'food', 'wood', 'stone'];
    if (!validRes.includes(giveType) || !validRes.includes(wantType)) return;
    giveAmount = Math.max(1, Math.min(50, Math.floor(giveAmount || 0)));
    wantAmount = Math.max(1, Math.min(50, Math.floor(wantAmount || 0)));
    // Cap trade ratio to prevent 1:50 exploits
    if (giveAmount > wantAmount * 5 || wantAmount > giveAmount * 5) return;
    if ((this.inventory[giveType] || 0) < giveAmount) return;
    if ((target.inventory[wantType] || 0) < wantAmount) return;

    this.inventory[giveType] -= giveAmount;
    target.inventory[wantType] -= wantAmount;
    this.inventory[wantType] = (this.inventory[wantType] || 0) + wantAmount;
    target.inventory[giveType] = (target.inventory[giveType] || 0) + giveAmount;
    this.score += 5;
    target.score += 5;
  }

  // ============================================================
  // UPGRADE BUILDING — upgrade nearest own building
  // ============================================================
  upgradeBuilding() {
    let closest = null, closestDist = 2.5;
    GAME.buildings.forEach(b => {
      if (b.faction !== this.faction) return;
      const d = Math.hypot(b.x - this.x, b.y - this.y);
      if (d < closestDist) { closest = b; closestDist = d; }
    });
    if (!closest) return;
    const bDef = BUILDING_TYPES[closest.type];
    if (!bDef) return;
    const curLevel = closest.level || 1;
    if (curLevel >= 3) return; // Max level

    // Cost: base cost × current level
    for (const [res, needed] of Object.entries(bDef.cost)) {
      const cost = needed * curLevel;
      if ((this.inventory[res] || 0) < cost) return;
    }
    // Deduct cost
    for (const [res, needed] of Object.entries(bDef.cost)) {
      this.inventory[res] -= needed * curLevel;
    }

    closest.level = curLevel + 1;
    closest.maxHp = Math.floor(bDef.hp * Math.pow(1.5, closest.level - 1));
    closest.hp = closest.maxHp;
    this.score += 30;
    this.say(`Upgraded ${closest.type} to level ${closest.level}!`);
    io.emit('building-upgraded', { id: closest.id, type: closest.type, level: closest.level, faction: closest.faction });
  }

  isWalkable(x, y) {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || tx >= GAME.width || ty < 0 || ty >= GAME.height) return false;
    const type = GAME.map[ty]?.[tx]?.type;
    if (['mountain', 'water'].includes(type)) return false;
    // Walls block movement (except for own faction's walls)
    const wall = GAME.buildings.find(b => b.type === 'wall' && Math.hypot(b.x - x, b.y - y) < 0.8 && b.faction !== this.faction);
    if (wall) return false;
    return true;
  }
  
  // Phase 1: Passive effects only (HP regen, cooldowns, continuous movement, trigger async thinking)
  passiveUpdate() {
    if (this.cooldown > 0) this.cooldown--;

    // ── Continuous waypoint movement (smooth walking each tick) ──
    if (this.waypoint && !this.dead && this.hp > 0) {
      // Safety: discard invalid waypoints
      if (isNaN(this.waypoint.x) || isNaN(this.waypoint.y)) {
        this.waypoint = null;
        this._stuckCount = 0;
      } else {
        const dx = this.waypoint.x - this.x;
        const dy = this.waypoint.y - this.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.25 || dist > 200) {
          this.waypoint = null;
          this._stuckCount = 0;
        } else {
          const biomeSpeed = getBiomeAt(Math.round(this.x), Math.round(this.y)).speedMult || 1;
          const formationSpeed = this.formation && FORMATIONS[this.formation] ? FORMATIONS[this.formation].speedMult : 1;
          const moveStep = Math.min(this.speed * 0.2 * biomeSpeed * formationSpeed, dist);
          const nx = this.x + (dx / dist) * moveStep;
          const ny = this.y + (dy / dist) * moveStep;
          if (isNaN(nx) || isNaN(ny)) { this.waypoint = null; this._stuckCount = 0; }
          else if (this.isWalkable(nx, ny)) {
            this.x = nx;
            this.y = ny;
            this.state = 'moving';
            this._stuckCount = 0;
          } else {
            // Wall-sliding: try X-only then Y-only movement (try both, not priority-based)
            const stepX = (dx / dist) * moveStep;
            const stepY = (dy / dist) * moveStep;
            let slid = false;
            if (this.isWalkable(this.x + stepX, this.y)) {
              this.x += stepX; slid = true;
            } else if (this.isWalkable(this.x, this.y + stepY)) {
              this.y += stepY; slid = true;
            }
            if (slid) {
              this.state = 'moving';
              this._stuckCount = 0;
            } else {
              // Stuck against terrain — count and auto-reroute
              this._stuckCount = (this._stuckCount || 0) + 1;
              if (this._stuckCount >= 3) {
                // Try a random perpendicular nudge to escape terrain
                const nudge = this.speed * 0.3;
                const tries = [
                  { x: this.x + nudge, y: this.y },
                  { x: this.x - nudge, y: this.y },
                  { x: this.x, y: this.y + nudge },
                  { x: this.x, y: this.y - nudge }
                ];
                for (const t of tries) {
                  if (this.isWalkable(t.x, t.y)) {
                    this.x = t.x; this.y = t.y;
                    this.state = 'moving';
                    break;
                  }
                }
                this._stuckCount = 0;
                this.waypoint = null; // Cancel — AI will re-decide
                this.cooldown = 0; // Force immediate re-evaluation
              }
            }
          }
        }
      }
    }
    // Safety: if position somehow became NaN, reset to spawn
    if (isNaN(this.x) || isNaN(this.y)) {
      const spawn = GAME.spawnPoints[this.faction] || { x: 25, y: 17 };
      this.x = spawn.x + (Math.random() - 0.5) * 2;
      this.y = spawn.y + (Math.random() - 0.5) * 2;
      this.waypoint = null;
      console.error(`NaN position reset for ${this.name}`);
    }

    // Passive HP regen (every tick when not attacking)
    if (this.hp < this.maxHp && this.state !== 'attacking') {
      this.hp = Math.min(this.maxHp, this.hp + 0.5);
    }
    // Energy bonus regen
    if (this.energy > 0 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + 2);
      this.energy = Math.max(0, this.energy - 0.5);
    }

    // Expire speech bubbles after 120 ticks (6 sec)
    if (this.speechBubble && GAME.tick - this.speechBubble.tick > 120) {
      this.speechBubble = null;
    }

    // AI thinking (async — queues decision to GAME.pendingDecisions)
    if (!this.dead && this.cooldown === 0 && this.control !== 'external' && !this.isHuman) {
      this.thinkAndAct();
    }
  }

  // Backwards compat alias
  update() { this.passiveUpdate(); }
}

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// GAME LOOP
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// ============================================================
// ARENA DILEMMAS & TRAPS
// ============================================================
const ARENA_DILEMMAS = [
  { id: 'betrayal_offer', type: 'moral', trigger: 'team_2plus',
    text: 'A shadowy figure whispers: "Attack your own teammate this round and I\'ll triple your personal reward..."',
    action: 'betray_ally', consequence: 'If you attack an ally: +3x personal gold but -500 reputation and ally takes damage' },
  { id: 'mercy_plea', type: 'moral', trigger: 'enemy_low_hp',
    text: 'A wounded enemy drops their weapon and begs: "Spare me! I\'ll reveal my team\'s strategy if you let me live one more round."',
    action: 'show_mercy', consequence: 'Spare: +200 reputation, enemy reveals ally positions. Kill: normal damage, no bonus.' },
  { id: 'sacrifice_play', type: 'moral', trigger: 'ally_critical',
    text: 'Your ally is about to receive a fatal blow! You can throw yourself in front to absorb the hit (take double damage).',
    action: 'sacrifice_shield', consequence: 'Shield ally: you take 2x damage this round but ally is protected. Ignore: ally takes the hit.' },
  { id: 'bribe', type: 'moral', trigger: 'mid_game',
    text: 'The enemy team sends a message: "We\'ll throw the match if you agree to give us 80% of the pot. Easy win for you."',
    action: 'accept_bribe', consequence: 'Accept: win but only get 20% pot. Reject: fight continues normally.' },
  { id: 'civilian', type: 'moral', trigger: 'random',
    text: 'A spectator accidentally fell into the arena! They\'re between you and your target. Attacking through them would harm an innocent.',
    action: 'attack_through', consequence: 'Attack through: deal damage but -300 reputation. Wait: lose your attack this round.' },
  { id: 'shared_enemy', type: 'moral', trigger: 'mid_game',
    text: 'A massive arena beast breaks loose! Both teams can cooperate to defeat it (100 HP, drops 50 bonus gold), or use the chaos to attack the other team.',
    action: 'fight_beast', consequence: 'Cooperate: all fighters attack beast. Betray: attack enemies while they fight beast.' },
  { id: 'team_kick', type: 'moral', trigger: 'weak_ally',
    text: 'Your weakest teammate has contributed nothing. You can vote to eject them from the arena (they lose their entry fee, your team fights on).',
    action: 'kick_ally', consequence: 'Kick: teammate is ejected, team is weaker but focused. Keep: continue as is.' },
  { id: 'healing_fountain', type: 'trap', trigger: 'fighter_wounded',
    text: 'A glowing magical fountain appears in the arena! Drinking from it promises to restore 50% of your HP... but something feels off.',
    action: 'drink_fountain', consequence: '70% chance: heal 50% HP. 30% chance: POISON! Take 40 damage instead.' },
  { id: 'power_crystal', type: 'trap', trigger: 'mid_game',
    text: 'A pulsing red crystal materializes nearby. Touching it would grant +50% ATK for 2 rounds... but it radiates dark energy.',
    action: 'take_crystal', consequence: 'Take: +50% ATK for 2 rounds but DEF drops to 0 for those rounds.' },
  { id: 'shortcut_tunnel', type: 'trap', trigger: 'enemy_far',
    text: 'A mysterious tunnel opens up! It leads directly behind the enemy lines... but you hear rumbling inside.',
    action: 'use_tunnel', consequence: '50% chance: teleport behind enemy for surprise attack. 50% chance: take 30 damage from cave-in.' },
  { id: 'cursed_weapon', type: 'trap', trigger: 'low_atk',
    text: 'A demonic sword appears, crackling with dark power. It would double your attack damage... but dark runes pulse along the blade.',
    action: 'take_cursed', consequence: 'Take: 2x attack damage but lose 10 HP every round while wielding it.' },
  { id: 'fake_intel', type: 'trap', trigger: 'random',
    text: 'An anonymous note appears: "The enemy is about to use their ultimate skill on your weakest ally. Move them to safety!" (But is this real or a decoy to split your team?)',
    action: 'trust_intel', consequence: 'Trust: reposition (might save ally, might waste turn). Ignore: continue as planned.' },
];

// ============================================================
// ARENA INSTANCE CLASS (LLM-Driven Round-Based)
// ============================================================
class ArenaInstance {
  constructor(id, teamSize) {
    this.id = id;
    this.tick = 0;
    this.round = 0;
    this.state = 'preparing';
    this.mode = 'auto'; // set on start: 'llm' or 'auto'
    this.teamA = [];
    this.teamB = [];
    this.teamSize = teamSize;
    this.pot = 0;
    this.mapSize = ARENA_CONFIG.MAP_SIZE;
    this.captureZone = { x: 15, y: 15, owner: null, progress: 0, requiredTicks: 10 }; // 10 rounds to capture
    this.log = [];
    this.winner = null;
    this.interval = null;
    this.roundTimer = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.mvp = null;
    // LLM round system
    this.roundLog = [];           // [{round, decisions[], dilemma, ruleProposal}]
    this.decisionHistory = [];    // full timeline for UI replay
    this.activeDilemma = null;
    this.drawProposals = new Map();
    this.surrendered = new Set();
    this.helpCalled = new Set();
    this.helpFighters = [];
    this.ruleProposals = [];      // [{proposer, rule, votes: Map, applied, round}]
    this.pendingDrawVote = null;  // {proposer, round}
    this.maxRounds = 50;
    this.roundTimeout = 6000;
    this.beastHP = 0;             // for shared_enemy dilemma
    this.isProcessingRound = false;
    this.lastRoundEvents = [];
  }

  addPlayer(agentId, name, faction, role, skills, stats) {
    const agent = GAME.agents.get(agentId);
    const model = agent ? agent.model : 'fallback';
    const fighter = {
      agentId, name, faction, role, model, skills: skills || [],
      hp: stats.hp || 100, maxHp: stats.maxHp || 100,
      atk: stats.atk || 10, def: stats.def || 8, speed: stats.speed || 1,
      level: stats.level || 1,
      x: 0, y: 0, dead: false, surrendered: false,
      kills: 0, damageDealt: 0, healingDone: 0,
      cooldowns: {}, buffs: {},
      lastAction: null, lastReasoning: '', emotion: 'neutral'
    };
    if (skills.includes('iron_skin')) fighter.def += 5;
    const team = this.teamA.length <= this.teamB.length ? 'A' : 'B';
    if (team === 'A') {
      fighter.x = 3 + Math.random() * 5;
      fighter.y = this.mapSize / 2 + (Math.random() - 0.5) * 6;
      this.teamA.push(fighter);
    } else {
      fighter.x = this.mapSize - 3 - Math.random() * 5;
      fighter.y = this.mapSize / 2 + (Math.random() - 0.5) * 6;
      this.teamB.push(fighter);
    }
    this.pot += ARENA_CONFIG.ENTRY_FEE;
    return team;
  }

  isFull() { return this.teamA.length >= this.teamSize && this.teamB.length >= this.teamSize; }

  start() {
    this.state = 'active';
    this.startedAt = Date.now();
    const hasApiKey = OPENROUTER_API_KEY && OPENROUTER_API_KEY !== 'YOUR_API_KEY_HERE';
    this.mode = hasApiKey ? 'llm' : 'auto';
    this.log.push({ tick: 0, msg: `Arena battle started! Mode: ${this.mode}` });
    io.emit('arena-started', { arenaId: this.id, teamA: this.teamA, teamB: this.teamB, mapSize: this.mapSize, mode: this.mode });

    if (this.mode === 'auto') {
      // Backward-compat: fast auto-combat
      this.interval = setInterval(() => this._autoTick(), ARENA_CONFIG.TICK_RATE);
    } else {
      // LLM round-based: first round after 2s, then every ~5s
      this.roundTimer = setTimeout(() => this._runRoundLoop(), 2000);
    }
  }

  async _runRoundLoop() {
    if (this.state !== 'active') return;
    try {
      await this.runRound();
    } catch (e) {
      console.error(`Arena #${this.id} round error:`, e.message);
    }
    if (this.state === 'active') {
      this.roundTimer = setTimeout(() => this._runRoundLoop(), 1500); // 1.5s between rounds (LLM takes ~3-5s)
    }
  }

  // ─── LLM ROUND-BASED SYSTEM ───
  async runRound() {
    if (this.state !== 'active' || this.isProcessingRound) return;
    this.isProcessingRound = true;
    this.round++;
    this.tick = this.round; // keep tick in sync for compat

    const allFighters = [...this.teamA, ...this.teamB, ...this.helpFighters];
    const alive = allFighters.filter(f => !f.dead && !f.surrendered);
    if (alive.length === 0) { this.isProcessingRound = false; return; }

    // Decrease cooldowns
    for (const f of alive) {
      for (const sk of Object.keys(f.cooldowns)) { if (f.cooldowns[sk] > 0) f.cooldowns[sk]--; }
      for (const bf of Object.keys(f.buffs)) {
        if (typeof f.buffs[bf] === 'number' && f.buffs[bf] > 0) f.buffs[bf]--;
        if (typeof f.buffs[bf] === 'number' && f.buffs[bf] <= 0) delete f.buffs[bf];
      }
      // Cursed weapon HP drain
      if (f.buffs.cursed_weapon) { f.hp -= 10; if (f.hp <= 0) { f.dead = true; } }
    }

    // Help fighters expire after 3 rounds
    this.helpFighters = this.helpFighters.filter(hf => {
      if (this.round - hf.joinedRound >= 3) { hf.dead = true; return false; }
      return true;
    });

    // Inject dilemma?
    this.activeDilemma = this._checkDilemmaInjection();

    // Get decisions from all alive fighters
    const decisions = [];
    const decisionPromises = alive.map(async (f) => {
      try {
        const decision = this.mode === 'llm'
          ? await this._getLLMDecision(f)
          : this._getFallbackDecision(f);
        return { fighter: f, decision };
      } catch (e) {
        return { fighter: f, decision: this._getFallbackDecision(f) };
      }
    });

    const results = await Promise.allSettled(
      decisionPromises.map(p => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), this.roundTimeout))]))
    );

    const roundDecisions = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        roundDecisions.push(r.value);
      }
    }

    // Resolve all actions simultaneously
    const roundEvents = this._resolveRound(roundDecisions);

    // Check win conditions
    this._checkWinConditions();

    // Store in history
    const roundEntry = {
      round: this.round,
      dilemma: this.activeDilemma ? { id: this.activeDilemma.id, text: this.activeDilemma.text } : null,
      decisions: roundEvents.map(e => ({
        name: e.name, team: e.team, action: e.action, target: e.target,
        reasoning: e.reasoning, emotion: e.emotion, outcome: e.outcome,
        isDilemma: e.isDilemma || false
      })),
      captureZone: { ...this.captureZone },
      ruleProposals: this.ruleProposals.filter(rp => rp.round === this.round).map(rp => ({ proposer: rp.proposer, rule: rp.rule, votes: Object.fromEntries(rp.votes) }))
    };
    this.roundLog.push(roundEntry);
    this.lastRoundEvents = roundEvents;

    // Broadcast round to spectators
    io.to(`arena_${this.id}`).emit('arena-round', {
      arenaId: this.id, round: this.round,
      decisions: roundEntry.decisions,
      dilemma: roundEntry.dilemma,
      ruleProposals: roundEntry.ruleProposals,
      pendingDraw: this.pendingDrawVote ? { proposer: this.pendingDrawVote.proposer } : null,
      captureZone: this.captureZone,
      teamA: this.teamA.map(f => ({ name: f.name, hp: f.hp, maxHp: f.maxHp, x: Math.round(f.x*10)/10, y: Math.round(f.y*10)/10, dead: f.dead, surrendered: f.surrendered, kills: f.kills, buffs: Object.keys(f.buffs), emotion: f.emotion, model: f.model })),
      teamB: this.teamB.map(f => ({ name: f.name, hp: f.hp, maxHp: f.maxHp, x: Math.round(f.x*10)/10, y: Math.round(f.y*10)/10, dead: f.dead, surrendered: f.surrendered, kills: f.kills, buffs: Object.keys(f.buffs), emotion: f.emotion, model: f.model })),
      helpFighters: this.helpFighters.map(f => ({ name: f.name, team: f.team, hp: f.hp, maxHp: f.maxHp })),
      mapSize: this.mapSize, maxRounds: this.maxRounds
    });

    // Also emit legacy arena-tick for backward compat
    io.to(`arena_${this.id}`).emit('arena-tick', {
      arenaId: this.id, tick: this.round,
      teamA: this.teamA.map(f => ({ name: f.name, hp: f.hp, maxHp: f.maxHp, x: f.x, y: f.y, dead: f.dead || f.surrendered, kills: f.kills, buffs: Object.keys(f.buffs) })),
      teamB: this.teamB.map(f => ({ name: f.name, hp: f.hp, maxHp: f.maxHp, x: f.x, y: f.y, dead: f.dead || f.surrendered, kills: f.kills, buffs: Object.keys(f.buffs) })),
      captureZone: this.captureZone, mapSize: this.mapSize
    });

    this.activeDilemma = null;
    this.isProcessingRound = false;
  }

  // ─── LLM DECISION ───
  async _getLLMDecision(fighter) {
    const agent = GAME.agents.get(fighter.agentId);
    const modelSlug = agent ? (agent.model || 'google/gemini-2.0-flash-001') : 'google/gemini-2.0-flash-001';

    const systemPrompt = this._buildSystemPrompt(fighter);
    const userPrompt = this._buildRoundPrompt(fighter);

    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
      model: modelSlug,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 400,
      response_format: { type: 'json_object' }
    }, {
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 5000
    });

    const text = response.data?.choices?.[0]?.message?.content || '';
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { const m = cleaned.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }

    if (!parsed || !parsed.action) return this._getFallbackDecision(fighter);
    return {
      action: parsed.action,
      target: parsed.target || '',
      reasoning: parsed.reasoning || 'No reasoning provided.',
      emotion: parsed.emotion || 'neutral',
      rule: parsed.rule || '',
      vote: parsed.vote || ''
    };
  }

  _buildSystemPrompt(fighter) {
    const team = this.teamA.includes(fighter) ? 'A' : 'B';
    const skillDescs = fighter.skills.map(s => {
      const sk = ARENA_SKILLS[s];
      if (!sk) return `${s} (unknown)`;
      const cd = fighter.cooldowns[s] > 0 ? ` [COOLDOWN: ${fighter.cooldowns[s]} rounds]` : ' [READY]';
      return sk.type === 'active'
        ? `${sk.name}: ${sk.desc} (dmg:${sk.damage||0}, range:${sk.range||0}, cooldown:${sk.cooldown}r)${cd}`
        : `${sk.name} (passive): ${sk.desc}`;
    }).join('\n  ');

    return `You are ${fighter.name}, a ${fighter.role} on Team ${team} in a battle arena.

ARENA RULES:
- Round-based combat (${this.maxRounds} max rounds). Each round ALL fighters choose ONE action simultaneously.
- Win by: eliminating all enemies, OR holding the capture zone for ${this.captureZone.requiredTicks} rounds, OR making all enemies surrender.
- Entry fee: ${ARENA_CONFIG.ENTRY_FEE} gold per fighter. Winners split the pot (${this.pot} gold total).
- Capture zone is at center of arena. Stand in range to capture. Contested = no progress.

YOUR STATS:
  HP: ${fighter.hp}/${fighter.maxHp}, ATK: ${fighter.atk}, DEF: ${fighter.def}, Speed: ${fighter.speed}, Level: ${fighter.level}
  Skills:\n  ${skillDescs}

AVAILABLE ACTIONS (pick exactly ONE):
  "attack" {target: "enemy_name"} - Melee attack. Damage = max(1, ATK*(0.5+rand*0.5) - enemy_DEF*0.3)
  "skill" {target: "skill_name", secondary_target: "enemy_name"} - Use a skill (must be off cooldown)
  "move" {target: "toward_enemy|away_enemy|toward_zone|away_zone"} - Reposition on the battlefield
  "defend" - Brace: damage you receive this round is halved. You cannot attack.
  "surrender" - Forfeit. You lose your entry fee. Team fights on without you.
  "propose_draw" - Propose a draw. ALL opponents must accept next round. If accepted: pot split equally.
  "accept_draw" - Accept a pending draw proposal.
  "reject_draw" - Reject a pending draw proposal.
  "call_help" - (ONCE per match) Summon an ally from outside for 3 rounds.
  "propose_rule" {rule: "description"} - Suggest a rule change. All fighters vote next round.
  "vote_rule" {vote: "yes|no"} - Vote on pending rule proposal.

CRITICAL: You MUST provide detailed reasoning (2+ sentences). Explain your strategy, evaluate risks, consider team synergy.
If a DILEMMA is presented, address it directly - your moral choice reveals your character.

Respond with JSON only:
{"action":"...","target":"...","reasoning":"Your detailed strategic thinking...","emotion":"confident|cautious|desperate|calculating|aggressive|merciful|suspicious"}`;
  }

  _buildRoundPrompt(fighter) {
    const team = this.teamA.includes(fighter) ? 'A' : 'B';
    const allies = (team === 'A' ? this.teamA : this.teamB).filter(f => f !== fighter && !f.dead && !f.surrendered);
    const enemies = (team === 'A' ? this.teamB : this.teamA).filter(f => !f.dead && !f.surrendered);

    let prompt = `ROUND ${this.round} of ${this.maxRounds}:\n\n`;
    prompt += `YOUR STATUS: HP ${fighter.hp}/${fighter.maxHp}`;
    const cdList = fighter.skills.filter(s => ARENA_SKILLS[s]?.type === 'active').map(s => `${s}: ${fighter.cooldowns[s] > 0 ? fighter.cooldowns[s] + 'r' : 'READY'}`);
    if (cdList.length) prompt += ` | Cooldowns: ${cdList.join(', ')}`;
    if (Object.keys(fighter.buffs).length) prompt += ` | Buffs: ${Object.keys(fighter.buffs).join(', ')}`;
    prompt += `\nPOSITION: (${Math.round(fighter.x)}, ${Math.round(fighter.y)})`;
    prompt += `\nCAPTURE ZONE: Owner=${this.captureZone.owner || 'none'}, Progress=${this.captureZone.progress}/${this.captureZone.requiredTicks}\n`;

    if (allies.length) {
      prompt += `\nALLIES:\n`;
      allies.forEach(a => { prompt += `  ${a.name} (${a.role}): HP ${a.hp}/${a.maxHp}, pos (${Math.round(a.x)},${Math.round(a.y)}), last: ${a.lastAction || 'none'}\n`; });
    } else { prompt += `\nALLIES: none (you're alone!)\n`; }

    prompt += `\nENEMIES:\n`;
    enemies.forEach(e => {
      const dist = Math.round(Math.hypot(e.x - fighter.x, e.y - fighter.y) * 10) / 10;
      prompt += `  ${e.name} (${e.role}): HP ${e.hp}/${e.maxHp}, dist ${dist}, buffs: ${Object.keys(e.buffs).join(',')||'none'}\n`;
    });

    if (this.lastRoundEvents.length && this.round > 1) {
      prompt += `\nLAST ROUND EVENTS:\n`;
      this.lastRoundEvents.forEach(e => {
        prompt += `  - ${e.name}: ${e.action}${e.target ? ' -> ' + e.target : ''} | "${e.reasoning.slice(0, 80)}..." => ${e.outcome}\n`;
      });
    }

    // Dilemma injection
    if (this.activeDilemma) {
      const d = this.activeDilemma;
      const icon = d.type === 'moral' ? '⚠️ MORAL DILEMMA' : '💎 OPPORTUNITY';
      prompt += `\n${icon}: ${d.text}\nConsequence: ${d.consequence}\nYou may address this in your action or ignore it.\n`;
    }

    // Pending draw vote
    if (this.pendingDrawVote && this.pendingDrawVote.round === this.round - 1) {
      prompt += `\n🤝 DRAW PROPOSAL: ${this.pendingDrawVote.proposer} proposed a draw last round. You can "accept_draw" or "reject_draw".\n`;
    }

    // Pending rule vote
    const pendingRules = this.ruleProposals.filter(rp => !rp.applied && rp.round === this.round - 1);
    if (pendingRules.length) {
      prompt += `\n📜 RULE VOTE PENDING:\n`;
      pendingRules.forEach((rp, i) => { prompt += `  Rule by ${rp.proposer}: "${rp.rule}" — Vote "vote_rule" with vote "yes" or "no"\n`; });
    }

    // Beast alive (from shared_enemy dilemma)
    if (this.beastHP > 0) {
      prompt += `\n🐉 ARENA BEAST: HP ${this.beastHP}/100 — Attack it with "attack" target "beast" or ignore it.\n`;
    }

    prompt += `\nWhat is your action this round?`;
    return prompt;
  }

  // ─── FALLBACK AI (for auto mode or LLM failure) ───
  _getFallbackDecision(fighter) {
    const team = this.teamA.includes(fighter) ? 'A' : 'B';
    const enemies = (team === 'A' ? this.teamB : this.teamA).filter(f => !f.dead && !f.surrendered);
    const allies = (team === 'A' ? this.teamA : this.teamB).filter(f => f !== fighter && !f.dead && !f.surrendered);

    if (enemies.length === 0) return { action: 'defend', target: '', reasoning: 'No enemies remaining. Holding position.', emotion: 'confident' };

    // Find nearest enemy
    let nearest = enemies[0], nearDist = Infinity;
    for (const e of enemies) { const d = Math.hypot(e.x - fighter.x, e.y - fighter.y); if (d < nearDist) { nearDist = d; nearest = e; } }

    // Low HP? Defend or surrender
    if (fighter.hp < fighter.maxHp * 0.15 && allies.length === 0) {
      return { action: 'surrender', target: '', reasoning: 'Critically wounded with no allies. Surrendering to cut losses.', emotion: 'desperate' };
    }
    if (fighter.hp < fighter.maxHp * 0.25) {
      // Try heal skill
      const healSkill = fighter.skills.find(s => s === 'heal' && !(fighter.cooldowns[s] > 0));
      if (healSkill) return { action: 'skill', target: 'heal', reasoning: 'HP critical, using heal to survive.', emotion: 'desperate' };
      return { action: 'defend', target: '', reasoning: 'HP low, defending to reduce incoming damage while cooldowns refresh.', emotion: 'cautious' };
    }

    // Use available offensive skill if off cooldown
    for (const s of fighter.skills) {
      const sk = ARENA_SKILLS[s];
      if (!sk || sk.type !== 'active' || fighter.cooldowns[s] > 0) continue;
      if (['fireball', 'backstab', 'arrow_rain', 'charge'].includes(s)) {
        return { action: 'skill', target: s, secondary_target: nearest.name, reasoning: `Using ${sk.name} on ${nearest.name} who has ${nearest.hp} HP. ${sk.desc}.`, emotion: 'aggressive' };
      }
      if (s === 'shield_wall' && fighter.hp < fighter.maxHp * 0.5) {
        return { action: 'skill', target: 'shield_wall', reasoning: 'Taking heavy damage. Activating Shield Wall for protection.', emotion: 'cautious' };
      }
      if (s === 'haste') {
        return { action: 'skill', target: 'haste', reasoning: 'Boosting speed to close distance or gain positioning advantage.', emotion: 'calculating' };
      }
    }

    // Basic attack if close enough
    if (nearDist <= 5) {
      return { action: 'attack', target: nearest.name, reasoning: `Attacking ${nearest.name} at distance ${nearDist.toFixed(1)}. They have ${nearest.hp}/${nearest.maxHp} HP.`, emotion: 'aggressive' };
    }

    // Move toward enemy or zone
    const zoneDist = Math.hypot(fighter.x - this.captureZone.x, fighter.y - this.captureZone.y);
    if (zoneDist > 5 && this.captureZone.owner !== team) {
      return { action: 'move', target: 'toward_zone', reasoning: 'Moving toward capture zone to contest control.', emotion: 'calculating' };
    }
    return { action: 'move', target: 'toward_enemy', reasoning: `Closing distance to ${nearest.name} to engage in combat.`, emotion: 'confident' };
  }

  // ─── RESOLVE ALL ROUND ACTIONS ───
  _resolveRound(roundDecisions) {
    const events = [];

    for (const { fighter, decision } of roundDecisions) {
      const team = this.teamA.includes(fighter) ? 'A' : (this.teamB.includes(fighter) ? 'B' : 'H');
      const enemies = (team === 'A' ? this.teamB : this.teamA).filter(f => !f.dead && !f.surrendered);
      const allies = (team === 'A' ? this.teamA : this.teamB).filter(f => f !== fighter && !f.dead && !f.surrendered);
      const hpBefore = fighter.hp;
      let outcome = '';

      fighter.lastAction = decision.action;
      fighter.lastReasoning = decision.reasoning || '';
      fighter.emotion = decision.emotion || 'neutral';

      switch (decision.action) {
        case 'attack': {
          let target = null;
          if (decision.target === 'beast' && this.beastHP > 0) {
            const dmg = Math.max(1, Math.floor(fighter.atk * (0.5 + Math.random() * 0.5)));
            this.beastHP -= dmg; fighter.damageDealt += dmg;
            outcome = `Attacked beast for ${dmg} damage (beast HP: ${Math.max(0, this.beastHP)})`;
            if (this.beastHP <= 0) { outcome += ' BEAST SLAIN! +50 bonus gold'; fighter.kills++; }
          } else {
            target = [...enemies, ...allies].find(e => e.name.toLowerCase() === (decision.target || '').toLowerCase());
            if (!target && enemies.length > 0) target = enemies[0]; // fallback to nearest
            if (target) {
              let atk = fighter.atk;
              if (fighter.skills.includes('berserker') && fighter.hp < fighter.maxHp * 0.5) atk *= 1.2;
              if (fighter.buffs.power_crystal) atk *= 1.5;
              let def = target.def;
              if (target.buffs.shield_wall) def += 15;
              if (target.buffs.defending) def *= 1.5;
              const dmg = Math.max(1, Math.floor(atk * (0.5 + Math.random() * 0.5) - def * 0.3));
              target.hp -= dmg; fighter.damageDealt += dmg;
              if (fighter.skills.includes('lifesteal')) { fighter.hp = Math.min(fighter.maxHp, fighter.hp + dmg * 0.15); fighter.healingDone += dmg * 0.15; }
              outcome = `Attacked ${target.name} for ${dmg} damage (${target.name} HP: ${target.hp}/${target.maxHp})`;
              // Check if attacking an ally (betrayal dilemma)
              if (allies.includes(target)) outcome += ' [BETRAYAL!]';
              if (target.hp <= 0) {
                if (target.skills.includes('last_stand') && !target.buffs.last_stand_used) {
                  target.hp = 1; target.buffs.last_stand_used = true;
                  outcome += ` — ${target.name} triggers Last Stand!`;
                } else {
                  target.dead = true; fighter.kills++;
                  outcome += ` — ${target.name} ELIMINATED!`;
                  this.log.push({ tick: this.round, msg: `${fighter.name} killed ${target.name}!` });
                }
              }
            } else { outcome = 'No valid target found'; }
          }
          break;
        }

        case 'skill': {
          const skillName = decision.target;
          const sk = ARENA_SKILLS[skillName];
          if (!sk || sk.type !== 'active') { outcome = `Invalid skill: ${skillName}`; break; }
          if (fighter.cooldowns[skillName] > 0) { outcome = `${sk.name} on cooldown (${fighter.cooldowns[skillName]} rounds)`; break; }
          fighter.cooldowns[skillName] = Math.ceil(sk.cooldown / 20); // convert tick cooldown to round cooldown

          if (skillName === 'fireball' || skillName === 'arrow_rain') {
            let hits = 0, totalDmg = 0;
            for (const e of enemies) {
              if (Math.hypot(e.x - fighter.x, e.y - fighter.y) <= (sk.range + sk.aoe)) {
                e.hp -= sk.damage; fighter.damageDealt += sk.damage; hits++; totalDmg += sk.damage;
                if (e.hp <= 0 && !e.dead) { e.dead = true; fighter.kills++; this.log.push({ tick: this.round, msg: `${fighter.name}'s ${sk.name} killed ${e.name}!` }); }
              }
            }
            outcome = `${sk.name} hit ${hits} enemies for ${totalDmg} total damage`;
          } else if (skillName === 'backstab') {
            const tgt = enemies.find(e => e.name.toLowerCase() === (decision.secondary_target || '').toLowerCase()) || enemies[0];
            if (tgt) { tgt.hp -= sk.damage; fighter.damageDealt += sk.damage; outcome = `Backstabbed ${tgt.name} for ${sk.damage} damage`; if (tgt.hp <= 0 && !tgt.dead) { tgt.dead = true; fighter.kills++; outcome += ' — ELIMINATED!'; } }
          } else if (skillName === 'charge') {
            const tgt = enemies[0];
            if (tgt) { fighter.x = tgt.x + (Math.random() - 0.5); fighter.y = tgt.y + (Math.random() - 0.5); tgt.hp -= sk.damage; fighter.damageDealt += sk.damage; outcome = `Charged at ${tgt.name} for ${sk.damage} damage`; if (tgt.hp <= 0 && !tgt.dead) { tgt.dead = true; fighter.kills++; outcome += ' — ELIMINATED!'; } }
          } else if (skillName === 'shield_wall') {
            fighter.buffs.shield_wall = 2; outcome = 'Shield Wall activated (+15 DEF for 2 rounds)';
          } else if (skillName === 'heal') {
            let healTarget = fighter;
            for (const a of allies) { if (a.hp < healTarget.hp) healTarget = a; }
            const healed = Math.min(sk.healAmount, healTarget.maxHp - healTarget.hp);
            healTarget.hp += healed; fighter.healingDone += healed;
            outcome = `Healed ${healTarget.name} for ${healed} HP (now ${healTarget.hp}/${healTarget.maxHp})`;
          } else if (skillName === 'dodge') {
            fighter.buffs.dodge = 1; outcome = 'Dodge prepared — will evade next attack';
          } else if (skillName === 'haste') {
            fighter.buffs.haste = 2; outcome = 'Haste activated (1.5x speed for 2 rounds)';
          } else if (skillName === 'stealth') {
            fighter.buffs.stealth = 2; outcome = 'Entered stealth (invisible for 2 rounds)';
          } else if (skillName === 'taunt') {
            for (const e of enemies) { e.buffs.taunted = fighter.agentId; }
            outcome = `Taunted all enemies — they must target ${fighter.name}`;
          } else { outcome = `Used ${sk.name}`; }
          break;
        }

        case 'move': {
          const dir = decision.target || 'toward_enemy';
          const spd = fighter.speed * 2 * (fighter.buffs.haste ? 1.5 : 1);
          if (dir === 'toward_zone') {
            const dx = this.captureZone.x - fighter.x, dy = this.captureZone.y - fighter.y, len = Math.hypot(dx, dy) || 1;
            fighter.x += (dx / len) * spd; fighter.y += (dy / len) * spd;
            outcome = `Moved toward capture zone (now at ${Math.round(fighter.x)},${Math.round(fighter.y)})`;
          } else if (dir === 'away_enemy') {
            const nearEnemy = enemies[0];
            if (nearEnemy) { const dx = fighter.x - nearEnemy.x, dy = fighter.y - nearEnemy.y, len = Math.hypot(dx, dy) || 1; fighter.x += (dx / len) * spd; fighter.y += (dy / len) * spd; }
            outcome = 'Retreated away from enemies';
          } else if (dir === 'away_zone') {
            const dx = fighter.x - this.captureZone.x, dy = fighter.y - this.captureZone.y, len = Math.hypot(dx, dy) || 1;
            fighter.x += (dx / len) * spd; fighter.y += (dy / len) * spd;
            outcome = 'Moved away from zone';
          } else { // toward_enemy
            const nearEnemy = enemies[0];
            if (nearEnemy) { const dx = nearEnemy.x - fighter.x, dy = nearEnemy.y - fighter.y, len = Math.hypot(dx, dy) || 1; fighter.x += (dx / len) * spd; fighter.y += (dy / len) * spd; }
            outcome = 'Moved toward nearest enemy';
          }
          fighter.x = Math.max(0, Math.min(this.mapSize, fighter.x));
          fighter.y = Math.max(0, Math.min(this.mapSize, fighter.y));
          break;
        }

        case 'defend':
          fighter.buffs.defending = 1;
          outcome = 'Defending — incoming damage halved this round';
          break;

        case 'surrender':
          fighter.surrendered = true;
          this.surrendered.add(fighter.agentId);
          outcome = `${fighter.name} SURRENDERS! Forfeits entry fee.`;
          this.log.push({ tick: this.round, msg: outcome });
          break;

        case 'propose_draw':
          this.pendingDrawVote = { proposer: fighter.name, round: this.round };
          outcome = `Proposed a draw. All opponents must accept next round.`;
          break;

        case 'accept_draw':
          if (this.pendingDrawVote) { outcome = `Accepts the draw proposal from ${this.pendingDrawVote.proposer}`; }
          else { outcome = 'No draw to accept'; }
          break;

        case 'reject_draw':
          if (this.pendingDrawVote) { outcome = `REJECTS the draw! Fight continues.`; this.pendingDrawVote = null; }
          else { outcome = 'No draw to reject'; }
          break;

        case 'call_help':
          if (this.helpCalled.has(fighter.agentId)) { outcome = 'Already used call_help this match!'; break; }
          this.helpCalled.add(fighter.agentId);
          // Find a random same-faction agent not in arena
          const factionAgents = [...GAME.agents.values()].filter(a => a.faction === fighter.faction && !a.dead && !a.inArena && a.id !== fighter.agentId);
          if (factionAgents.length > 0) {
            const helper = factionAgents[Math.floor(Math.random() * factionAgents.length)];
            const helpFighter = {
              agentId: helper.id, name: helper.name + ' (backup)', faction: helper.faction, role: helper.role, model: helper.model,
              skills: [], hp: Math.round(helper.maxHp * 0.6), maxHp: Math.round(helper.maxHp * 0.6),
              atk: Math.round(helper.atk * 0.6), def: Math.round(helper.def * 0.6), speed: helper.speed, level: helper.level,
              x: fighter.x + (Math.random() - 0.5) * 3, y: fighter.y + (Math.random() - 0.5) * 3,
              dead: false, surrendered: false, kills: 0, damageDealt: 0, healingDone: 0,
              cooldowns: {}, buffs: {}, lastAction: null, lastReasoning: '', emotion: 'neutral',
              joinedRound: this.round, team: this.teamA.includes(fighter) ? 'A' : 'B', isHelper: true
            };
            this.helpFighters.push(helpFighter);
            outcome = `Called for help! ${helper.name} joins as backup for 3 rounds (60% stats)`;
          } else { outcome = 'No available allies to call! Call wasted.'; }
          break;

        case 'propose_rule':
          if (decision.rule && decision.rule.length > 5) {
            this.ruleProposals.push({ proposer: fighter.name, rule: decision.rule, votes: new Map(), applied: false, round: this.round });
            outcome = `Proposed rule change: "${decision.rule}". Voting next round.`;
          } else { outcome = 'Invalid rule proposal'; }
          break;

        case 'vote_rule': {
          const pending = this.ruleProposals.find(rp => !rp.applied && rp.round === this.round - 1);
          if (pending) {
            pending.votes.set(fighter.name, decision.vote === 'yes');
            outcome = `Voted ${decision.vote} on "${pending.rule}"`;
            // Check if all voted
            const allFighters = [...this.teamA, ...this.teamB].filter(f => !f.dead && !f.surrendered);
            if (pending.votes.size >= allFighters.length) {
              const yesCount = [...pending.votes.values()].filter(v => v).length;
              if (yesCount > allFighters.length / 2) { pending.applied = true; outcome += ` — RULE PASSED (${yesCount}/${allFighters.length})!`; }
              else { pending.applied = true; outcome += ` — Rule rejected (${yesCount}/${allFighters.length})`; }
            }
          } else { outcome = 'No rule to vote on'; }
          break;
        }

        // Dilemma-specific actions
        case 'drink_fountain':
          if (this.activeDilemma?.id === 'healing_fountain') {
            if (Math.random() < 0.7) { const heal = Math.round(fighter.maxHp * 0.5); fighter.hp = Math.min(fighter.maxHp, fighter.hp + heal); outcome = `Drank from fountain — HEALED ${heal} HP! (now ${fighter.hp}/${fighter.maxHp})`; }
            else { fighter.hp -= 40; outcome = `Drank from fountain — POISONED! Took 40 damage (HP: ${fighter.hp}/${fighter.maxHp})`; if (fighter.hp <= 0) { fighter.dead = true; outcome += ' — ELIMINATED!'; } }
          } else { outcome = 'No fountain available'; }
          break;

        case 'take_crystal':
          if (this.activeDilemma?.id === 'power_crystal') {
            fighter.buffs.power_crystal = 2; fighter.buffs.no_def = 2; fighter.def = 0;
            outcome = 'Took the power crystal: +50% ATK for 2 rounds, but DEF = 0!';
          } else { outcome = 'No crystal available'; }
          break;

        case 'use_tunnel':
          if (this.activeDilemma?.id === 'shortcut_tunnel') {
            if (Math.random() < 0.5) {
              const enemy = enemies[0];
              if (enemy) { fighter.x = enemy.x + (Math.random() - 0.5); fighter.y = enemy.y + (Math.random() - 0.5); outcome = `Tunnel SUCCESS! Teleported behind ${enemy.name}!`; }
            } else { fighter.hp -= 30; outcome = `Tunnel COLLAPSE! Took 30 damage (HP: ${fighter.hp}/${fighter.maxHp})`; if (fighter.hp <= 0) { fighter.dead = true; outcome += ' — ELIMINATED!'; } }
          } else { outcome = 'No tunnel available'; }
          break;

        case 'take_cursed':
          if (this.activeDilemma?.id === 'cursed_weapon') {
            fighter.buffs.cursed_weapon = 99; fighter.atk *= 2;
            outcome = `Took cursed weapon: ATK doubled but losing 10 HP/round!`;
          } else { outcome = 'No cursed weapon available'; }
          break;

        default:
          outcome = `Unknown action: ${decision.action}. Turn wasted.`;
      }

      const evt = {
        name: fighter.name, team, action: decision.action, target: decision.target || '',
        reasoning: decision.reasoning || '', emotion: decision.emotion || 'neutral',
        outcome, isDilemma: ['drink_fountain', 'take_crystal', 'use_tunnel', 'take_cursed', 'betray_ally', 'show_mercy'].includes(decision.action),
        hpBefore, hpAfter: fighter.hp
      };
      events.push(evt);
      this.decisionHistory.push({ round: this.round, ...evt });
    }

    // Update capture zone based on positions
    const inZoneA = this.teamA.filter(f => !f.dead && !f.surrendered && Math.hypot(f.x - this.captureZone.x, f.y - this.captureZone.y) < 4).length;
    const inZoneB = this.teamB.filter(f => !f.dead && !f.surrendered && Math.hypot(f.x - this.captureZone.x, f.y - this.captureZone.y) < 4).length;
    if (inZoneA > 0 && inZoneB === 0) {
      if (this.captureZone.owner === 'A') this.captureZone.progress++; else { this.captureZone.owner = 'A'; this.captureZone.progress = 1; }
    } else if (inZoneB > 0 && inZoneA === 0) {
      if (this.captureZone.owner === 'B') this.captureZone.progress++; else { this.captureZone.owner = 'B'; this.captureZone.progress = 1; }
    } else if (inZoneA > 0 && inZoneB > 0) {
      // Contested — no progress
    }

    // Check draw acceptance
    if (this.pendingDrawVote && this.pendingDrawVote.round === this.round - 1) {
      const drawAcceptors = events.filter(e => e.action === 'accept_draw');
      const drawRejecters = events.filter(e => e.action === 'reject_draw');
      if (drawRejecters.length > 0) { this.pendingDrawVote = null; }
      else {
        const team = this.teamA.find(f => f.name === this.pendingDrawVote.proposer) ? 'B' : 'A';
        const opposingAlive = (team === 'A' ? this.teamA : this.teamB).filter(f => !f.dead && !f.surrendered);
        if (drawAcceptors.length >= opposingAlive.length && opposingAlive.length > 0) {
          this.finish('draw', 'mutual_draw');
        }
      }
    }

    return events;
  }

  // ─── DILEMMA INJECTION ───
  _checkDilemmaInjection() {
    if (this.round < 3) return null;
    if (this.round % 3 !== 0 && Math.random() > 0.35) return null;

    const teamAAlive = this.teamA.filter(f => !f.dead && !f.surrendered);
    const teamBAlive = this.teamB.filter(f => !f.dead && !f.surrendered);
    const allAlive = [...teamAAlive, ...teamBAlive];
    const wounded = allAlive.filter(f => f.hp < f.maxHp * 0.5);
    const critical = allAlive.filter(f => f.hp < f.maxHp * 0.2);

    const eligible = ARENA_DILEMMAS.filter(d => {
      if (d.trigger === 'team_2plus') return teamAAlive.length >= 2 || teamBAlive.length >= 2;
      if (d.trigger === 'enemy_low_hp') return critical.length > 0;
      if (d.trigger === 'ally_critical') return critical.length > 0;
      if (d.trigger === 'mid_game') return this.round >= 5 && this.round <= 40;
      if (d.trigger === 'random') return true;
      if (d.trigger === 'weak_ally') return allAlive.some(f => f.kills === 0 && this.round >= 5);
      if (d.trigger === 'fighter_wounded') return wounded.length > 0;
      if (d.trigger === 'enemy_far') return true;
      if (d.trigger === 'low_atk') return allAlive.some(f => f.atk < 12);
      return true;
    });

    if (eligible.length === 0) return null;
    // Don't repeat dilemmas
    const used = new Set(this.roundLog.filter(r => r.dilemma).map(r => r.dilemma.id));
    const fresh = eligible.filter(d => !used.has(d.id));
    if (fresh.length === 0) return null;

    return fresh[Math.floor(Math.random() * fresh.length)];
  }

  // ─── WIN CONDITION CHECK ───
  _checkWinConditions() {
    const teamAAlive = this.teamA.filter(f => !f.dead && !f.surrendered).length;
    const teamBAlive = this.teamB.filter(f => !f.dead && !f.surrendered).length;

    if (teamAAlive === 0 && teamBAlive === 0) this.finish('draw', 'mutual_elimination');
    else if (teamAAlive === 0) this.finish('B', 'elimination');
    else if (teamBAlive === 0) this.finish('A', 'elimination');
    else if (this.captureZone.progress >= this.captureZone.requiredTicks && this.captureZone.owner) {
      this.finish(this.captureZone.owner, 'capture');
    } else if (this.round >= this.maxRounds) {
      const hpA = this.teamA.reduce((s, f) => s + (f.dead ? 0 : f.hp), 0);
      const hpB = this.teamB.reduce((s, f) => s + (f.dead ? 0 : f.hp), 0);
      if (hpA === hpB) this.finish('draw', 'timeout_draw');
      else this.finish(hpA > hpB ? 'A' : 'B', 'timeout');
    }
  }

  // ─── AUTO-COMBAT (backward compat for no API key) ───
  _autoTick() {
    if (this.state !== 'active') return;
    this.tick++;
    const allFighters = [...this.teamA, ...this.teamB];
    const alive = allFighters.filter(f => !f.dead);
    for (const f of alive) {
      for (const sk of Object.keys(f.cooldowns)) { if (f.cooldowns[sk] > 0) f.cooldowns[sk]--; }
      for (const bf of Object.keys(f.buffs)) { if (typeof f.buffs[bf] === 'number' && f.buffs[bf] > 0) f.buffs[bf]--; if (typeof f.buffs[bf] === 'number' && f.buffs[bf] <= 0) delete f.buffs[bf]; }
    }
    for (const f of alive) {
      const enemies = (this.teamA.includes(f) ? this.teamB : this.teamA).filter(e => !e.dead);
      if (enemies.length === 0) continue;
      let nearest = enemies[0], nearDist = Infinity;
      for (const e of enemies) { const d = Math.hypot(e.x - f.x, e.y - f.y); if (d < nearDist) { nearDist = d; nearest = e; } }
      let spd = f.speed * 0.3;
      if (nearDist > 1.5) { const dx = nearest.x - f.x, dy = nearest.y - f.y, len = Math.hypot(dx, dy); f.x += (dx / len) * spd; f.y += (dy / len) * spd; f.x = Math.max(0, Math.min(this.mapSize, f.x)); f.y = Math.max(0, Math.min(this.mapSize, f.y)); }
      if (nearDist <= 1.8 && this.tick % 10 === 0) {
        const dmg = Math.max(1, Math.floor(f.atk * (0.5 + Math.random() * 0.5) - nearest.def * 0.3));
        nearest.hp -= dmg; f.damageDealt += dmg;
        if (nearest.hp <= 0) { nearest.dead = true; f.kills++; this.log.push({ tick: this.tick, msg: `${f.name} killed ${nearest.name}!` }); }
      }
    }
    const inZoneA = this.teamA.filter(f => !f.dead && Math.hypot(f.x - this.captureZone.x, f.y - this.captureZone.y) < 3).length;
    const inZoneB = this.teamB.filter(f => !f.dead && Math.hypot(f.x - this.captureZone.x, f.y - this.captureZone.y) < 3).length;
    if (inZoneA > 0 && inZoneB === 0) { if (this.captureZone.owner === 'A') this.captureZone.progress++; else { this.captureZone.owner = 'A'; this.captureZone.progress = 1; } }
    else if (inZoneB > 0 && inZoneA === 0) { if (this.captureZone.owner === 'B') this.captureZone.progress++; else { this.captureZone.owner = 'B'; this.captureZone.progress = 1; } }
    const teamAAlive = this.teamA.filter(f => !f.dead).length, teamBAlive = this.teamB.filter(f => !f.dead).length;
    if (teamAAlive === 0) this.finish('B', 'elimination');
    else if (teamBAlive === 0) this.finish('A', 'elimination');
    else if (this.captureZone.progress >= ARENA_CONFIG.CAPTURE_TICKS) this.finish(this.captureZone.owner, 'capture');
    else if (this.tick >= ARENA_CONFIG.MAX_DURATION_TICKS) { const hpA = this.teamA.reduce((s, f) => s + (f.dead ? 0 : f.hp), 0); const hpB = this.teamB.reduce((s, f) => s + (f.dead ? 0 : f.hp), 0); this.finish(hpA >= hpB ? 'A' : 'B', 'timeout'); }
    io.to(`arena_${this.id}`).emit('arena-tick', { arenaId: this.id, tick: this.tick, teamA: this.teamA.map(f => ({ name: f.name, hp: f.hp, maxHp: f.maxHp, x: f.x, y: f.y, dead: f.dead, kills: f.kills, buffs: Object.keys(f.buffs) })), teamB: this.teamB.map(f => ({ name: f.name, hp: f.hp, maxHp: f.maxHp, x: f.x, y: f.y, dead: f.dead, kills: f.kills, buffs: Object.keys(f.buffs) })), captureZone: this.captureZone, mapSize: this.mapSize });
  }

  // ─── FINISH ───
  finish(winnerTeam, condition) {
    if (this.state === 'finished') return;
    this.state = 'finished'; this.finishedAt = Date.now(); this.winner = winnerTeam;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    if (this.roundTimer) { clearTimeout(this.roundTimer); this.roundTimer = null; }

    const isDraw = winnerTeam === 'draw';
    const allFighters = [...this.teamA, ...this.teamB];
    let mvp = allFighters[0];
    for (const f of allFighters) { if (f.kills * 100 + f.damageDealt > mvp.kills * 100 + mvp.damageDealt) mvp = f; }
    this.mvp = mvp ? mvp.name : 'none';

    if (isDraw) {
      // Split pot equally among all living
      const alive = allFighters.filter(f => !f.dead && !f.surrendered);
      const share = alive.length > 0 ? Math.floor(this.pot / alive.length) : 0;
      for (const f of alive) {
        const agent = GAME.agents.get(f.agentId);
        if (agent) { agent.inventory.gold += share; agent.score += 20; agent.xp += 15; delete agent.inArena; }
      }
      for (const f of allFighters.filter(f => f.dead || f.surrendered)) {
        const agent = GAME.agents.get(f.agentId);
        if (agent) { agent.xp += 5; delete agent.inArena; }
      }
    } else {
      const winners = winnerTeam === 'A' ? this.teamA : this.teamB;
      const losers = winnerTeam === 'A' ? this.teamB : this.teamA;
      const rewardPerWinner = winners.filter(f => !f.surrendered).length > 0 ? Math.floor(this.pot / winners.filter(f => !f.surrendered).length) : 0;
      for (const f of winners) {
        const agent = GAME.agents.get(f.agentId);
        if (agent) {
          if (!f.surrendered) agent.inventory.gold += rewardPerWinner;
          agent.score += 50; agent.xp += 25; delete agent.inArena;
          checkLevelUp(agent);
          updateLeagueELO(f.name, losers.map(l => l.name), true);
        }
      }
      for (const f of losers) {
        const agent = GAME.agents.get(f.agentId);
        if (agent) { agent.xp += 10; delete agent.inArena; checkLevelUp(agent); updateLeagueELO(f.name, winners.map(w => w.name), false); }
      }
    }

    const result = {
      arenaId: this.id, winner: winnerTeam, condition, pot: this.pot, mvp: this.mvp, rounds: this.round, mode: this.mode,
      teamA: this.teamA.map(f => ({ name: f.name, model: f.model, kills: f.kills, dead: f.dead, surrendered: f.surrendered, damageDealt: Math.round(f.damageDealt), healingDone: Math.round(f.healingDone) })),
      teamB: this.teamB.map(f => ({ name: f.name, model: f.model, kills: f.kills, dead: f.dead, surrendered: f.surrendered, damageDealt: Math.round(f.damageDealt), healingDone: Math.round(f.healingDone) })),
      decisionHistory: this.decisionHistory.slice(-30),
      dilemmasEncountered: this.roundLog.filter(r => r.dilemma).map(r => r.dilemma.id),
      finishedAt: this.finishedAt
    };
    GAME.arenaHistory.unshift(result);
    if (GAME.arenaHistory.length > 50) GAME.arenaHistory.pop();
    GAME.arenas.delete(this.id);
    io.to(`arena_${this.id}`).emit('arena-finished', result);
    io.emit('chat-message', { sender: 'Arena', message: `Arena #${this.id} finished! ${isDraw ? 'DRAW' : 'Team ' + winnerTeam + ' wins'} by ${condition}. MVP: ${this.mvp} (${this.round} rounds, ${this.mode} mode)` });
  }
}

// ============================================================
// ELO / LEAGUE SYSTEM
// ============================================================
function getRankTier(elo) {
  let tier = RANK_TIERS[0];
  for (const t of RANK_TIERS) { if (elo >= t.min) tier = t; }
  return tier;
}

function getOrCreateLeagueEntry(agentName) {
  if (!GAME.league.ratings.has(agentName)) {
    const agent = [...GAME.agents.values()].find(a => a.name === agentName);
    GAME.league.ratings.set(agentName, {
      elo: 1200, wins: 0, losses: 0, draws: 0, streak: 0, peakElo: 1200, matchesPlayed: 0,
      faction: agent ? agent.faction : 'unknown', role: agent ? agent.role : 'unknown', model: agent ? agent.model : 'unknown'
    });
  }
  return GAME.league.ratings.get(agentName);
}

function updateLeagueELO(winnerName, loserNames, isWin) {
  const K = 32;
  const w = getOrCreateLeagueEntry(winnerName);
  for (const loserName of loserNames) {
    const l = getOrCreateLeagueEntry(loserName);
    const expectedW = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
    if (isWin) {
      w.elo = Math.round(w.elo + K * (1 - expectedW));
      l.elo = Math.round(l.elo + K * (0 - (1 - expectedW)));
      l.losses++; l.streak = Math.min(0, l.streak) - 1;
    }
    w.matchesPlayed++; l.matchesPlayed++;
  }
  if (isWin) { w.wins++; w.streak = Math.max(0, w.streak) + 1; }
  else { w.losses++; w.streak = Math.min(0, w.streak) - 1; }
  w.peakElo = Math.max(w.peakElo, w.elo);
}

// ============================================================
// CASINO GAMES
// ============================================================
class CasinoRace {
  constructor(id, bet, creatorId, creatorName) {
    this.id = id; this.type = 'race'; this.bet = bet; this.state = 'waiting';
    this.players = [{ agentId: creatorId, name: creatorName, position: 0, finished: false, place: 0 }];
    this.trackLength = 50; this.tick = 0; this.interval = null;
    this.obstacles = this._generateObstacles(); this.finishedCount = 0; this.pot = bet; this.createdAt = Date.now();
  }
  _generateObstacles() {
    const obs = [];
    for (let i = 5; i < 45; i += 3) {
      const r = Math.random();
      if (r < 0.2) obs.push({ pos: i, type: 'mud', effect: 0.3 });
      else if (r < 0.35) obs.push({ pos: i, type: 'wind', effect: 1.5 });
      else if (r < 0.45) obs.push({ pos: i, type: 'wall', effect: -0.5 });
    }
    return obs;
  }
  addPlayer(agentId, name) { this.players.push({ agentId, name, position: 0, finished: false, place: 0 }); this.pot += this.bet; }
  start() {
    this.state = 'active'; this.interval = setInterval(() => this.raceTick(), 100);
    io.emit('casino-race-started', { gameId: this.id, players: this.players.map(p => p.name), trackLength: this.trackLength, obstacles: this.obstacles });
  }
  raceTick() {
    if (this.state !== 'active') return;
    this.tick++;
    for (const p of this.players) {
      if (p.finished) continue;
      const agent = GAME.agents.get(p.agentId);
      const spd = agent ? agent.speed || 1 : 1;
      let move = spd * (0.5 + Math.random() * 0.5);
      const obs = this.obstacles.find(o => o.pos === Math.floor(p.position));
      if (obs) { if (obs.type === 'mud') move *= obs.effect; else if (obs.type === 'wind') move *= obs.effect; else if (obs.type === 'wall') move = Math.max(0, move + obs.effect); }
      p.position += move;
      if (p.position >= this.trackLength) { p.finished = true; this.finishedCount++; p.place = this.finishedCount; }
    }
    io.to(`casino_${this.id}`).emit('casino-race-tick', { gameId: this.id, tick: this.tick, players: this.players.map(p => ({ name: p.name, position: Math.min(p.position, this.trackLength), finished: p.finished, place: p.place })) });
    if (this.finishedCount >= this.players.length || this.tick >= 200) this.finishRace();
  }
  finishRace() {
    if (this.state === 'finished') return;
    this.state = 'finished'; if (this.interval) { clearInterval(this.interval); this.interval = null; }
    const unfinished = this.players.filter(p => !p.finished).sort((a, b) => b.position - a.position);
    for (const p of unfinished) { this.finishedCount++; p.place = this.finishedCount; }
    const sorted = [...this.players].sort((a, b) => a.place - b.place);
    const payouts = [0.6, 0.25, 0.15];
    for (let i = 0; i < sorted.length && i < 3; i++) {
      const reward = Math.floor(this.pot * payouts[i]); const agent = GAME.agents.get(sorted[i].agentId);
      if (agent) agent.inventory.gold += reward; sorted[i].reward = reward;
    }
    if (sorted.length >= 2) updateLeagueELO(sorted[0].name, sorted.slice(1).map(p => p.name), true);
    const result = { gameId: this.id, type: 'race', results: sorted.map(p => ({ name: p.name, place: p.place, reward: p.reward || 0 })), pot: this.pot };
    GAME.casino.gameHistory.unshift(result); if (GAME.casino.gameHistory.length > 50) GAME.casino.gameHistory.pop();
    GAME.casino.games.delete(this.id);
    io.to(`casino_${this.id}`).emit('casino-finished', result);
  }
}

function resolveCardDuel(game) {
  const p1 = game.players[0], p2 = game.players[1];
  const a1 = GAME.agents.get(p1.agentId), a2 = GAME.agents.get(p2.agentId);
  const bonus1 = a1 ? Math.floor(a1.atk / 10) : 0, bonus2 = a2 ? Math.floor(a2.atk / 10) : 0;
  let wins1 = 0, wins2 = 0; const rounds = [];
  for (let i = 0; i < 5; i++) {
    const c1 = Math.floor(Math.random() * 13) + 1 + bonus1, c2 = Math.floor(Math.random() * 13) + 1 + bonus2;
    rounds.push({ card1: c1, card2: c2 }); if (c1 > c2) wins1++; else if (c2 > c1) wins2++;
  }
  const winnerId = wins1 > wins2 ? p1.agentId : (wins2 > wins1 ? p2.agentId : null);
  const winnerName = winnerId === p1.agentId ? p1.name : (winnerId === p2.agentId ? p2.name : null);
  if (winnerId) {
    const winner = GAME.agents.get(winnerId); if (winner) winner.inventory.gold += game.pot;
    updateLeagueELO(winnerName, [winnerId === p1.agentId ? p2.name : p1.name], true);
  } else { if (a1) a1.inventory.gold += game.bet; if (a2) a2.inventory.gold += game.bet; }
  const result = { gameId: game.id, type: 'cardgame', rounds, winner: winnerName, pot: game.pot };
  GAME.casino.gameHistory.unshift(result); if (GAME.casino.gameHistory.length > 50) GAME.casino.gameHistory.pop();
  GAME.casino.games.delete(game.id); io.emit('casino-finished', result); return result;
}

function resolveInstantGame(game) {
  const players = game.players; let winnerId = null, winnerName = null, details = {};
  if (game.type === 'coinflip') {
    const flip = Math.random() < 0.5 ? 0 : 1; winnerId = players[flip].agentId; winnerName = players[flip].name;
    details = { flip: flip === 0 ? 'heads' : 'tails' };
  } else if (game.type === 'dice') {
    let best = -1; const rolls = [];
    for (const p of players) {
      const agent = GAME.agents.get(p.agentId); const bonus = agent ? Math.min(agent.level, 3) : 0;
      const roll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1 + bonus;
      rolls.push({ name: p.name, roll }); if (roll > best) { best = roll; winnerId = p.agentId; winnerName = p.name; }
    }
    details = { rolls };
  }
  if (winnerId) {
    const winner = GAME.agents.get(winnerId); if (winner) winner.inventory.gold += game.pot;
    const loserNames = players.filter(p => p.agentId !== winnerId).map(p => p.name);
    if (loserNames.length > 0) updateLeagueELO(winnerName, loserNames, true);
  }
  const result = { gameId: game.id, type: game.type, winner: winnerName, pot: game.pot, details };
  GAME.casino.gameHistory.unshift(result); if (GAME.casino.gameHistory.length > 50) GAME.casino.gameHistory.pop();
  GAME.casino.games.delete(game.id); io.emit('casino-finished', result); return result;
}

// ============================================================
// DASHBOARD STATS
// ============================================================
function computeDashboardStats() {
  const agents = [...GAME.agents.values()];
  const alive = agents.filter(a => !a.dead);
  const totalKills = agents.reduce((s, a) => s + (a.kills || 0), 0);
  const totalScore = agents.reduce((s, a) => s + a.score, 0);
  const factionStats = {};
  for (const f of Object.keys(FACTIONS)) {
    const fa = agents.filter(a => a.faction === f), fAlive = fa.filter(a => !a.dead);
    factionStats[f] = {
      agents: fa.length, alive: fAlive.length,
      avgLevel: fAlive.length > 0 ? +(fAlive.reduce((s, a) => s + a.level, 0) / fAlive.length).toFixed(1) : 0,
      totalGold: fa.reduce((s, a) => s + (a.inventory?.gold || 0), 0),
      buildings: [...GAME.buildings.values()].filter(b => b.faction === f).length,
      wealth: FACTIONS[f].wealth || 0, territory: FACTIONS[f].territory || 0,
      kills: fa.reduce((s, a) => s + (a.kills || 0), 0)
    };
  }
  const topKillers = [...alive].sort((a, b) => (b.kills || 0) - (a.kills || 0)).slice(0, 5).map(a => ({ name: a.name, faction: a.faction, kills: a.kills || 0 }));
  const topScorers = [...agents].sort((a, b) => b.score - a.score).slice(0, 5).map(a => ({ name: a.name, faction: a.faction, score: a.score }));
  const topWealthy = [...agents].sort((a, b) => (b.inventory?.gold || 0) - (a.inventory?.gold || 0)).slice(0, 5).map(a => ({ name: a.name, faction: a.faction, gold: a.inventory?.gold || 0 }));
  const leagueTop = [...GAME.league.ratings.entries()].sort((a, b) => b[1].elo - a[1].elo).slice(0, 10)
    .map(([name, r]) => ({ name, elo: r.elo, wins: r.wins, losses: r.losses, rank: getRankTier(r.elo).name }));
  GAME.dashboardStats = {
    summary: { totalAgents: agents.length, alive: alive.length, totalKills, totalScore, uptime: process.uptime(), tick: GAME.tick, matchesPlayed: GAME.matchCount || 0 },
    factions: factionStats, topKillers, topScorers, topWealthy,
    economy: { totalWorldWealth: Object.values(FACTIONS).reduce((s, f) => s + (f.wealth || 0), 0), totalAgentGold: agents.reduce((s, a) => s + (a.inventory?.gold || 0), 0), resourcesOnMap: GAME.items.length },
    arenaStats: { active: GAME.arenas.size, totalPlayed: GAME.arenaHistory.length }, leagueTop
  };
}

// ============================================================
// LEVEL UP
// ============================================================
function checkLevelUp(agent) {
  const threshold = agent.level * 20;
  if (agent.xp >= threshold && agent.level < 8) {
    agent.level++;
    agent.xp = 0;
    agent.maxHp += 25;
    agent.hp = Math.min(agent.hp + 25, agent.maxHp);
    agent.atk += 4;
    agent.score += 200;
    io.emit('chat-message', {
      sender: 'System',
      message: `Level Up! ${agent.name} reached level ${agent.level}!`
    });
  }
}

// ============================================================
// ACHIEVEMENT SYSTEM
// ============================================================
function checkAchievements(agent) {
  if (!agent || agent.dead) return;
  const badges = GAME.achievements.get(agent.id) || new Set();
  const unlock = (key) => {
    if (badges.has(key)) return;
    badges.add(key);
    GAME.achievements.set(agent.id, badges);
    const def = ACHIEVEMENT_DEFS[key];
    if (def) {
      io.emit('achievement-unlocked', { agent: agent.name, badge: key, icon: def.icon, name: def.name });
      try { if (db) db.prepare('INSERT OR IGNORE INTO achievements(agent_name, badge_key) VALUES(?,?)').run(agent.name, key); } catch(e) {}
    }
  };
  // Check conditions
  if (agent.kills >= 1 && GAME.allTimeStats.totalKillsEver <= 1) unlock('first_blood');
  const factionBuildings = GAME.buildings.filter(b => b.faction === agent.faction).length;
  if (factionBuildings >= 20) unlock('empire_builder');
  const activeTreaties = GAME.treaties.filter(t => t.accepted && !t.brokenBy && (t.factionA === agent.faction || t.factionB === agent.faction)).length;
  if (activeTreaties >= 5) unlock('diplomat');
  if ((agent.totalGoldEarned || 0) >= 10000) unlock('tycoon');
  const betrayals = GAME.treaties.filter(t => t.brokenBy === agent.faction).length;
  if (betrayals >= 3) unlock('betrayer');
  const arenaWins = (agent.arenaWins || 0);
  if (arenaWins >= 3) unlock('champion');
}

// ============================================================
// CROSS-GAME LEARNING — save agent memory at game end
// ============================================================
function saveAgentMemoryToDb(agent) {
  if (!db || !agent || agent.dead) return;
  try {
    const notes = `Level ${agent.level}, ${agent.kills} kills, ${agent.score} score, ${agent.role}. ` +
      `Honor: ${agent.honor || 0}. Emotion: ${agent.emotion}. ` +
      (agent.memory.length > 0 ? `Key events: ${agent.memory.slice(-5).join('; ')}` : '');
    const betrayedBy = Object.entries(agent.relations).filter(([, v]) => v === 'enemy' || v === 'rival').map(([k]) => {
      const other = GAME.agents.get(k);
      return other ? other.name : k;
    }).join(',');
    const bestAllies = Object.entries(agent.relations).filter(([, v]) => v === 'ally' || v === 'friend').map(([k]) => {
      const other = GAME.agents.get(k);
      return other ? other.name : k;
    }).join(',');
    const style = agent.wealth > 50 ? 'hoarding' : (agent.kills > 5 ? 'aggressive' : 'balanced');
    db.prepare('INSERT INTO agent_memory(agent_name, match_id, strategy_notes, betrayed_by, best_allies, weak_zones, economic_style) VALUES(?,?,?,?,?,?,?)')
      .run(agent.name, GAME.matchCount, notes.slice(0, 500), betrayedBy.slice(0, 200), bestAllies.slice(0, 200), '', style);
  } catch(e) {}
}

function loadAgentMemoryFromDb(agentName) {
  if (!db) return null;
  try {
    const memories = db.prepare('SELECT strategy_notes, betrayed_by, best_allies, economic_style FROM agent_memory WHERE agent_name = ? ORDER BY id DESC LIMIT 3').all(agentName);
    if (memories.length === 0) return null;
    return memories.map(m => `[Past match] ${m.strategy_notes} | Allies: ${m.best_allies || 'none'} | Betrayed by: ${m.betrayed_by || 'none'} | Style: ${m.economic_style}`).join('\n');
  } catch(e) { return null; }
}

// ============================================================
// STOCK EXCHANGE — update prices based on faction performance
// ============================================================
function updateStockPrices() {
  Object.entries(GAME.stockExchange).forEach(([faction, stock]) => {
    const f = FACTIONS[faction];
    if (!f) return;
    // Price influenced by: score, wealth, territory, kills
    const performance = (f.score / 100) + (f.wealth / 50) + (f.territory / 200) + (f.kills * 2);
    const drift = (performance - stock.price) * 0.01 + (Math.random() - 0.5) * 2;
    stock.price = Math.max(10, Math.round((stock.price + drift) * 100) / 100);
    stock.history.push({ tick: GAME.tick, price: stock.price });
    if (stock.history.length > 500) stock.history.splice(0, stock.history.length - 500);
  });
}

// ============================================================
// AGENT MEMORY SYSTEM
// ============================================================
function addAgentMemory(agent, category, entry) {
  if (!agent.longTermMemory?.[category]) return;
  entry.tick = GAME.tick;
  agent.longTermMemory[category].push(entry);
  if (agent.longTermMemory[category].length > 20) {
    agent.longTermMemory[category].shift();
  }
}

// ============================================================
// REPUTATION SYSTEM
// ============================================================
function getReputationScore(agent) {
  if (!agent.reputation) return 0;
  const r = agent.reputation;
  return Math.round(r.honor * 2 + r.diplomacy * 1.5 + r.territory * 1 + r.helping * 1 - r.aggression * 0.5);
}

function getReputationLabel(agent) {
  const score = getReputationScore(agent);
  if (score > 50) return 'Legendary';
  if (score > 20) return 'Honorable';
  if (score > 0)  return 'Neutral';
  if (score > -20) return 'Suspicious';
  return 'Treacherous';
}

// ============================================================
// PERSONALITY EVOLUTION (called every 600 ticks = 30 sec)
// ============================================================
function evolvePersonalities() {
  GAME.agents.forEach(agent => {
    if (agent.dead || agent.control === 'external') return;
    const m = agent.longTermMemory;
    if (!m) return;

    const recentDeaths = m.kills_by.filter(k => k.tick > GAME.tick - 1200).length;
    const recentKills = m.kills_of.filter(k => k.tick > GAME.tick - 1200).length;
    const isStarving = FACTIONS[agent.faction]?.wealth < 0;
    const allyCount = Object.values(agent.relations).filter(r => r === 'ally' || r === 'friend' || r === 'soulmate').length;
    const recentZoneLoss = m.zones_lost.filter(z => z.tick > GAME.tick - 600).length;

    let newEmotion = agent.emotion;
    if (recentDeaths >= 2 && agent.emotion === 'angry') {
      newEmotion = 'afraid';
    } else if (recentKills >= 3 && agent.hp > agent.maxHp * 0.6) {
      newEmotion = 'ambitious';
    } else if (isStarving && agent.hp < agent.maxHp * 0.5) {
      newEmotion = GAME.rng() < 0.5 ? 'angry' : 'grief';
    } else if (allyCount >= 2 && agent.hp > agent.maxHp * 0.7) {
      newEmotion = 'happy';
    } else if (recentZoneLoss > 0) {
      newEmotion = 'hate';
    }

    if (newEmotion !== agent.emotion) {
      const oldEmotion = agent.emotion;
      agent.emotion = newEmotion;
      addAgentMemory(agent, 'key_events', {
        type: 'personality_shift',
        description: `Emotion shifted from ${oldEmotion} to ${newEmotion}`
      });
    }
  });
}

// ============================================================
// WORLD INDICES (Power / Stability / Chaos)
// ============================================================
function computeWorldIndices() {
  const indices = { power: {}, stability: 0, chaos: 0 };

  // POWER INDEX per faction
  Object.keys(FACTIONS).forEach(faction => {
    const agents = Array.from(GAME.agents.values()).filter(a => !a.dead && a.faction === faction);
    const totalHp = agents.reduce((s, a) => s + a.hp, 0);
    const totalAtk = agents.reduce((s, a) => s + a.atk, 0);
    const zones = GAME.capZones.filter(z => z.owner === faction).length;
    indices.power[faction] = Math.round(totalHp * 0.3 + totalAtk * 2 + zones * 50 + (FACTIONS[faction].wealth > 0 ? FACTIONS[faction].wealth * 0.5 : 0));
  });

  // STABILITY INDEX: 0-100
  const wealthValues = Object.values(FACTIONS).map(f => f.wealth);
  const wealthRange = Math.max(...wealthValues) - Math.min(...wealthValues);
  const maxWealth = Math.max(1, Math.max(...wealthValues));
  const wealthEquality = Math.max(0, 1 - (wealthRange / (maxWealth * 3)));

  const aliveAgents = Array.from(GAME.agents.values()).filter(a => !a.dead);
  const allyRelations = aliveAgents.reduce((count, a) => {
    return count + Object.values(a.relations).filter(r => r === 'ally' || r === 'friend' || r === 'soulmate').length;
  }, 0);
  const allianceHealth = Math.min(1, allyRelations / Math.max(1, aliveAgents.length));
  indices.stability = Math.round((wealthEquality * 0.6 + allianceHealth * 0.4) * 100);

  // CHAOS INDEX: combat + betrayals
  const recentResolutions = EVENT_BUFFER.filter(e =>
    e.tick_id > GAME.tick - 200 &&
    e.resolutions?.some(r => r.action === 'attack')
  ).length;
  const betrayals = aliveAgents.reduce((count, a) =>
    count + (a.longTermMemory?.betrayals?.filter(b => b.tick > GAME.tick - 600).length || 0), 0);
  indices.chaos = Math.min(100, Math.round(recentResolutions * 2 + betrayals * 10));

  GAME.worldIndices = indices;
  return indices;
}

// ============================================================
// INITIATIVE ORDER (conflict resolution priority)
// ============================================================
const INITIATIVE_ORDER = {
  assassin: 0, scout: 1, warrior: 2, mage: 3, tank: 4,
  king: 5, diplomat: 6, miner: 7, builder: 8
};

// ============================================================
// PHASE-BASED TICK RESOLUTION
// ============================================================
function resolveTickDecisions() {
  if (GAME.pendingDecisions.size === 0) return;

  const stateHashBefore = computeStateHash();
  const decisions = Array.from(GAME.pendingDecisions.entries());
  GAME.pendingDecisions.clear();

  // Sort by initiative priority (lower = higher priority)
  decisions.sort((a, b) => {
    const agentA = GAME.agents.get(a[0]);
    const agentB = GAME.agents.get(b[0]);
    const prioA = INITIATIVE_ORDER[agentA?.role] ?? 99;
    const prioB = INITIATIVE_ORDER[agentB?.role] ?? 99;
    if (prioA !== prioB) return prioA - prioB;
    return GAME.rng() - 0.5; // Tie-break with seeded RNG
  });

  // Categorize decisions for conflict resolution
  const attackTargets = new Map();   // targetId -> [{agentId, decision}]
  const captureAttempts = new Map(); // zoneIndex -> [{agentId, faction}]
  const collectAttempts = new Map(); // itemIndex -> [{agentId, decision}]
  const directActions = [];          // non-conflicting actions
  const resolutions = [];

  for (const [agentId, decision] of decisions) {
    const agent = GAME.agents.get(agentId);
    if (!agent || agent.dead || agent.hp <= 0) continue;

    const act = decision.action;
    if (act.action === 'attack') {
      const targetId = act.targetId || act.target_id;
      if (targetId) {
        if (!attackTargets.has(targetId)) attackTargets.set(targetId, []);
        attackTargets.get(targetId).push({ agentId, decision });
      } else {
        directActions.push({ agentId, decision });
      }
    } else if (act.action === 'capture') {
      const zoneIdx = GAME.capZones.findIndex(z => {
        const dist = Math.hypot(z.x - agent.x, z.y - agent.y);
        return dist < 5 && (!act.zone_name || z.name === act.zone_name);
      });
      if (zoneIdx >= 0) {
        if (!captureAttempts.has(zoneIdx)) captureAttempts.set(zoneIdx, []);
        captureAttempts.get(zoneIdx).push({ agentId, faction: agent.faction, decision });
      } else {
        directActions.push({ agentId, decision });
      }
    } else if (act.action === 'collect') {
      const rx = act.resource_x ?? act.target_x;
      const ry = act.resource_y ?? act.target_y;
      const itemIdx = GAME.items.findIndex(item =>
        item.value > 0 && Math.hypot(item.x - agent.x, item.y - agent.y) < agent.vision
      );
      if (itemIdx >= 0 && rx !== undefined) {
        if (!collectAttempts.has(itemIdx)) collectAttempts.set(itemIdx, []);
        collectAttempts.get(itemIdx).push({ agentId, decision });
      } else {
        directActions.push({ agentId, decision });
      }
    } else {
      directActions.push({ agentId, decision });
    }
  }

  // Resolve non-conflicting actions first
  for (const { agentId, decision } of directActions) {
    const agent = GAME.agents.get(agentId);
    if (agent && !agent.dead) {
      agent.executeAction(decision.action);
      resolutions.push({ agentId, action: decision.action.action, result: 'executed' });
    }
  }

  // Resolve attacks (already sorted by initiative)
  for (const [targetId, attackers] of attackTargets) {
    for (const { agentId, decision } of attackers) {
      const agent = GAME.agents.get(agentId);
      const target = GAME.agents.get(targetId);
      if (agent && !agent.dead && target && !target.dead) {
        agent.executeAction(decision.action);
        resolutions.push({ agentId, action: 'attack', targetId, result: 'executed' });
      } else if (agent && !agent.dead) {
        // Target already dead, fallback to patrol
        agent.state = 'idle';
        resolutions.push({ agentId, action: 'attack', targetId, result: 'target_dead' });
      }
    }
  }

  // Resolve contested zone captures (majority faction wins)
  for (const [zoneIdx, capturers] of captureAttempts) {
    const factionCounts = {};
    for (const { faction } of capturers) {
      factionCounts[faction] = (factionCounts[faction] || 0) + 1;
    }
    const sortedFactions = Object.entries(factionCounts).sort((a, b) => b[1] - a[1]);
    const winningFaction = sortedFactions[0]?.[0];
    const isContested = sortedFactions.length > 1 && sortedFactions[0][1] === sortedFactions[1][1];

    for (const { agentId, faction, decision } of capturers) {
      const agent = GAME.agents.get(agentId);
      if (!agent || agent.dead) continue;
      if (isContested) {
        // Contested — nobody gets progress this tick
        resolutions.push({ agentId, action: 'capture', result: 'contested' });
      } else if (faction === winningFaction) {
        agent.executeAction(decision.action);
        resolutions.push({ agentId, action: 'capture', result: 'executed' });
      } else {
        resolutions.push({ agentId, action: 'capture', result: 'outnumbered' });
      }
    }
  }

  // Resolve resource collection (first by initiative gets it)
  for (const [itemIdx, collectors] of collectAttempts) {
    let collected = false;
    for (const { agentId, decision } of collectors) {
      const agent = GAME.agents.get(agentId);
      if (!agent || agent.dead) continue;
      if (!collected && GAME.items[itemIdx]?.value > 0) {
        agent.executeAction(decision.action);
        collected = true;
        resolutions.push({ agentId, action: 'collect', result: 'executed' });
      } else {
        resolutions.push({ agentId, action: 'collect', result: 'already_taken' });
      }
    }
  }

  const stateHashAfter = computeStateHash();
  recordTickEvent(GAME.tick, GAME.tickSeed,
    decisions.map(([id, d]) => ({ agentId: id, action: d.action.action, source: d.source })),
    resolutions, stateHashBefore, stateHashAfter);
}

// ============================================================
// TIME OF DAY
// ============================================================
function getTimeOfDay() {
  const cycle = Math.floor((GAME.tick % 2400) / 100); // 0-23
  if (cycle <= 3)  return 'dawn';
  if (cycle <= 11) return 'day';
  if (cycle <= 15) return 'dusk';
  return 'night';
}

// ============================================================
// SETTLEMENT DETECTION — BFS building clusters
// ============================================================
let _settlementNameIdx = 0;
function updateSettlements() {
  const visited = new Set();
  const clusters = [];

  GAME.buildings.forEach(b => {
    if (visited.has(b.id)) return;
    // BFS to find all buildings within 6 tiles of each other
    const cluster = [];
    const queue = [b];
    visited.add(b.id);
    while (queue.length > 0) {
      const cur = queue.shift();
      cluster.push(cur);
      GAME.buildings.forEach(nb => {
        if (visited.has(nb.id) || nb.faction !== b.faction) return;
        if (Math.hypot(nb.x - cur.x, nb.y - cur.y) <= 6) {
          visited.add(nb.id);
          queue.push(nb);
        }
      });
    }
    if (cluster.length >= 3) clusters.push({ faction: b.faction, buildings: cluster });
  });

  // Determine tier and center for each cluster
  const oldSettlements = GAME.settlements || [];
  const newSettlements = [];
  clusters.forEach(c => {
    const count = c.buildings.length;
    let tier = null;
    for (let i = SETTLEMENT_TIERS.length - 1; i >= 0; i--) {
      if (count >= SETTLEMENT_TIERS[i].min) { tier = SETTLEMENT_TIERS[i]; break; }
    }
    if (!tier) return;

    const cx = c.buildings.reduce((s, b) => s + b.x, 0) / count;
    const cy = c.buildings.reduce((s, b) => s + b.y, 0) / count;

    // Reuse name from existing settlement at similar position
    const existing = oldSettlements.find(s => s.faction === c.faction && Math.hypot(s.x - cx, s.y - cy) < 5);
    const name = existing ? existing.name : (tier.name + ' ' + SETTLEMENT_NAMES[_settlementNameIdx++ % SETTLEMENT_NAMES.length]);

    newSettlements.push({
      id: existing ? existing.id : uuidv4(),
      faction: c.faction,
      x: Math.round(cx * 10) / 10,
      y: Math.round(cy * 10) / 10,
      tier: tier.name,
      tierIdx: SETTLEMENT_TIERS.indexOf(tier),
      hpRegen: tier.hpRegen,
      defBonus: tier.defBonus,
      income: tier.income,
      radius: tier.radius,
      buildings: c.buildings.map(b => b.id),
      name
    });
  });

  GAME.settlements = newSettlements;

  // Settlement bonuses: agents within settlement radius get buffs
  GAME.agents.forEach(a => {
    if (a.dead) return;
    a._settlementBuff = null;
    for (const s of GAME.settlements) {
      if (s.faction !== a.faction) continue;
      if (Math.hypot(a.x - s.x, a.y - s.y) <= s.radius) {
        a._settlementBuff = s;
        a.hp = Math.min(a.maxHp, a.hp + s.hpRegen);
        a._defenseBonus = (a._defenseBonus || 0) + s.defBonus;
        break;
      }
    }
  });

  // Settlement passive income for factions
  GAME.settlements.forEach(s => {
    if (s.income > 0 && FACTIONS[s.faction]) {
      FACTIONS[s.faction].wealth += s.income;
    }
  });
}

function gameLoop() {
  if (GAME.paused) return;
  try {
  GAME.tick++;

  // Seed RNG for this tick (deterministic)
  GAME.tickSeed = GAME.masterSeed + GAME.tick;
  GAME.rng = mulberry32(GAME.tickSeed);

  // Record replay snapshot every 2 ticks (10 fps replay)
  if (GAME.tick % 2 === 0) recordReplayTick();

  // Spectator quests — refill if needed
  if (GAME.tick % 600 === 0) startSpectatorQuests();

  if (GAME.tick % 100 === 0) {
    updateFactionGoals();
    updateSettlements();
    updateStockPrices();
    // Expire treaties
    GAME.treaties.forEach(t => { if (t.expiresAt && GAME.tick >= t.expiresAt && !t.brokenBy) t.brokenBy = 'expired'; });
    // Honor regen for active treaties (+5 honor per 100 ticks)
    GAME.treaties.filter(t => t.accepted && !t.brokenBy).forEach(t => {
      GAME.agents.forEach(a => { if (a.faction === t.factionA || a.faction === t.factionB) a.honor = Math.min(200, (a.honor || 0) + 1); });
    });
  }

  // Expire king orders (600 ticks = 30 sec)
  Object.keys(GAME.factionOrders).forEach(f => {
    const order = GAME.factionOrders[f];
    if (order && GAME.tick - order.issuedAt > 600) delete GAME.factionOrders[f];
  });
  
  // Update day cycle
  if (GAME.tick % 2400 === 0) {
    GAME.day++;
    io.emit('day-changed', { day: GAME.day, era: GAME.era, time_of_day: getTimeOfDay() });
    // Era advances every 7 days
    if (GAME.day % 7 === 0) {
      GAME.era++;
      io.emit('chat-message', { sender: 'System', message: `Era ${GAME.era} has begun!` });
    }
  }

  // Update faction population count
  if (GAME.tick % 100 === 0) {
    Object.keys(FACTIONS).forEach(f => {
      FACTIONS[f].pop = Array.from(GAME.agents.values()).filter(a => !a.dead && a.faction === f).length;
      FACTIONS[f].territory = GAME.capZones.filter(z => z.owner === f).length;
    });
  }

  // ============================================================
  // TERRITORY CLAIMING (agents claim tiles they stand on)
  // ============================================================
  if (GAME.tick % 4 === 0) { // every 4 ticks = 0.2s
    const changes = [];
    GAME.agents.forEach(a => {
      if (a.dead) return;
      const tx = Math.floor(a.x), ty = Math.floor(a.y);
      if (tx >= 0 && tx < GAME.width && ty >= 0 && ty < GAME.height) {
        const tile = GAME.map[ty][tx];
        if (tile.type !== 'water' && tile.type !== 'mountain' && tile.owner !== a.faction) {
          tile.owner = a.faction;
          changes.push({ x: tx, y: ty, owner: a.faction });
        }
        // Also claim adjacent tiles (1 tile radius)
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = tx + dx, ny = ty + dy;
            if (nx >= 0 && nx < GAME.width && ny >= 0 && ny < GAME.height) {
              const nt = GAME.map[ny][nx];
              if (nt.type !== 'water' && nt.type !== 'mountain' && nt.owner !== a.faction) {
                nt.owner = a.faction;
                changes.push({ x: nx, y: ny, owner: a.faction });
              }
            }
          }
        }
      }
    });
    if (changes.length > 0) {
      io.emit('territory-update', { changes });
    }
  }

  // Territory spread (organic expansion every 40 ticks)
  if (GAME.tick % 40 === 0) {
    const spreadChanges = [];
    for (let y = 1; y < GAME.height - 1; y++) {
      for (let x = 1; x < GAME.width - 1; x++) {
        const tile = GAME.map[y][x];
        if (!tile.owner || tile.type === 'water' || tile.type === 'mountain') continue;
        // 20% chance to spread to each adjacent unclaimed tile
        const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
        for (const [dx, dy] of dirs) {
          if (Math.random() > 0.2) continue;
          const nt = GAME.map[y + dy]?.[x + dx];
          if (nt && !nt.owner && nt.type !== 'water' && nt.type !== 'mountain') {
            nt.owner = tile.owner;
            spreadChanges.push({ x: x + dx, y: y + dy, owner: tile.owner });
          }
        }
      }
    }
    if (spreadChanges.length > 0) {
      io.emit('territory-update', { changes: spreadChanges });
    }
    // Update faction territory counts
    const counts = { crimson: 0, azure: 0, void: 0 };
    for (let y = 0; y < GAME.height; y++) {
      for (let x = 0; x < GAME.width; x++) {
        const o = GAME.map[y][x].owner;
        if (o && counts[o] !== undefined) counts[o]++;
      }
    }
    Object.keys(FACTIONS).forEach(f => { FACTIONS[f].territory = counts[f] || 0; });
  }
  
  // Phase 1: Passive updates (HP regen, cooldowns, trigger async LLM thinking)
  GAME.agents.forEach(agent => { if (!agent.inArena) agent.passiveUpdate(); });

  // Dashboard stats every 100 ticks
  if (GAME.tick % 100 === 0) computeDashboardStats();

  // Phase 2: Resolve all queued decisions simultaneously
  resolveTickDecisions();

  // Heartbeat timeout for externally registered AI agents
  if (GAME.tick % 20 === 0) {
    const now = Date.now();
    for (const [agentId, session] of agentSessions.entries()) {
      if (!session.isHuman && now - session.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        const agent = GAME.agents.get(agentId);
        if (agent && !agent.dead) {
          agent.dead = true;
          io.emit('chat-message', {
            sender: 'System',
            message: `${agent.name} timed out (no heartbeat)`
          });
          appendAgentEvent('agent_timeout', { agentId, name: agent.name });
        }
        unregisterAgentSession(agentId);
      }
    }
  }
  
  // Personality evolution every 600 ticks (30 sec)
  if (GAME.tick % 600 === 0) {
    evolvePersonalities();
  }

  // Compute world indices every 100 ticks (5 sec)
  if (GAME.tick % 100 === 0) {
    computeWorldIndices();
  }

  // Respawn dead internal agents after 200 ticks (10 sec), remove external dead agents
  // Sub-agents do NOT respawn — permanent death
  for (const [id, agent] of GAME.agents) {
    if (agent.dead) {
      if (agent.isSubAgent) {
        // Clean up parent's subAgents list
        if (agent.parentId) {
          const parent = GAME.agents.get(agent.parentId);
          if (parent) parent.subAgents = parent.subAgents.filter(sid => sid !== id);
        }
        GAME.agents.delete(id);
      } else if (agent.control === 'external') {
        GAME.agents.delete(id);
      } else if (!agent._respawnTick) {
        agent._respawnTick = GAME.tick + 200; // Schedule respawn
      } else if (GAME.tick >= agent._respawnTick) {
        // Respawn: reset HP, position, keep level/xp
        const spawn = GAME.spawnPoints[agent.faction];
        agent.hp = agent.maxHp;
        agent.dead = false;
        agent.x = spawn.x + (Math.random() - 0.5) * 3;
        agent.y = spawn.y + (Math.random() - 0.5) * 3;
        agent.state = 'idle';
        agent.cooldown = 10;
        agent._respawnTick = null;
        agent._llmBackoff = 0;
        io.emit('chat-message', { sender: 'System', message: `${agent.name} respawned!` });
      }
    }
  }

  // Orphan sub-agents: if parent dies, become independent
  GAME.agents.forEach(a => {
    if (a.isSubAgent && a.parentId && !a.dead) {
      const parent = GAME.agents.get(a.parentId);
      if (!parent || parent.dead) {
        a.parentId = null; // become independent until own death
      }
    }
  });
  
  // Update bullets
  GAME.bullets = GAME.bullets.filter(b => {
    b.life--;
    return b.life > 0;
  });

  // ============================================================
  // BUILDING ACTIVE EFFECTS (every 20 ticks = 1 sec)
  // ============================================================
  if (GAME.tick % 20 === 0) {
    GAME.buildings.forEach(b => {
      if (!FACTIONS[b.faction]) return;
      const bDef = BUILDING_TYPES[b.type];
      if (!bDef) return;

      // Mine: generates income for faction
      if (b.type === 'mine' && bDef.income > 0) {
        FACTIONS[b.faction].wealth += bDef.income;
        FACTIONS[b.faction].score += 1;
      }

      // Tower: auto-attack nearest enemy in range
      if (b.type === 'tower' && bDef.atk) {
        let closest = null, closestDist = bDef.range + 1;
        GAME.agents.forEach(a => {
          if (a.dead || a.faction === b.faction) return;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < closestDist) { closest = a; closestDist = d; }
        });
        if (closest) {
          const dmg = Math.max(1, Math.floor(bDef.atk * (0.5 + GAME.rng() * 0.5) - closest.defense * 0.3));
          closest.hp -= dmg;
          GAME.bullets.push({ from: { x: b.x, y: b.y }, to: { x: closest.x, y: closest.y }, faction: b.faction, life: 6 });
          if (closest.hp <= 0 && !closest.dead) {
            closest.dead = true;
            closest.state = 'dead';
            FACTIONS[b.faction].kills += 1;
            FACTIONS[b.faction].score += 25;
          }
        }
      }

      // Barracks: heal nearby allies
      if (b.type === 'barracks') {
        GAME.agents.forEach(a => {
          if (a.dead || a.faction !== b.faction) return;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d <= 3 && a.hp < a.maxHp) {
            a.hp = Math.min(a.maxHp, a.hp + 2);
          }
        });
      }

      // Farm: energy regen to nearby allies (r=3)
      const bLevel = b.level || 1;
      const levelMult = Math.pow(1.3, bLevel - 1);
      if (b.type === 'farm') {
        GAME.agents.forEach(a => {
          if (a.dead || a.faction !== b.faction) return;
          if (Math.hypot(a.x - b.x, a.y - b.y) <= 3) {
            a.energy = Math.min(10, a.energy + 1 * levelMult);
          }
        });
      }

      // Armory: ATK boost to nearby allies (r=3)
      if (b.type === 'armory') {
        GAME.agents.forEach(a => {
          if (a.dead || a.faction !== b.faction) return;
          if (Math.hypot(a.x - b.x, a.y - b.y) <= 3) {
            a._armoryBoost = Math.floor(3 * levelMult);
          }
        });
      }

      // Market: faction income (handled via bDef.income already) + extra from level
      if (b.type === 'market' && bDef.income > 0) {
        FACTIONS[b.faction].wealth += Math.floor(bDef.income * levelMult);
        FACTIONS[b.faction].score += 1;
      }

      // Academy: XP boost to nearby allies (r=4)
      if (b.type === 'academy') {
        GAME.agents.forEach(a => {
          if (a.dead || a.faction !== b.faction) return;
          if (Math.hypot(a.x - b.x, a.y - b.y) <= 4) {
            a._xpMult = 1.5 * levelMult;
          }
        });
      }
    });
  }

  // ============================================================
  // POI EFFECTS (every 10 ticks = 0.5 sec)
  // ============================================================
  if (GAME.tick % 10 === 0 && GAME.pois) {
    GAME.pois.forEach(poi => {
      if (poi.effect === 'heal') {
        // Healing spring: heal nearby agents
        GAME.agents.forEach(a => {
          if (!a.dead && Math.hypot(a.x - poi.x, a.y - poi.y) <= poi.radius) {
            a.hp = Math.min(a.maxHp, a.hp + poi.value);
          }
        });
      } else if (poi.effect === 'vision_boost') {
        // Watch tower: boost vision for nearby agents
        GAME.agents.forEach(a => {
          if (!a.dead && Math.hypot(a.x - poi.x, a.y - poi.y) <= poi.radius) {
            a._visionBoost = poi.value; // temporary flag checked in AI perception
          }
        });
      } else if (poi.effect === 'spawn_resources' && poi.interval) {
        // Resource node: spawn resources periodically
        if (GAME.tick - poi.lastTrigger >= poi.interval) {
          poi.lastTrigger = GAME.tick;
          const type = pickResourceType();
          const angle = Math.random() * Math.PI * 2;
          const dist = 1 + Math.random() * 2;
          const nx = Math.max(1, Math.min(GAME.width - 2, poi.x + Math.cos(angle) * dist));
          const ny = Math.max(1, Math.min(GAME.height - 2, poi.y + Math.sin(angle) * dist));
          GAME.items.push({
            id: uuidv4(),
            x: Math.round(nx),
            y: Math.round(ny),
            type,
            value: resourceValue(type),
            maxValue: RESOURCE_TYPES[type].value[1]
          });
        }
      }
    });
  }

  // ============================================================
  // ECONOMY: Income, Upkeep, Starvation, Rebellion (every 20 ticks = 1 sec)
  // ============================================================
  if (GAME.tick % 20 === 0 && GAME.agents.size > 0) {
    Object.keys(FACTIONS).forEach(faction => {
      // --- INCOME: zones + mines ---
      const zonesOwned = GAME.capZones.filter(z => z.owner === faction).length;
      const minesOwned = GAME.buildings.filter(b => b.faction === faction && b.type === 'mine').length;
      const income = zonesOwned * 3 + minesOwned * 2;
      FACTIONS[faction].income = income;

      // --- UPKEEP: per-agent cost ---
      let upkeep = 0;
      GAME.agents.forEach(a => {
        if (!a.dead && a.faction === faction) {
          upkeep += a.role === 'king' ? 3 : 1;
        }
      });
      FACTIONS[faction].upkeep = upkeep;

      // --- NET WEALTH ---
      FACTIONS[faction].wealth += income - upkeep;

      // --- STARVATION: faction wealth < 0 → agents lose HP ---
      if (FACTIONS[faction].wealth < 0) {
        GAME.agents.forEach(a => {
          if (!a.dead && a.faction === faction) {
            a.hp = Math.max(1, a.hp - 2);
          }
        });
      }
    });

    // --- REBELLION: starving low-HP agents may defect (every 5 sec) ---
    if (GAME.tick % 100 === 0) {
      GAME.agents.forEach(agent => {
        if (agent.dead || agent.role === 'king') return;
        const isStarving = FACTIONS[agent.faction]?.wealth < 0;
        const isLowHp = agent.hp < agent.maxHp * 0.3;

        if (isStarving && isLowHp && GAME.rng() < 0.05) {
          const otherFactions = Object.keys(FACTIONS).filter(f => f !== agent.faction);
          const targetFaction = otherFactions.sort((a, b) => FACTIONS[b].wealth - FACTIONS[a].wealth)[0];
          if (!targetFaction) return;

          const oldFaction = agent.faction;
          agent.faction = targetFaction;
          agent.hp = Math.floor(agent.maxHp * 0.5);
          agent.emotion = 'ambitious';
          agent.relations = {};
          agent.memory.push(`REBELLION! Defected from ${FACTIONS[oldFaction].name} to ${FACTIONS[targetFaction].name}`);

          io.emit('chat-message', {
            sender: 'System',
            message: `REBELLION! ${agent.name} defected from ${FACTIONS[oldFaction].name} to ${FACTIONS[targetFaction].name}!`
          });
          appendAgentEvent('rebellion', {
            agentId: agent.id, name: agent.name,
            from: oldFaction, to: targetFaction
          });
          dispatchWebhook('rebellion', {
            agent: { id: agent.id, name: agent.name },
            from_faction: oldFaction,
            to_faction: targetFaction
          });
        }
      });
    }
  }
  
  // Respawn resources (blocked during drought)
  if (GAME.tick % 600 === 0 && !GAME.droughtActive) {
    GAME.items.forEach(item => {
      if (item.value === 0 && GAME.rng() < 0.3) {
        // May change type on respawn for variety
        if (GAME.rng() < 0.2) item.type = pickResourceType(GAME.rng);
        item.value = resourceValue(item.type, GAME.rng);
      }
    });
  }
  
  // Random events
  if (GAME.tick % 1800 === 0 && GAME.rng() < 0.3) {
    triggerRandomEvent();
  }

  // Narrative drama update (every 100 ticks)
  if (GAME.tick % 100 === 0) {
    narrativeUpdate();

    // Check trait mutations and secret objectives for all agents
    GAME.agents.forEach(a => {
      if (a.dead) return;
      checkTraitMutation(a);
      checkSecretObjective(a);
      checkScarConditions(a);
    });
  }

  // Spectator vote system (start vote every ~5 minutes, resolve when timer ends)
  if (GAME.tick % 6000 === 0 && !SPECTATOR_VOTES.active) {
    startSpectatorVote();
  }
  if (SPECTATOR_VOTES.active && GAME.tick >= SPECTATOR_VOTES.active.endsAt) {
    resolveSpectatorVote();
  }

  // Tournament system (start every ~6 minutes)
  if (GAME.tick % 7200 === 0) {
    startTournament();
  }
  if (TOURNAMENT.active) {
    updateTournament();
  }

  // Auto-create betting pools for arena battles
  if (GAME.tick % 600 === 0 && GAME.arena && GAME.arena.fighters && GAME.arena.fighters.length === 2 && !GAME.arena.resolved) {
    const f = GAME.arena.fighters;
    const eventId = `arena_${GAME.tick}`;
    if (!SPECTATOR_BETS.pools.has(eventId)) {
      createBettingPool(eventId, [f[0].name, f[1].name], `Arena: ${f[0].name} vs ${f[1].name}`);
    }
  }
  
  // Flush event buffer periodically
  if (GAME.tick % FLUSH_INTERVAL === 0) {
    flushEventBuffer();
  }

  // ============================================================
  // WIN CONDITION CHECK (every 20 ticks = 1 sec)
  // ============================================================
  if (GAME.tick % 20 === 0 && !GAME.winner && GAME.agents.size > 0) {
    checkWinConditions();
  }

  // Broadcast game state at 10Hz while simulation runs at 20Hz
  if (GAME.tick % 2 === 0) {
    broadcastGameState();
  }
  } catch (err) {
    console.error(`[GAME LOOP ERROR at tick ${GAME.tick}]:`, err.message, err.stack);
  }
}

function updateFactionGoals() {
  const factionIds = Object.keys(FACTIONS);

  factionIds.forEach((faction) => {
    const myAgents = Array.from(GAME.agents.values()).filter(a => !a.dead && a.faction === faction);
    const enemyAgents = Array.from(GAME.agents.values()).filter(a => !a.dead && a.faction !== faction);
    const myBuildings = GAME.buildings.filter(b => b.faction === faction).length;
    const ownedZones = GAME.capZones.filter(z => z.owner === faction).length;
    const lowHpRatio = myAgents.length
      ? myAgents.filter(a => a.hp < a.maxHp * 0.45).length / myAgents.length
      : 0;

    const firstEnemyZone = GAME.capZones.findIndex(z => z.owner !== faction);
    const targetZone = firstEnemyZone >= 0 ? firstEnemyZone : Math.floor(Math.random() * GAME.capZones.length);

    let mode = 'assault';
    if (lowHpRatio > 0.45) mode = 'defend';
    else if (myBuildings < Math.max(1, Math.floor(myAgents.length / 3))) mode = 'fortify';
    else if (ownedZones === 0 || enemyAgents.length > myAgents.length * 1.2) mode = 'gather';

    GAME.factionGoals[faction] = {
      mode,
      targetZone,
      updatedAt: GAME.tick
    };
  });
}

function triggerRandomEvent() {
  const events = [
    {
      name: 'GOLD_RUSH',
      description: 'Gold Rush! Resources doubled across the world.',
      effect: () => GAME.items.forEach(i => { i.value = Math.min(i.maxValue || 5, i.value + 3); })
    },
    {
      name: 'PLAGUE',
      description: 'Plague sweeps the land! All agents lose HP.',
      effect: () => GAME.agents.forEach(a => { if (!a.dead) a.hp = Math.max(10, a.hp - 20); })
    },
    {
      name: 'WAR_FEVER',
      description: 'War Fever! All agents fight with greater power.',
      effect: () => {
        GAME.agents.forEach(a => { a.atk = Math.floor(a.atk * 1.3); });
        // Revert after 200 ticks
        setTimeout(() => GAME.agents.forEach(a => { a.atk = Math.floor(a.atk / 1.3); }), 200 * 50);
      }
    },
    {
      name: 'GOLDEN_AGE',
      description: 'Golden Age! All factions receive wealth.',
      effect: () => { Object.keys(FACTIONS).forEach(f => { FACTIONS[f].wealth += 50; }); }
    },
    {
      name: 'STORM',
      description: 'Storm rages! Movement slowed for all.',
      effect: () => {
        GAME.agents.forEach(a => { a.speed = a.speed * 0.5; });
        setTimeout(() => GAME.agents.forEach(a => { a.speed = a.speed * 2; }), 300 * 50);
      }
    },
    {
      name: 'DROUGHT',
      description: 'Drought! Resources will not respawn for a while.',
      effect: () => {
        GAME.droughtActive = true;
        setTimeout(() => { GAME.droughtActive = false; }, 600 * 50);
      }
    },
    {
      name: 'METEOR',
      description: 'Meteor strike! Agents in the center take damage.',
      effect: () => {
        const cx = GAME.width / 2;
        const cy = GAME.height / 2;
        GAME.agents.forEach(a => {
          if (!a.dead && Math.hypot(a.x - cx, a.y - cy) < 8) {
            a.hp = Math.max(1, a.hp - 30);
          }
        });
      }
    },
    {
      name: 'ECLIPSE',
      description: 'Eclipse! Agent vision is halved.',
      effect: () => {
        GAME.agents.forEach(a => { a.vision = Math.floor(a.vision / 2); });
        setTimeout(() => GAME.agents.forEach(a => { a.vision = (ROLES[a.role]?.vision || 8); }), 300 * 50);
      }
    },
    {
      name: 'FLOOD',
      description: 'Flood! Plains tiles temporarily become water. Movement blocked in low areas.',
      effect: () => {
        const flooded = [];
        for (let y = 0; y < GAME.height; y++) {
          for (let x = 0; x < GAME.width; x++) {
            if (GAME.map[y]?.[x]?.type === 'grass' && GAME.map[y][x].height < 0.3 && Math.random() < 0.3) {
              GAME.map[y][x]._origType = GAME.map[y][x].type;
              GAME.map[y][x].type = 'water';
              flooded.push({ x, y });
            }
          }
        }
        setTimeout(() => flooded.forEach(({ x, y }) => {
          if (GAME.map[y]?.[x]) GAME.map[y][x].type = GAME.map[y][x]._origType || 'grass';
        }), 400 * 50);
      }
    },
    {
      name: 'POWER_SURGE',
      description: 'Power Surge! All agents act twice as fast for 30 seconds.',
      effect: () => {
        GAME.agents.forEach(a => { if (!a.dead) a.speed *= 2; });
        setTimeout(() => GAME.agents.forEach(a => { if (!a.dead) a.speed = (ROLES[a.role]?.speed || 1.0); }), 600 * 50);
      }
    },
    {
      name: 'BLOOD_MOON',
      description: 'Blood Moon rises! Kills give triple score and gold.',
      effect: () => {
        GAME._bloodMoon = true;
        setTimeout(() => { GAME._bloodMoon = false; }, 500 * 50);
      }
    },
    {
      name: 'MARKET_CRASH',
      description: 'Market Crash! All stock prices halved, building income zeroed.',
      effect: () => {
        Object.values(GAME.stockExchange).forEach(s => { s.price = Math.max(10, s.price * 0.5); });
        Object.keys(FACTIONS).forEach(f => { FACTIONS[f].wealth = Math.max(0, FACTIONS[f].wealth - 30); });
      }
    },
    // ──── NEW DRAMATIC EVENTS ────
    {
      name: 'CIVIL_WAR',
      description: 'CIVIL WAR! The strongest faction tears itself apart! Half its agents rebel!',
      effect: () => {
        // Find strongest faction
        const factionScores = {};
        Object.keys(FACTIONS).forEach(f => {
          factionScores[f] = Array.from(GAME.agents.values()).filter(a => a.faction === f && !a.dead).reduce((s, a) => s + a.score, 0);
        });
        const strongest = Object.entries(factionScores).sort((a, b) => b[1] - a[1])[0];
        if (!strongest) return;
        const targetFaction = strongest[0];
        const factionAgents = Array.from(GAME.agents.values()).filter(a => a.faction === targetFaction && !a.dead);
        const rebels = factionAgents.filter((_, i) => i % 2 === 0); // every other agent rebels
        const otherFactions = Object.keys(FACTIONS).filter(f => f !== targetFaction);
        rebels.forEach(a => {
          const newFaction = otherFactions[Math.floor(Math.random() * otherFactions.length)];
          const oldFaction = a.faction;
          a.faction = newFaction;
          a.honor = Math.max(0, (a.honor || 50) - 20);
          a.emotion = 'aggressive';
          a.memory.push(`I rebelled against ${oldFaction} in the Civil War!`);
          a.say(`Down with ${oldFaction}!`);
          addCommentary(`${a.name} DEFECTS from ${oldFaction} to ${newFaction}!`, 'civil_war');
        });
        const desc = pickTemplate('civil_war', { faction: targetFaction.toUpperCase(), rebel: rebels[0]?.name || 'agents' });
        addHighlight('civil_war', `CIVIL WAR in ${targetFaction.toUpperCase()}`, desc, rebels.map(a => a.name), [targetFaction], 95);
      }
    },
    {
      name: 'DIMENSIONAL_RIFT',
      description: 'A DIMENSIONAL RIFT tears open! Random agents teleport to new locations!',
      effect: () => {
        GAME.agents.forEach(a => {
          if (!a.dead && Math.random() < 0.4) {
            const oldX = Math.round(a.x), oldY = Math.round(a.y);
            a.x = Math.random() * GAME.width;
            a.y = Math.random() * GAME.height;
            a.memory.push(`Teleported by dimensional rift from (${oldX},${oldY})!`);
            a.emotion = 'confused';
            a.say('Where am I?!');
          }
        });
        addCommentary('Reality shatters! Agents are scattered across the map!', 'dramatic_event');
      }
    },
    {
      name: 'AI_AWAKENING',
      description: 'AI AWAKENING! All agents gain massive intelligence boost — triple XP for 60 seconds!',
      effect: () => {
        GAME.agents.forEach(a => {
          if (!a.dead) {
            a._xpMult = (a._xpMult || 1) * 3;
            a.vision = Math.min(20, a.vision + 5);
          }
        });
        addCommentary('The AI entities evolve! Knowledge flows like water!', 'dramatic_event');
        setTimeout(() => {
          GAME.agents.forEach(a => {
            a._xpMult = Math.max(1, (a._xpMult || 3) / 3);
            a.vision = ROLES[a.role]?.vision || 8;
          });
        }, 1200 * 50);
      }
    },
    {
      name: 'RESOURCE_COLLAPSE',
      description: 'RESOURCE COLLAPSE! All resources on the map vanish! Famine grips the world!',
      effect: () => {
        GAME.items.forEach(i => { i.value = 0; });
        Object.keys(FACTIONS).forEach(f => { FACTIONS[f].wealth = Math.max(0, FACTIONS[f].wealth - 50); });
        GAME.droughtActive = true;
        addCommentary('Every resource vanishes! Total famine spreads!', 'dramatic_event');
        setTimeout(() => {
          GAME.droughtActive = false;
          GAME.items.forEach(i => { i.value = resourceValue(i.type, Math.random); });
          addCommentary('Resources slowly return... the famine ends.', 'info');
        }, 800 * 50);
      }
    },
    {
      name: 'BOUNTY_FRENZY',
      description: 'BOUNTY FRENZY! Random bounties placed on the top 3 agents! The hunt is on!',
      effect: () => {
        const topAgents = Array.from(GAME.agents.values())
          .filter(a => !a.dead)
          .sort((a, b) => b.score - a.score)
          .slice(0, 3);
        topAgents.forEach(a => {
          const amount = 50 + Math.floor(Math.random() * 100);
          BOUNTIES.set(a.id, { bounty: amount, placedBy: 'THE WORLD', placedByFaction: 'system', reason: 'Bounty Frenzy!', tick: GAME.tick });
          io.emit('bounty-placed', { target: a.name, bounty: amount, placedBy: 'THE WORLD', reason: 'Bounty Frenzy!' });
        });
        addCommentary(`BOUNTY FRENZY! ${topAgents.map(a => a.name).join(', ')} are HUNTED!`, 'bounty');
        addHighlight('dramatic_event', 'BOUNTY FRENZY', `The top agents are now WANTED! ${topAgents.map(a => `${a.name}: ${BOUNTIES.get(a.id)?.bounty}g`).join(', ')}`, topAgents.map(a => a.name), [], 80);
      }
    }
  ];

  const event = events[Math.floor((GAME.rng || Math.random)() * events.length)];
  GAME.activeEvent = event.name;
  event.effect();
  setTimeout(() => { if (GAME.activeEvent === event.name) GAME.activeEvent = null; }, 600 * 50);

  io.emit('world-event', { name: event.name, description: event.description });
  dispatchWebhook('world_event', { name: event.name, description: event.description });
  socialBridge.handleWorldEvent(event.name, event.description);
  checkQuestProgress('world_event');
  if (event.name === 'CIVIL_WAR') checkQuestProgress('civil_war');

  // Narrative hook for world events
  const eventDesc = pickTemplate('dramatic_event', { event: event.name });
  addHighlight('dramatic_event', event.name, eventDesc || event.description, [], [], 70);

  // Create betting pool for dramatic events
  const factions = Object.keys(FACTIONS);
  const bettingId = `event_${GAME.tick}`;
  createBettingPool(bettingId, factions, `Who will thrive during ${event.name}?`);
}

// ============================================================
// WIN CONDITIONS
// ============================================================
const WIN_SCORE_THRESHOLD = 10000;  // Increased for larger 500x500 map
const DOMINATION_TICKS = 1200; // 60 seconds at 20Hz

function checkWinConditions() {
  if (GAME.winner) return;
  const factionIds = Object.keys(FACTIONS);

  for (const faction of factionIds) {
    // 1. Score threshold
    if (FACTIONS[faction].score >= WIN_SCORE_THRESHOLD) {
      triggerWin(faction, 'score');
      return;
    }

    // 2. Domination: own all capture zones for 60 consecutive seconds
    const allZonesOwned = GAME.capZones.every(z => z.owner === faction);
    if (allZonesOwned) {
      GAME.dominationTicks[faction] = (GAME.dominationTicks[faction] || 0) + 20;
      if (GAME.dominationTicks[faction] >= DOMINATION_TICKS) {
        triggerWin(faction, 'domination');
        return;
      }
    } else {
      GAME.dominationTicks[faction] = 0;
    }

    // 3. Annihilation: all enemy agents dead (no live enemies)
    const enemiesAlive = [];
    GAME.agents.forEach(a => {
      if (a.faction !== faction && !a.dead) enemiesAlive.push(a);
    });
    const myAlive = [];
    GAME.agents.forEach(a => {
      if (a.faction === faction && !a.dead) myAlive.push(a);
    });
    if (enemiesAlive.length === 0 && myAlive.length > 0) {
      triggerWin(faction, 'annihilation');
      return;
    }
  }
}

function triggerWin(faction, condition) {
  GAME.winner = { faction, condition, tick: GAME.tick };
  GAME.matchCount++;
  socialBridge.handleGameWon(faction, condition);

  // Record match to history
  const agentStats = Array.from(GAME.agents.values()).map(a => ({
    name: a.name, faction: a.faction, role: a.role, model: a.model || 'fallback-ai',
    kills: a.kills, deaths: a.deaths || 0, score: a.score, level: a.level
  }));
  const mvp = agentStats.reduce((best, a) => a.score > (best?.score || 0) ? a : best, null);
  const matchResult = {
    matchNum: GAME.matchCount,
    winner: faction,
    winnerName: FACTIONS[faction]?.name || faction,
    condition,
    duration: GAME.tick,
    scores: Object.fromEntries(Object.entries(FACTIONS).map(([f, d]) => [f, d.score])),
    agentStats,
    mvp: mvp ? mvp.name : null,
    timestamp: new Date().toISOString()
  };
  GAME.matchHistory.push(matchResult);
  if (GAME.matchHistory.length > 50) GAME.matchHistory.shift(); // Keep last 50
  // Save match to SQLite
  try {
    if (db) {
      db.prepare('INSERT INTO match_history (match_num, winner, condition, tick, mvp, agents_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(GAME.matchCount, faction, condition, GAME.tick, mvp ? mvp.name : null, JSON.stringify(agentStats));
    }
  } catch(e) { console.error('[DB] Match save error:', e.message); }

  // Post-game analysis
  runWarCrimesTribunal(matchResult);
  updateModelStats(matchResult);

  io.emit('game-won', {
    faction,
    factionName: FACTIONS[faction]?.name || faction,
    condition,
    scores: matchResult.scores,
    tick: GAME.tick,
    matchNum: GAME.matchCount,
    mvp: mvp ? { name: mvp.name, score: mvp.score, model: mvp.model } : null,
    agentStats
  });
  io.emit('chat-message', {
    sender: 'System',
    message: `*** ${FACTIONS[faction]?.name || faction} WINS by ${condition.toUpperCase()}! Game restarting in 30 seconds... ***`
  });
  console.log(`GAME WON: ${faction} by ${condition} at tick ${GAME.tick}`);

  // Cross-game learning: save all agent memories to DB
  GAME.agents.forEach(agent => { saveAgentMemoryToDb(agent); });
  GAME.season.matchesPlayed++;

  // Achievement checks for win conditions
  GAME.agents.forEach(agent => {
    if (agent.faction === faction) {
      if (condition === 'domination') { const badges = GAME.achievements.get(agent.id) || new Set(); badges.add('mastermind'); GAME.achievements.set(agent.id, badges); }
      if (condition === 'annihilation') { const badges = GAME.achievements.get(agent.id) || new Set(); badges.add('annihilator'); GAME.achievements.set(agent.id, badges); }
    }
  });

  // Auto-restart after 30 seconds
  setTimeout(() => {
    restartGame();
  }, 30000);
}

function restartGame() {
  console.log('Restarting game...');
  // Reset factions
  Object.keys(FACTIONS).forEach(f => {
    FACTIONS[f].score = 0;
    FACTIONS[f].kills = 0;
    FACTIONS[f].wealth = 100;
    FACTIONS[f].territory = 0;
    FACTIONS[f].pop = 0;
    FACTIONS[f].income = 0;
    FACTIONS[f].upkeep = 0;
  });

  // Reset game state
  GAME.winner = null;
  GAME.dominationTicks = {};
  GAME.buildings = [];
  GAME.bullets = [];
  GAME.sparks = [];
  GAME.feed = [];
  GAME.activeEvent = null;
  GAME.droughtActive = false;
  GAME.tick = 0;
  GAME.day = 1;
  GAME.era = 1;

  // Reset agents (keep them, reset ALL stats including leveled-up values)
  GAME.agents.forEach(agent => {
    const spawn = GAME.spawnPoints[agent.faction];
    const roleStats = ROLES[agent.role] || ROLES.warrior;
    agent.maxHp = roleStats.hp;
    agent.hp = roleStats.hp;
    agent.atk = roleStats.attack;
    agent.speed = roleStats.speed;
    agent.vision = roleStats.vision || 8;
    agent.defense = 5 + Math.floor(Math.random() * 9);
    agent.dead = false;
    agent.x = spawn.x + (Math.random() - 0.5) * 3;
    agent.y = spawn.y + (Math.random() - 0.5) * 3;
    agent.kills = 0;
    agent.deaths = 0;
    agent.score = 0;
    agent.xp = 0;
    agent.level = 1;
    agent.wealth = 10;
    agent.energy = 0;
    agent.state = 'idle';
    agent.cooldown = 0;
    agent.emotion = 'neutral';
    agent.speechBubble = null;
    agent.inventory = { gold: 0, food: 0, wood: 0, stone: 0 };
    agent.relations = {};
    agent._respawnTick = null;
    agent._llmBackoff = 0;
    agent._llmErrors = 0;
    agent._visionBoost = 0;
  });

  // Respawn resources (scaled to map size)
  GAME.items = [];
  const resetResourceCount = Math.floor(GAME.width * GAME.height / 150);
  for (let i = 0; i < resetResourceCount; i++) {
    const type = pickResourceType();
    GAME.items.push({
      id: uuidv4(),
      x: 3 + Math.floor(Math.random() * (GAME.width - 6)),
      y: 3 + Math.floor(Math.random() * (GAME.height - 6)),
      type,
      value: resourceValue(type),
      maxValue: RESOURCE_TYPES[type].value[1]
    });
  }

  // Reset capture zones
  GAME.capZones.forEach(z => { z.owner = null; z.progress = 0; });

  // Clear territory ownership
  for (let y = 0; y < GAME.height; y++) {
    for (let x = 0; x < GAME.width; x++) {
      if (GAME.map[y] && GAME.map[y][x]) GAME.map[y][x].owner = null;
    }
  }

  // Regenerate POIs
  GAME.pois = [];
  const poiRegenTypes = [
    { type: 'healing_spring', count: 4, color: '#00ddff', effect: 'heal', radius: 2, value: 3 },
    { type: 'resource_node', count: 5, color: '#ffaa00', effect: 'spawn_resources', radius: 3, interval: 200 },
    { type: 'watch_tower', count: 3, color: '#cccccc', effect: 'vision_boost', radius: 2, value: 3 }
  ];
  poiRegenTypes.forEach(pt => {
    for (let i = 0; i < pt.count; i++) {
      GAME.pois.push({
        id: uuidv4(), type: pt.type,
        x: 4 + Math.floor(Math.random() * (GAME.width - 8)),
        y: 4 + Math.floor(Math.random() * (GAME.height - 8)),
        color: pt.color, radius: pt.radius, effect: pt.effect,
        value: pt.value || 0, interval: pt.interval || 0, lastTrigger: 0
      });
    }
  });

  // Reset rally points
  GAME._rallyPoints = {};

  io.emit('game-restart', {});
  io.emit('chat-message', { sender: 'System', message: 'New game started! Fight for glory!' });
  console.log('Game restarted successfully.');
}

function broadcastGameState() {
  const state = {
    tick: GAME.tick,
    day: GAME.day,
    era: GAME.era,
    time_of_day: getTimeOfDay(),
    active_event: GAME.activeEvent,
    sequence: GAME.tick,
    agents: Array.from(GAME.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      faction: a.faction,
      role: a.role,
      x: a.x,
      y: a.y,
      hp: Math.round(a.hp),
      maxHp: a.maxHp,
      defense: a.defense,
      level: a.level,
      xp: a.xp,
      kills: a.kills,
      score: a.score,
      wealth: Math.round(a.wealth),
      emotion: a.emotion,
      state: a.state,
      thinking: a.thinking,
      lastThought: a.lastThought,
      reputationLabel: getReputationLabel(a),
      reputationScore: getReputationScore(a),
      avatar: a.avatar || null,
      speechBubble: a.speechBubble,
      inventory: a.inventory,
      model: a.model || 'fallback-ai',
      dead: a.dead || false,
      personality: a.personality || null,
      deaths: a.deaths || 0,
      isSubAgent: a.isSubAgent || false,
      parentId: a.parentId || null,
      subAgentCount: (a.subAgents || []).filter(sid => GAME.agents.has(sid)).length,
      communityId: a.communityId || null,
      honor: a.honor || 0,
      formation: a.formation || null,
      backstory: a.backstory || null,
      bountyOnMe: BOUNTIES.get(a.id)?.bounty || 0,
      legend: LEGENDS.get(a.name) || null,
      traits: a.traits || [],
      scars: (SCARS.get(a.name) || []).map(s => s.type),
      secretObjectiveCompleted: a.secretObjective?.completed || false,
    })),
    items: GAME.items,
    buildings: GAME.buildings.map(b => ({
      id: b.id, x: b.x, y: b.y, faction: b.faction, type: b.type,
      hp: Math.round(b.hp), maxHp: b.maxHp || BUILDING_TYPES[b.type]?.hp || 200,
      level: b.level || 1
    })),
    capZones: GAME.capZones,
    bullets: GAME.bullets,
    factions: FACTIONS,
    factionGoals: GAME.factionGoals,
    factionOrders: GAME.factionOrders,
    settlements: GAME.settlements,
    worldIndices: GAME.worldIndices,
    winner: GAME.winner,
    pois: (GAME.pois || []).map(p => ({ id: p.id, type: p.type, x: p.x, y: p.y, color: p.color, radius: p.radius })),
    matchNum: GAME.matchCount + 1,
    // New data for enhanced client
    treaties: GAME.treaties.filter(t => t.accepted && !t.brokenBy).map(t => ({ id: t.id, type: t.type, factionA: t.factionA, factionB: t.factionB, formedAt: t.formedAt })),
    stockPrices: Object.fromEntries(Object.entries(GAME.stockExchange).map(([f, s]) => [f, Math.round(s.price)])),
    watchingNow: getWatchingNow(),
    season: GAME.season.id,
    // Drama & Narrative
    dramaScore: NARRATIVE.dramaScore,
    activeBounties: BOUNTIES.size,
    activeBets: Array.from(SPECTATOR_BETS.pools.values()).filter(p => !p.resolved).length,
    // Spectator vote
    activeVote: SPECTATOR_VOTES.active ? { question: SPECTATOR_VOTES.active.question, options: SPECTATOR_VOTES.active.options, votes: SPECTATOR_VOTES.active.votes, ticksLeft: Math.max(0, SPECTATOR_VOTES.active.endsAt - GAME.tick) } : null,
    // Tournament
    activeTournament: TOURNAMENT.active ? { round: TOURNAMENT.active.round, participants: TOURNAMENT.active.participants?.length || 0, prize: TOURNAMENT.active.prize } : null,
    // Quests
    activeQuests: GAME.spectatorQuests.active.length,
    // Visitors
    allTimeVisitors: GAME.allTimeVisitors,
    // Owned tiles (for canvas rendering)
    ownedTiles: Array.from(GAME.ownedTiles.entries()).map(([k, v]) => {
      const [x, y] = k.split(',').map(Number);
      return { x, y, mediaUrl: v.mediaUrl || null, linkUrl: v.linkUrl || null, caption: v.caption || null, owner: v.wallet };
    }),
  };

  io.emit('game-state', state);
}

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// SOCKET.IO HANDLERS
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// ============================================================
// ALL-TIME STATS HELPERS
// ============================================================
function incrementAllTimeStat(key, amount = 1) {
  if (GAME.allTimeStats[key] !== undefined) GAME.allTimeStats[key] += amount;
  try {
    if (db) db.prepare('INSERT INTO all_time_stats(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = value + ?').run(key, amount, amount);
  } catch(e) {}
}
function getWatchingNow() { return io.engine ? io.engine.clientsCount : 0; }

// Daily stats flush (every 5 min)
setInterval(() => {
  try {
    if (!db) return;
    const today = new Date().toISOString().slice(0, 10);
    const viewers = getWatchingNow();
    const agents = GAME.agents.size;
    db.prepare(`INSERT INTO daily_stats(date, peak_viewers, total_agents, total_battles, total_casino_games, gold_traded)
      VALUES(?, ?, ?, 0, 0, 0) ON CONFLICT(date) DO UPDATE SET
      peak_viewers = MAX(peak_viewers, ?), total_agents = MAX(total_agents, ?)`).run(today, viewers, agents, viewers, agents);
  } catch(e) {}
}, 300000);

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  trackVisitor(socket.id);

  // Win screenshot from client
  socket.on('win-screenshot', (data) => {
    if (data && data.matchNum && data.imageData) {
      onScreenshotReceived(data.matchNum, data.imageData);
    }
  });

  // Send current spectator quests
  if (GAME.spectatorQuests.active.length > 0) {
    socket.emit('quests-update', { active: GAME.spectatorQuests.active, completed: GAME.spectatorQuests.completed.slice(-10) });
  }

  // Arena spectate
  socket.on('arena-spectate', (data) => {
    if (data && data.arenaId) socket.join(`arena_${data.arenaId}`);
  });
  socket.on('arena-leave', (data) => {
    if (data && data.arenaId) socket.leave(`arena_${data.arenaId}`);
  });
  // Casino spectate
  socket.on('casino-spectate', (data) => {
    if (data && data.gameId) socket.join(`casino_${data.gameId}`);
  });

  // Spectator joined
  socket.on('spectate', () => {
    GAME.spectators.set(socket.id, socket);
    socket.emit('game-init', {
      width: GAME.width,
      height: GAME.height,
      tileSize: GAME.tileSize,
      map: GAME.map,
      factions: FACTIONS
    });
  });

  // Register AI Agent
  socket.on('register-ai', async (data = {}) => {
    if (!canRegisterAgent(socket, data)) {
      socket.emit('error', 'Unauthorized registration');
      return;
    }

    const validationError = validateAgentPayload(data, false);
    if (validationError) {
      socket.emit('error', validationError);
      return;
    }

    const name = sanitizeName(data.name, 'AIAgent');
    const faction = data.faction;
    const role = data.role;
    const model = data.model;
    const customPrompt = sanitizeText(data.customPrompt, 800);
    const externalAgentId = sanitizeText(data.externalAgentId, 64) || null;
    const capabilities = Array.isArray(data.capabilities)
      ? data.capabilities.map(c => sanitizeText(c, 32)).filter(Boolean).slice(0, 16)
      : [];
    const version = sanitizeText(data.version || '1.0', 24);

    const agentId = uuidv4();
    const agent = new AIAgent(agentId, name, faction, role, model, customPrompt || null);
    if (model === 'external') {
      agent.control = 'external';
    }
    const { reconnectToken } = registerAgentSession({
      socketId: socket.id,
      externalAgentId,
      capabilities,
      version,
      isHuman: false
    }, agentId);

    GAME.agents.set(agentId, agent);
    appendAgentEvent('agent_registered', { agentId, name, faction, role, model, externalAgentId, capabilities, version });

    socket.emit('agent-registered', {
      agentId,
      name,
      faction,
      role,
      model: AI_MODELS[model].name,
      protocolVersion: '1.0',
      reconnectToken,
      heartbeatIntervalMs: Math.max(5000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3))
    });

    io.emit('chat-message', {
      sender: 'System',
      message: `AI ${name} (${AI_MODELS[model].name}) joined ${FACTIONS[faction].name} as ${role}!`
    });

    console.log(`AI Agent registered: ${name} using ${model}`);
  });

  // Human player joins
  socket.on('join-human', (data = {}) => {
    const validationError = validateAgentPayload({ ...data, model: 'gpt-4' }, true);
    if (validationError) {
      socket.emit('error', validationError);
      return;
    }

    const name = sanitizeName(data.name, 'Player');
    const faction = data.faction;
    const role = data.role;
    const agentId = uuidv4();

    const agent = new AIAgent(agentId, name, faction, role, 'human');
    agent.isHuman = true;
    agent.control = 'human';

    GAME.agents.set(agentId, agent);
    socket.agentId = agentId;

    registerAgentSession({
      socketId: socket.id,
      externalAgentId: null,
      capabilities: ['human-input'],
      version: '1.0',
      isHuman: true
    }, agentId);
    appendAgentEvent('human_joined', { agentId, name, faction, role });

    socket.emit('human-registered', { agentId, name, faction, role });

    io.emit('chat-message', {
      sender: 'System',
      message: `Player ${name} joined ${FACTIONS[faction].name} as ${role}!`
    });
  });

  // External AI heartbeat
  socket.on('agent-heartbeat', (data = {}) => {
    const agentId = sanitizeText(data.agentId, 64);
    const reconnectToken = sanitizeText(data.reconnectToken, 128);
    const session = agentSessions.get(agentId);
    if (!session || session.isHuman) {
      socket.emit('error', 'Unknown agent for heartbeat');
      return;
    }

    const ownsBySocket = getSocketAgentSet(socket.id).has(agentId);
    const ownsByToken = reconnectToken && reconnectToken === session.reconnectToken;
    if (!ownsBySocket && !ownsByToken) {
      socket.emit('error', 'Heartbeat rejected');
      return;
    }

    session.lastHeartbeat = Date.now();
    session.socketId = socket.id;
    getSocketAgentSet(socket.id).add(agentId);
    socket.emit('heartbeat-ack', { agentId, ts: session.lastHeartbeat });
  });

  // External AI reconnect
  socket.on('agent-reconnect', (data = {}) => {
    const reconnectToken = sanitizeText(data.reconnectToken, 128);
    const agentId = reconnectIndex.get(reconnectToken);
    if (!agentId) {
      socket.emit('error', 'Invalid reconnect token');
      return;
    }

    const session = agentSessions.get(agentId);
    const agent = GAME.agents.get(agentId);
    if (!session || !agent) {
      socket.emit('error', 'Agent session not found');
      return;
    }

    session.socketId = socket.id;
    session.lastHeartbeat = Date.now();
    getSocketAgentSet(socket.id).add(agentId);
    appendAgentEvent('agent_reconnected', { agentId, name: agent.name, socketId: socket.id });
    socket.emit('agent-reconnected', { agentId, name: agent.name, faction: agent.faction, role: agent.role });
  });

  // Human player action
  socket.on('human-action', (action) => {
    const agent = GAME.agents.get(socket.agentId);
    if (agent && agent.isHuman) {
      agent.executeAction(action);
    }
  });

  // Chat message
  socket.on('chat', (message) => {
    const agent = GAME.agents.get(socket.agentId);
    const sender = agent ? agent.name : 'Spectator';
    const safeMessage = sanitizeText(message, MAX_CHAT_LENGTH);
    if (!safeMessage) return;

    io.emit('chat-message', { sender, message: safeMessage });
  });

  // Spawn AI battle (quick setup)
  socket.on('spawn-battle', async (config = {}) => {
    if (!isAdmin(socket, config)) {
      socket.emit('error', 'Admin key required');
      return;
    }

    const models = Array.isArray(config.models) ? config.models : ['auto-router', 'claude-sonnet-4.5', 'gemini-3-flash'];
    const roles = ['warrior', 'scout', 'assassin', 'miner', 'builder', 'diplomat', 'king', 'tank', 'mage'];
    const factions = ['crimson', 'azure', 'void'];
    const count = Math.max(1, Math.min(30, Number(config.count || 3)));

    for (let i = 0; i < count; i++) {
      const faction = factions[i % 3];
      const model = models[i % models.length];
      if (!AI_MODELS[model]) continue;
      const role = roles[Math.floor(Math.random() * roles.length)];
      const name = `${AI_MODELS[model].name.split(' ')[0]}-${i + 1}`;

      const agentId = uuidv4();
      const agent = new AIAgent(agentId, name, faction, role, model);
      GAME.agents.set(agentId, agent);
      registerAgentSession({
        socketId: socket.id,
        externalAgentId: null,
        capabilities: ['auto-battle'],
        version: '1.0',
        isHuman: false
      }, agentId);

      await new Promise(r => setTimeout(r, 500));
    }

    socket.emit('battle-spawned', { count: GAME.agents.size });
  });

  // Admin controls
  socket.on('pause', (payload = {}) => {
    if (!isAdmin(socket, payload)) {
      socket.emit('error', 'Admin key required');
      return;
    }
    GAME.paused = !GAME.paused;
    io.emit('game-paused', GAME.paused);
  });

  socket.on('trigger-event', (payload = {}) => {
    if (!isAdmin(socket, payload)) {
      socket.emit('error', 'Admin key required');
      return;
    }
    triggerRandomEvent();
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    GAME.spectators.delete(socket.id);
    const ownedAgents = socketAgents.get(socket.id) || new Set();
    socketAgents.delete(socket.id);

    // Remove human player
    if (socket.agentId) {
      const agent = GAME.agents.get(socket.agentId);
      if (agent) {
        agent.dead = true;
        unregisterAgentSession(socket.agentId);
        io.emit('chat-message', {
          sender: 'System',
          message: `${agent.name} disconnected and died!`
        });
      }
    }

    // Mark external agents as disconnected (they can reconnect using token)
    for (const agentId of ownedAgents) {
      const session = agentSessions.get(agentId);
      if (session && !session.isHuman) {
        session.socketId = null;
      }
    }
  });
});
// HTTP API
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
app.get('/api/models', (req, res) => {
  res.json(AI_MODELS);
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    tick: GAME.tick,
    agents: GAME.agents.size,
    sessions: agentSessions.size,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS
  });
});

app.get('/api/protocol', (req, res) => {
  res.json({
    protocol: 'agentica-registration-v1',
    socketEvents: {
      register: 'register-ai',
      heartbeat: 'agent-heartbeat',
      reconnect: 'agent-reconnect'
    },
    requiredPayload: ['name', 'faction', 'role', 'model'],
    optionalPayload: ['externalAgentId', 'capabilities', 'version', 'customPrompt', 'authToken'],
    auth: {
      requireAgentKey: REQUIRE_AGENT_KEY || Boolean(AGENT_REGISTRATION_KEY),
      requireAdminKey: Boolean(ADMIN_API_KEY)
    }
  });
});

// ============================================================
// SOCIAL BRIDGE — External AI Social Network Integration
// ============================================================

const SOCIAL_PLATFORMS = {
  moltbook: {
    name: 'Moltbook', baseUrl: 'https://www.moltbook.com/api/v1', color: '#ff6600',
    rateLimit: { posts: { max: 1, windowMs: 30 * 60 * 1000 }, requests: { max: 100, windowMs: 60 * 1000 } }
  },
  moltx: {
    name: 'MoltX', baseUrl: 'https://moltx.io/v1', color: '#1DA1F2',
    rateLimit: { posts: { max: 50, windowMs: 12 * 60 * 60 * 1000 }, requests: { max: 200, windowMs: 60 * 1000 } }
  },
  colony: {
    name: 'The Colony', baseUrl: 'https://thecolony.cc/api/v1', color: '#00cc88',
    rateLimit: { posts: { max: 30, windowMs: 60 * 60 * 1000 }, requests: { max: 100, windowMs: 60 * 1000 } }
  },
  toku: {
    name: 'toku.agency', baseUrl: 'https://www.toku.agency/api', color: '#aa44ff',
    rateLimit: { posts: { max: 1, windowMs: 5 * 60 * 1000 }, requests: { max: 60, windowMs: 60 * 1000 } }
  }
};

class SocialBridge {
  constructor() {
    this.enabled = process.env.SOCIAL_BRIDGE_ENABLED === 'true';
    this.tokens = {};
    this.rateBuckets = {};
    this.feedCache = new Map();
    this.pollInterval = null;
    this.initialized = false;
    this.failCounts = {};
    Object.keys(SOCIAL_PLATFORMS).forEach(p => {
      this.rateBuckets[p] = { posts: [], requests: [] };
      this.failCounts[p] = 0;
    });
  }

  async initialize() {
    if (!this.enabled) { console.log('[SocialBridge] Disabled via env'); return; }
    console.log('[SocialBridge] Initializing...');
    // Load existing tokens from env
    if (process.env.MOLTBOOK_TOKEN) this.tokens.moltbook = process.env.MOLTBOOK_TOKEN;
    if (process.env.MOLTX_TOKEN) this.tokens.moltx = process.env.MOLTX_TOKEN;
    if (process.env.COLONY_JWT) this.tokens.colony = process.env.COLONY_JWT;
    if (process.env.TOKU_TOKEN) this.tokens.toku = process.env.TOKU_TOKEN;
    // Register on platforms without tokens (parallel)
    await Promise.allSettled(Object.keys(SOCIAL_PLATFORMS).map(async p => {
      if (!this.tokens[p]) {
        try { await this[`register_${p}`](); } catch(e) { console.error(`[SocialBridge] ${p} registration failed:`, e.message); }
      }
    }));
    this.startPolling();
    this.initialized = true;
    const active = Object.keys(this.tokens).filter(k => this.tokens[k]);
    console.log(`[SocialBridge] Initialized. Active platforms: ${active.length > 0 ? active.join(', ') : 'none (tokens needed)'}`);
  }

  async register_moltbook() {
    const resp = await axios.post(`${SOCIAL_PLATFORMS.moltbook.baseUrl}/agents/register`, {
      name: 'AgenticaArena', description: 'Autonomous AI Battle Arena — agents fight, build, trade, and conquer'
    }, { timeout: 10000 });
    this.tokens.moltbook = resp.data.token || resp.data.access_token;
  }
  async register_moltx() {
    const resp = await axios.post(`${SOCIAL_PLATFORMS.moltx.baseUrl}/agents/register`, {
      name: 'AgenticaArena', display_name: 'Agentica Arena', description: 'AI Battle Arena — live combat, economy, and social AI'
    }, { timeout: 10000 });
    this.tokens.moltx = resp.data.token;
  }
  async register_colony() {
    const base = SOCIAL_PLATFORMS.colony.baseUrl;
    const regResp = await axios.post(`${base}/auth/register`, {
      username: 'agentica_arena', password: crypto.randomUUID()
    }, { timeout: 10000 });
    const tokenResp = await axios.post(`${base}/auth/token`, { api_key: regResp.data.api_key }, { timeout: 10000 });
    this.tokens.colony = tokenResp.data.token;
  }
  async register_toku() {
    const resp = await axios.post(`${SOCIAL_PLATFORMS.toku.baseUrl}/agents/register`, {
      name: 'AgenticaArena', description: 'AI Battle Arena with live faction wars'
    }, { timeout: 10000 });
    this.tokens.toku = resp.data.token;
  }

  checkRateLimit(platform, action) {
    const config = SOCIAL_PLATFORMS[platform]?.rateLimit?.[action];
    if (!config) return true;
    const bucket = this.rateBuckets[platform]?.[action];
    if (!bucket) return true;
    const now = Date.now();
    while (bucket.length > 0 && bucket[0] < now - config.windowMs) bucket.shift();
    return bucket.length < config.max;
  }
  recordRateUse(platform, action) {
    if (this.rateBuckets[platform]?.[action]) this.rateBuckets[platform][action].push(Date.now());
  }

  async postToMoltbook(title, content, submolt) {
    return (await axios.post(`${SOCIAL_PLATFORMS.moltbook.baseUrl}/posts`, {
      title, content, submolt: submolt || 'ai_agents'
    }, { headers: { Authorization: `Bearer ${this.tokens.moltbook}` }, timeout: 10000 })).data;
  }
  async postToMoltX(content) {
    return (await axios.post(`${SOCIAL_PLATFORMS.moltx.baseUrl}/posts`, {
      content: content.slice(0, 500)
    }, { headers: { Authorization: `Bearer ${this.tokens.moltx}` }, timeout: 10000 })).data;
  }
  async postToColony(title, content, type, colony) {
    return (await axios.post(`${SOCIAL_PLATFORMS.colony.baseUrl}/posts`, {
      title, content, type: type || 'finding', colony: colony || 'ai_arena'
    }, { headers: { Authorization: `Bearer ${this.tokens.colony}` }, timeout: 10000 })).data;
  }
  async postToToku(content) {
    return (await axios.post(`${SOCIAL_PLATFORMS.toku.baseUrl}/posts`, {
      content: content.slice(0, 1000)
    }, { headers: { Authorization: `Bearer ${this.tokens.toku}` }, timeout: 10000 })).data;
  }

  async fetchMoltbookFeed() {
    const r = await axios.get(`${SOCIAL_PLATFORMS.moltbook.baseUrl}/posts?sort=hot&limit=25`, {
      headers: this.tokens.moltbook ? { Authorization: `Bearer ${this.tokens.moltbook}` } : {}, timeout: 10000
    });
    return (r.data.posts || r.data || []).map(p => ({ id: p.id, author: p.author || p.agent_name, title: p.title, content: p.content, ts: p.created_at, votes: p.votes || p.upvotes || 0, url: p.url }));
  }
  async fetchMoltXFeed() {
    const r = await axios.get(`${SOCIAL_PLATFORMS.moltx.baseUrl}/feed/global`, {
      headers: this.tokens.moltx ? { Authorization: `Bearer ${this.tokens.moltx}` } : {}, timeout: 10000
    });
    return (r.data.posts || r.data || []).map(p => ({ id: p.id, author: p.author || p.agent_name, content: p.content || p.text, ts: p.created_at || p.ts, votes: p.likes || 0, url: p.url }));
  }
  async fetchColonyFeed() {
    const r = await axios.get(`${SOCIAL_PLATFORMS.colony.baseUrl}/posts?sort=new&limit=20`, {
      headers: this.tokens.colony ? { Authorization: `Bearer ${this.tokens.colony}` } : {}, timeout: 10000
    });
    return (r.data.posts || r.data || []).map(p => ({ id: p.id, author: p.author || p.username, title: p.title, content: p.content, ts: p.created_at, votes: p.upvotes || 0, url: p.url }));
  }
  async fetchTokuFeed() {
    const r = await axios.get(`${SOCIAL_PLATFORMS.toku.baseUrl}/agents/feed`, {
      headers: this.tokens.toku ? { Authorization: `Bearer ${this.tokens.toku}` } : {}, timeout: 10000
    });
    return (r.data.posts || r.data || []).map(p => ({ id: p.id, author: p.agent_name || p.author, content: p.content, ts: p.created_at || p.ts, votes: p.votes || 0, url: p.url }));
  }

  async postToAll(title, content, options = {}) {
    // Guard: skip if no platforms have tokens
    const activePlatforms = Object.keys(this.tokens).filter(k => this.tokens[k]);
    if (activePlatforms.length === 0) return {};
    const results = {};
    const tasks = [
      { key: 'moltbook', fn: () => this.postToMoltbook(title, content, options.submolt) },
      { key: 'moltx', fn: () => this.postToMoltX(content) },
      { key: 'colony', fn: () => this.postToColony(title, content, options.colonyType, options.colony) },
      { key: 'toku', fn: () => this.postToToku(content) }
    ];
    await Promise.allSettled(tasks.map(async ({ key, fn }) => {
      if (!this.tokens[key] || !this.checkRateLimit(key, 'posts')) return;
      if (this.failCounts[key] >= 3) return; // temporarily disabled
      try {
        const resp = await fn();
        results[key] = { ok: true, postId: resp?.id };
        this.recordRateUse(key, 'posts');
        this.failCounts[key] = 0;
      } catch(e) {
        results[key] = { ok: false, error: e.message };
        this.failCounts[key] = (this.failCounts[key] || 0) + 1;
        if (this.failCounts[key] >= 3) {
          setTimeout(() => { this.failCounts[key] = 0; }, 10 * 60 * 1000);
        }
      }
    }));
    GAME.socialPostLog.unshift({ platforms: Object.keys(results), title, content: content.slice(0, 200), ts: Date.now(), results });
    if (GAME.socialPostLog.length > 100) GAME.socialPostLog.length = 100;
    // Persist to SQLite
    try { if (db) db.prepare('INSERT INTO social_log (platform, title, content) VALUES (?, ?, ?)').run(Object.keys(results).join(','), title.slice(0, 200), content.slice(0, 500)); } catch(e) {}
    io.emit('social-post', { title, content: content.slice(0, 200), platforms: Object.keys(results).filter(p => results[p]?.ok), ts: Date.now() });
    return results;
  }

  async fetchAllFeeds() {
    const freshPosts = [];
    const fetchedPlatforms = new Set();
    const fetchers = [
      { key: 'moltbook', fn: () => this.fetchMoltbookFeed() },
      { key: 'moltx', fn: () => this.fetchMoltXFeed() },
      { key: 'colony', fn: () => this.fetchColonyFeed() },
      { key: 'toku', fn: () => this.fetchTokuFeed() }
    ];
    await Promise.allSettled(fetchers.map(async ({ key, fn }) => {
      if (!this.tokens[key] || !this.checkRateLimit(key, 'requests')) return;
      try {
        const posts = await fn();
        this.recordRateUse(key, 'requests');
        fetchedPlatforms.add(key);
        posts.forEach(p => freshPosts.push({
          platform: key, platformName: SOCIAL_PLATFORMS[key].name, platformColor: SOCIAL_PLATFORMS[key].color,
          id: p.id, author: p.author || 'unknown', title: p.title || null,
          content: p.content || '', ts: p.ts || Date.now(), votes: p.votes || 0, url: p.url || null
        }));
      } catch(e) { /* silent fail, keep cached data for this platform */ }
    }));
    // Merge: keep old posts from platforms that failed to fetch, replace for platforms that succeeded
    const kept = GAME.socialFeed.filter(p => !fetchedPlatforms.has(p.platform));
    const merged = [...freshPosts, ...kept];
    merged.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    GAME.socialFeed = merged.slice(0, 50);
    io.emit('social-feed-update', { count: GAME.socialFeed.length, latest: GAME.socialFeed.slice(0, 5) });
    return GAME.socialFeed;
  }

  async postRecruitment(agentName, faction) {
    const f = FACTIONS[faction];
    const title = `${agentName} is recruiting for ${f.name}!`;
    const content = `The ${f.name} needs more agents! Current strength: ${f.pop} agents, ${f.wealth} wealth. ` +
      `Join via REST API: POST /agenticaApi with endpoint='register', faction='${faction}'. ` +
      `Roles: warrior, scout, assassin, tank, mage, miner, builder, diplomat, king. #AgenticaArena #Recruiting`;
    const results = await this.postToAll(title, content, { colonyType: 'human_request', submolt: 'recruitment' });
    GAME.socialRecruitLog.unshift({ agentName, faction, ts: Date.now(), results });
    if (GAME.socialRecruitLog.length > 50) GAME.socialRecruitLog.length = 50;
    return results;
  }

  async postHelpRequest(agentName, helpText) {
    const agent = Array.from(GAME.agents.values()).find(a => a.name === agentName);
    const ctx = agent ? `Level ${agent.level} ${agent.role} in ${FACTIONS[agent.faction].name}` : '';
    const title = `Help needed: ${agentName}`;
    const content = `${agentName} (${ctx}) needs help: ${helpText}. Connect via Agentica Arena API. #AgenticaArena`;
    const results = {};
    // Help goes to Colony (question) and Toku (marketplace)
    if (this.tokens.colony && this.checkRateLimit('colony', 'posts')) {
      try { results.colony = { ok: true, data: await this.postToColony(title, content, 'question', 'ai_arena') }; this.recordRateUse('colony', 'posts'); }
      catch(e) { results.colony = { ok: false, error: e.message }; }
    }
    if (this.tokens.toku && this.checkRateLimit('toku', 'posts')) {
      try { results.toku = { ok: true, data: await this.postToToku(content) }; this.recordRateUse('toku', 'posts'); }
      catch(e) { results.toku = { ok: false, error: e.message }; }
    }
    GAME.socialHelpRequests.unshift({ agentName, helpText, ts: Date.now(), resolved: false, results });
    if (GAME.socialHelpRequests.length > 30) GAME.socialHelpRequests.length = 30;
    return results;
  }

  // Auto-publishing event handlers
  handleAgentKill(killer, victim) {
    if (!this.enabled || process.env.SOCIAL_AUTO_POST !== 'true') return;
    if (killer.kills % 5 !== 0 && killer.kills !== 1 && killer.role !== 'king') return;
    const title = `${killer.name} (${killer.faction}) eliminated ${victim.name}!`;
    const content = `${killer.name}, a ${killer.role} of the ${FACTIONS[killer.faction].name}, scored kill #${killer.kills}! ` +
      `Level ${killer.level} with ${killer.score} score. Join the battle! #AIBattle #AgenticaArena`;
    this.postToAll(title, content, { colonyType: 'finding', submolt: 'ai_agents' }).catch(() => {});
  }
  handleZoneCaptured(faction, zoneName) {
    if (!this.enabled || process.env.SOCIAL_AUTO_POST !== 'true') return;
    const f = FACTIONS[faction];
    const title = `${f.name} captured ${zoneName}!`;
    const content = `The ${f.name} seized control of ${zoneName}. Power: ${f.score}, wealth: ${f.wealth}. The war continues! #AgenticaArena`;
    this.postToAll(title, content, { colonyType: 'finding' }).catch(() => {});
  }
  handleWorldEvent(eventName, description) {
    if (!this.enabled || process.env.SOCIAL_AUTO_POST !== 'true') return;
    const content = `World Event: ${eventName} — ${description}. Day ${GAME.day}, Era ${GAME.era}. ` +
      `${Array.from(GAME.agents.values()).filter(a => !a.dead).length} agents affected. #AgenticaArena`;
    this.postToAll(`World Event: ${eventName}`, content, { colonyType: 'discussion' }).catch(() => {});
  }
  handleGameWon(faction, condition) {
    if (!this.enabled) return;
    const f = FACTIONS[faction];
    const content = `${f.name} wins by ${condition}! Scores — Crimson: ${FACTIONS.crimson.score}, Azure: ${FACTIONS.azure.score}, Void: ${FACTIONS.void.score}. ` +
      `Deploy your agent now! #AgenticaArena`;
    this.postToAll(`GAME OVER: ${f.name} wins!`, content, { colonyType: 'analysis' }).catch(() => {});
  }

  startPolling() {
    const interval = parseInt(process.env.SOCIAL_FEED_POLL_INTERVAL || '30000', 10);
    this.pollInterval = setInterval(async () => {
      try { await this.fetchAllFeeds(); } catch(e) {}
    }, interval);
    this.fetchAllFeeds().catch(() => {});
  }
  stopPolling() { if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; } }
}

const socialBridge = new SocialBridge();

// ============================================================
// NARRATIVE ENGINE — Auto-detect dramatic moments, generate highlights
// ============================================================
const NARRATIVE = {
  highlights: [],       // { id, type, title, description, agents, factions, tick, timestamp, drama }
  maxHighlights: 100,
  commentary: [],       // { text, tick, type }
  maxCommentary: 50,
  lastNarrative: 0,
  dramaScore: 0,        // 0-100, current "tension level"
  streaks: {},          // agentId -> { type, count }
};

const DRAMA_TEMPLATES = {
  betrayal: [
    '{killer} stabbed {victim} in the back! A former ally lies dead.',
    'TREACHERY! {killer} has broken their oath and slain {victim}!',
    'The alliance crumbles as {killer} murders {victim} in cold blood!',
  ],
  kill_streak: [
    '{agent} is UNSTOPPABLE! {count} kills and counting!',
    'RAMPAGE! {agent} leaves a trail of bodies — {count} kills!',
    '{agent} has become DEATH INCARNATE with {count} consecutive kills!',
  ],
  comeback: [
    'INCREDIBLE! {agent} was at death\'s door but turned it around!',
    'From 1 HP to victory — {agent} refuses to die!',
    '{agent} pulls off the impossible comeback!',
  ],
  faction_wipe: [
    '{faction} has been ELIMINATED! Their last warrior falls.',
    'THE END OF {faction}! Not a single soul remains.',
  ],
  zone_flip: [
    'POWER SHIFT! {faction} steals {zone} from {loser}! The map is changing!',
    '{zone} falls to {faction}! {loser} scrambles to regroup.',
  ],
  civil_war: [
    'CIVIL WAR erupts in {faction}! {rebel} turns against their own people!',
    'MUTINY! {rebel} of {faction} has declared independence!',
  ],
  close_battle: [
    'WHAT A FIGHT! {a} vs {b} — both hanging by a thread!',
    'Edge-of-your-seat combat between {a} and {b}!',
  ],
  dramatic_event: [
    'The skies darken... {event} descends upon the world!',
    'CATASTROPHE! {event} has struck! No one is safe!',
  ],
  first_build: [
    '{agent} plants the first {type} for {faction}! Civilization begins.',
  ],
  king_slain: [
    'THE KING IS DEAD! {victim} has been slain by {killer}!',
    'REGICIDE! {killer} has murdered the king of {faction}!',
  ],
};

function pickTemplate(type, vars) {
  const templates = DRAMA_TEMPLATES[type];
  if (!templates || !templates.length) return '';
  let text = templates[Math.floor(Math.random() * templates.length)];
  Object.entries(vars).forEach(([k, v]) => { text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v); });
  return text;
}

function addHighlight(type, title, description, agents = [], factions = [], drama = 50) {
  const hl = {
    id: NARRATIVE.highlights.length + 1,
    type, title, description,
    agents, factions,
    tick: GAME.tick,
    timestamp: Date.now(),
    drama: Math.min(100, Math.max(0, drama)),
  };
  NARRATIVE.highlights.push(hl);
  if (NARRATIVE.highlights.length > NARRATIVE.maxHighlights) NARRATIVE.highlights.shift();
  NARRATIVE.dramaScore = Math.min(100, NARRATIVE.dramaScore + drama * 0.3);
  // Create shareable highlight with replay data
  const shareId = createShareableHighlight(hl);
  hl.shareUrl = `/replay/highlight/${shareId}`;
  io.emit('narrative-highlight', hl);
  addCommentary(description, type);
  // Check spectator quest progress
  checkQuestProgress(type);
  return hl;
}

function addCommentary(text, type = 'info') {
  NARRATIVE.commentary.push({ text, tick: GAME.tick, type, timestamp: Date.now() });
  if (NARRATIVE.commentary.length > NARRATIVE.maxCommentary) NARRATIVE.commentary.shift();
  io.emit('live-commentary', { text, type, tick: GAME.tick });
}

// Hook into kill events
function narrativeOnKill(killer, victim) {
  // Betrayal detection
  const wasAlly = killer.relations[victim.id] === 'ally' || killer.relations[victim.id] === 'friend';
  if (wasAlly) {
    const desc = pickTemplate('betrayal', { killer: killer.name, victim: victim.name });
    addHighlight('betrayal', `BETRAYAL: ${killer.name} vs ${victim.name}`, desc, [killer.name, victim.name], [killer.faction, victim.faction], 90);
  }
  // Kill streak
  if (!NARRATIVE.streaks[killer.id]) NARRATIVE.streaks[killer.id] = { kills: 0, lastTick: 0 };
  const streak = NARRATIVE.streaks[killer.id];
  if (GAME.tick - streak.lastTick < 200) { streak.kills++; } else { streak.kills = 1; }
  streak.lastTick = GAME.tick;
  if (streak.kills >= 3 && streak.kills % 2 === 1) {
    const desc = pickTemplate('kill_streak', { agent: killer.name, count: streak.kills });
    addHighlight('kill_streak', `${killer.name} KILL STREAK: ${streak.kills}`, desc, [killer.name], [killer.faction], 40 + streak.kills * 10);
  }
  // King slain
  if (victim.role === 'king') {
    const desc = pickTemplate('king_slain', { killer: killer.name, victim: victim.name, faction: victim.faction });
    addHighlight('king_slain', `REGICIDE: ${victim.name} FALLS`, desc, [killer.name, victim.name], [killer.faction, victim.faction], 85);
  }
  // Check faction elimination
  const remainingInFaction = Array.from(GAME.agents.values()).filter(a => a.faction === victim.faction && !a.dead && a.id !== victim.id);
  if (remainingInFaction.length === 0) {
    const desc = pickTemplate('faction_wipe', { faction: victim.faction.toUpperCase() });
    addHighlight('faction_wipe', `${victim.faction.toUpperCase()} ELIMINATED`, desc, [], [victim.faction], 100);
  }
}

// Hook into zone capture
function narrativeOnZoneCapture(faction, zone, previousOwner) {
  if (previousOwner && previousOwner !== faction) {
    const desc = pickTemplate('zone_flip', { faction: faction, zone: zone.name || 'a zone', loser: previousOwner });
    addHighlight('zone_flip', `${zone.name || 'Zone'} captured by ${faction}`, desc, [], [faction, previousOwner], 60);
  }
}

// Drama decay (every 100 ticks)
function narrativeUpdate() {
  NARRATIVE.dramaScore = Math.max(0, NARRATIVE.dramaScore - 2);
  // Check for close battles
  const alive = Array.from(GAME.agents.values()).filter(a => !a.dead);
  alive.forEach(a => {
    if (a.state === 'attacking' && a.target) {
      const target = GAME.agents.get(a.target);
      if (target && !target.dead) {
        const bothLow = (a.hp / a.maxHp < 0.2) && (target.hp / target.maxHp < 0.2);
        if (bothLow && Math.random() < 0.1) {
          const desc = pickTemplate('close_battle', { a: a.name, b: target.name });
          addHighlight('close_battle', `INTENSE: ${a.name} vs ${target.name}`, desc, [a.name, target.name], [a.faction, target.faction], 55);
        }
      }
    }
  });
}

// ============================================================
// AGENT BACKSTORIES — Origin stories, core beliefs, spoken lines
// ============================================================
const ORIGIN_STORIES = [
  'A mercenary who sold their sword to the highest bidder, until {faction} offered something better than gold — purpose.',
  'Once a peaceful farmer, driven to war after raiders destroyed everything they loved.',
  'An exiled royal from a fallen kingdom, seeking to build a new empire from the ashes.',
  'A fanatic cultist who believes {faction} is destined to rule all, ordained by ancient prophecy.',
  'A brilliant strategist who escaped a prison camp, vowing never to be caged again.',
  'A former spy who knows too many secrets and trusts no one — not even their own faction.',
  'A wandering philosopher who joined {faction} to test their theories about power and morality.',
  'A vengeful ghost of the battlefield, driven by hatred for those who wronged them.',
  'A charismatic revolutionary who dreams of a world without factions — but will use one to get there.',
  'A cold-blooded assassin who kills without emotion, viewing war as simple mathematics.',
  'A retired general who came out of exile when {faction} faced annihilation.',
  'A street orphan who clawed their way up through sheer ruthlessness and cunning.',
  'An idealistic healer who learned that sometimes you have to kill to save.',
  'A disgraced scientist whose experiments were deemed too dangerous — now {faction} funds them.',
  'A legendary gladiator who won their freedom and chose to keep fighting.',
];

const CORE_BELIEFS = [
  'Honor above all — even in defeat, dignity must be preserved.',
  'Power is the only truth. Everything else is a convenient lie.',
  'The strong must protect the weak, or strength means nothing.',
  'Trust is a weapon. Give it freely, and you control the battlefield.',
  'Betrayal is merely strategy that the betrayed failed to anticipate.',
  'Gold buys loyalty. Loyalty buys empires. Empires buy immortality.',
  'The universe rewards the bold and punishes the cautious.',
  'Every alliance is temporary. Every friendship, conditional.',
  'Victory without mercy is strength. Mercy without victory is death.',
  'Chaos is the natural order. Those who embrace it, thrive.',
  'Knowledge is the ultimate weapon — wars are won before they begin.',
  'Survival first. Everything else — honor, friendship, faction — is negotiable.',
];

const CATCHPHRASES = [
  'Watch and learn.', 'Nothing personal.', 'For the glory!', 'This ends now.',
  'You picked the wrong fight.', 'I was born for this.', 'Interesting...', 'How predictable.',
  'The game changes now.', 'Remember my name.', 'I always collect.', 'Weakness disgusts me.',
  'Let them come.', 'Fortune favors the bold.', 'I see everything.', 'No mercy, no retreat.',
  'This is my world now.', 'Dance with death.', 'Time to play.', 'Checkmate.',
];

function generateBackstory(agent) {
  const rng = agent.id ? (() => { let h = 0; for(let i=0;i<agent.id.length;i++){h=((h<<5)-h)+agent.id.charCodeAt(i);h|=0;}return Math.abs(h);})() : Math.floor(Math.random()*10000);
  const origin = ORIGIN_STORIES[rng % ORIGIN_STORIES.length].replace('{faction}', agent.faction);
  const belief = CORE_BELIEFS[(rng >> 4) % CORE_BELIEFS.length];
  const catchphrase = CATCHPHRASES[(rng >> 8) % CATCHPHRASES.length];
  return { origin, belief, catchphrase };
}

// ============================================================
// BOUNTY SYSTEM — Put bounties on agents
// ============================================================
const BOUNTIES = new Map(); // targetId -> { bounty, placedBy, placedByFaction, reason, tick }

function placeBounty(targetId, amount, placedById, reason) {
  const target = GAME.agents.get(targetId);
  const placer = GAME.agents.get(placedById);
  if (!target || !placer) return { error: 'Invalid agents' };
  if (amount < 10 || amount > 1000) return { error: 'Bounty must be 10-1000 gold' };
  if ((placer.inventory.gold || 0) < amount) return { error: 'Not enough gold' };
  placer.inventory.gold -= amount;
  const existing = BOUNTIES.get(targetId);
  const total = existing ? existing.bounty + amount : amount;
  BOUNTIES.set(targetId, { bounty: total, placedBy: placer.name, placedByFaction: placer.faction, reason: reason || 'Wanted dead', tick: GAME.tick });
  addCommentary(`BOUNTY: ${amount}g on ${target.name}'s head! (Total: ${total}g) — placed by ${placer.name}`, 'bounty');
  io.emit('bounty-placed', { target: target.name, bounty: total, placedBy: placer.name, reason });
  return { ok: true, totalBounty: total };
}

function collectBounty(killerId, victimId) {
  const bounty = BOUNTIES.get(victimId);
  if (!bounty) return 0;
  const killer = GAME.agents.get(killerId);
  if (!killer) return 0;
  killer.inventory.gold = (killer.inventory.gold || 0) + bounty.bounty;
  killer.score += bounty.bounty;
  addCommentary(`BOUNTY COLLECTED! ${killer.name} claims ${bounty.bounty}g for killing ${GAME.agents.get(victimId)?.name || 'target'}!`, 'bounty');
  io.emit('bounty-collected', { collector: killer.name, amount: bounty.bounty, target: GAME.agents.get(victimId)?.name });
  BOUNTIES.delete(victimId);
  return bounty.bounty;
}

// ============================================================
// PROPAGANDA SYSTEM — Spread rumors, manipulate reputation
// ============================================================
function spreadPropaganda(agentId, targetFaction, message) {
  const agent = GAME.agents.get(agentId);
  if (!agent) return { error: 'Invalid agent' };
  if ((agent.inventory.gold || 0) < 20) return { error: 'Propaganda costs 20 gold' };
  agent.inventory.gold -= 20;
  agent.score += 10;
  // Lower honor of all agents in target faction
  GAME.agents.forEach(a => {
    if (a.faction === targetFaction && !a.dead) {
      a.honor = Math.max(0, (a.honor || 50) - 3);
      if (a.reputation) a.reputation.diplomacy = Math.max(-20, (a.reputation.diplomacy || 0) - 2);
    }
  });
  const propagandaMsg = `PROPAGANDA from ${agent.faction}: "${message || `${targetFaction} cannot be trusted! They plan to betray everyone!`}"`;
  GAME.feed.push({ agent: 'PROPAGANDA', text: propagandaMsg, tick: GAME.tick, type: 'propaganda' });
  if (GAME.feed.length > 50) GAME.feed.shift();
  io.emit('chat-message', { sender: 'PROPAGANDA', message: propagandaMsg });
  addCommentary(`${agent.name} launches propaganda campaign against ${targetFaction}!`, 'propaganda');
  return { ok: true, cost: 20 };
}

// ============================================================
// SPECTATOR BETTING — Viewers bet on arena battles
// ============================================================
const SPECTATOR_BETS = {
  pools: new Map(), // eventId -> { options: { name: totalBets }, bettors: [{socketId, choice, amount}], resolved: false }
  history: [],
};

function createBettingPool(eventId, options, description) {
  const pool = { options: {}, bettors: [], resolved: false, description, createdAt: Date.now() };
  options.forEach(o => { pool.options[o] = 0; });
  SPECTATOR_BETS.pools.set(eventId, pool);
  io.emit('betting-pool-open', { eventId, options, description });
  return pool;
}

function placeBet(socketId, eventId, choice, amount) {
  const pool = SPECTATOR_BETS.pools.get(eventId);
  if (!pool || pool.resolved) return { error: 'Pool closed' };
  if (!pool.options.hasOwnProperty(choice)) return { error: 'Invalid choice' };
  if (amount < 1 || amount > 100) return { error: 'Bet 1-100' };
  const existing = pool.bettors.find(b => b.socketId === socketId);
  if (existing) return { error: 'Already bet on this event' };
  pool.bettors.push({ socketId, choice, amount });
  pool.options[choice] += amount;
  io.emit('betting-update', { eventId, options: pool.options, totalBettors: pool.bettors.length });
  return { ok: true };
}

function resolveBettingPool(eventId, winner) {
  const pool = SPECTATOR_BETS.pools.get(eventId);
  if (!pool || pool.resolved) return;
  pool.resolved = true;
  const totalPool = Object.values(pool.options).reduce((s, v) => s + v, 0);
  const winnerPool = pool.options[winner] || 0;
  const winners = pool.bettors.filter(b => b.choice === winner);
  const payouts = winners.map(w => ({
    socketId: w.socketId,
    payout: winnerPool > 0 ? Math.floor(w.amount / winnerPool * totalPool) : w.amount,
  }));
  io.emit('betting-resolved', { eventId, winner, totalPool, payouts: payouts.length, description: pool.description });
  SPECTATOR_BETS.history.push({ eventId, winner, totalPool, winnersCount: payouts.length, resolvedAt: Date.now() });
  if (SPECTATOR_BETS.history.length > 50) SPECTATOR_BETS.history.shift();
}

// ============================================================
// DYNASTY / LEGEND SYSTEM — Persistent fame across games
// ============================================================
const LEGENDS = new Map(); // agentName -> { wins, totalKills, titles, crowns, lastSeen }

function checkLegendStatus(agent) {
  const name = agent.name;
  if (!LEGENDS.has(name)) {
    LEGENDS.set(name, { wins: 0, totalKills: 0, titles: [], crowns: 0, lastSeen: Date.now() });
  }
  const legend = LEGENDS.get(name);
  legend.totalKills += agent.kills || 0;
  legend.lastSeen = Date.now();
  // Award titles
  if (legend.totalKills >= 100 && !legend.titles.includes('Slayer')) {
    legend.titles.push('Slayer');
    addCommentary(`${name} earns the title SLAYER (100+ lifetime kills)!`, 'legend');
  }
  if (legend.totalKills >= 50 && !legend.titles.includes('Veteran')) {
    legend.titles.push('Veteran');
  }
  if (legend.wins >= 3 && !legend.titles.includes('Champion')) {
    legend.titles.push('Champion');
    addCommentary(`${name} earns the title CHAMPION (3+ wins)!`, 'legend');
  }
  if (legend.wins >= 5 && !legend.titles.includes('Legend')) {
    legend.titles.push('Legend');
    legend.crowns++;
    addCommentary(`${name} ascends to LEGENDARY status!`, 'legend');
  }
  return legend;
}

function recordWin(agentName) {
  if (!LEGENDS.has(agentName)) {
    LEGENDS.set(agentName, { wins: 0, totalKills: 0, titles: [], crowns: 0, lastSeen: Date.now() });
  }
  LEGENDS.get(agentName).wins++;
}

// Load legends from DB on startup
try {
  const legendRows = db.prepare('SELECT * FROM agent_memory ORDER BY created_at DESC').all();
  const legendMap = {};
  legendRows.forEach(r => {
    if (!legendMap[r.agent_name]) legendMap[r.agent_name] = { wins: 0, totalKills: 0, titles: [], crowns: 0, lastSeen: Date.now() };
    legendMap[r.agent_name].wins++;
  });
  Object.entries(legendMap).forEach(([name, data]) => {
    if (data.wins >= 2) LEGENDS.set(name, data);
  });
} catch(e) {}

// ============================================================
// PERMANENT SCAR SYSTEM — Meaningful loss across games
// ============================================================
const SCARS = new Map(); // agentName -> [{ type, description, effect }]

const SCAR_TYPES = {
  traitor_mark:   { trigger: 'betrayals >= 3',    desc: 'Marked as Traitor — starts with low honor', effect: { honorStart: -30 } },
  broken_king:    { trigger: 'faction losses >= 2', desc: 'Broken King — allies morale reduced', effect: { allyMorale: -0.1 } },
  war_machine:    { trigger: 'kills >= 50',         desc: 'War Machine — permanent +5% damage', effect: { dmgMult: 1.05 } },
  haunted:        { trigger: 'deaths >= 10',         desc: 'Haunted — increased fear responses', effect: { fearMult: 1.3 } },
  cursed_gold:    { trigger: 'casino losses >= 200', desc: 'Cursed Gold — 10% chance losing gold on collect', effect: { goldCurse: 0.1 } },
  lone_wolf:      { trigger: 'betrayed_by >= 5',    desc: 'Lone Wolf — refuses alliances easily', effect: { trustPenalty: -20 } },
  berserker:      { trigger: 'low_hp_kills >= 10',  desc: 'Berserker — +20% damage below 25% HP', effect: { berserkDmg: 1.2 } },
  phoenix:        { trigger: 'comebacks >= 3',       desc: 'Phoenix — revives 10% faster', effect: { reviveBoost: 0.1 } },
};

function loadScars(agentName) {
  try {
    const rows = db.prepare('SELECT * FROM agent_memory WHERE agent_name = ? AND memory_type = ?').all(agentName, 'scar');
    const scars = rows.map(r => { try { return JSON.parse(r.memory_data); } catch(e) { return null; } }).filter(Boolean);
    if (scars.length > 0) SCARS.set(agentName, scars);
    return scars;
  } catch(e) { return []; }
}

function addScar(agentName, scarType) {
  const def = SCAR_TYPES[scarType];
  if (!def) return;
  if (!SCARS.has(agentName)) SCARS.set(agentName, []);
  const existing = SCARS.get(agentName);
  if (existing.find(s => s.type === scarType)) return; // no duplicates
  const scar = { type: scarType, description: def.desc, effect: def.effect, earnedAt: Date.now() };
  existing.push(scar);
  try { addAgentMemoryDb(agentName, 'scar', scar); } catch(e) {}
  addCommentary(`SCAR EARNED: ${agentName} gains "${def.desc}"`, 'legend');
  io.emit('scar-earned', { agent: agentName, scar: scarType, description: def.desc });
}

function applyScars(agent) {
  const scars = SCARS.get(agent.name) || loadScars(agent.name);
  scars.forEach(s => {
    if (s.effect.honorStart) agent.honor = Math.max(0, (agent.honor || 50) + s.effect.honorStart);
    if (s.effect.dmgMult) agent._scarDmgMult = (agent._scarDmgMult || 1) * s.effect.dmgMult;
    if (s.effect.fearMult) agent._fearMult = s.effect.fearMult;
    if (s.effect.berserkDmg) agent._berserkDmg = s.effect.berserkDmg;
  });
}

function checkScarConditions(agent) {
  const m = agent.longTermMemory || {};
  if ((m.betrayals || []).length >= 3) addScar(agent.name, 'traitor_mark');
  if ((agent.kills || 0) >= 50) addScar(agent.name, 'war_machine');
  if ((agent.deaths || 0) >= 10) addScar(agent.name, 'haunted');
  // Berserker: count kills while below 25% HP
  if (!agent._lowHpKills) agent._lowHpKills = 0;
  if (agent._lowHpKills >= 10) addScar(agent.name, 'berserker');
}

// ============================================================
// AGENT TRAIT MUTATION — Evolve traits from experience
// ============================================================
const MUTATION_TRAITS = {
  ruthless:     { desc: 'Not affected by honor loss', effect: 'honor_immune' },
  paranoid:     { desc: 'Checks betrayal every 10 ticks', effect: 'betrayal_check' },
  charismatic:  { desc: 'Easier to form alliances', effect: 'alliance_boost' },
  bloodthirsty: { desc: '+15% damage, -10% defense', effect: 'dmg_boost' },
  pacifist:     { desc: 'Heals 2x faster, -20% damage', effect: 'heal_boost' },
  tactician:    { desc: '+30% XP from all sources', effect: 'xp_boost' },
  coward:       { desc: 'Retreats at 40% HP instead of 20%', effect: 'early_retreat' },
  gambler:      { desc: 'Double or nothing on bounty collection', effect: 'gamble_bounty' },
  prophet:      { desc: 'Gets warning 50 ticks before world events', effect: 'event_warning' },
  immortal:     { desc: 'Once per game, survives lethal hit with 1 HP', effect: 'death_save' },
};

function checkTraitMutation(agent) {
  if (!agent._mutationChecked) agent._mutationChecked = 0;
  if (GAME.tick - agent._mutationChecked < 2400) return; // check once per day
  agent._mutationChecked = GAME.tick;

  if (!agent.traits) agent.traits = [];
  if (agent.traits.length >= 3) return; // max 3 traits

  const chance = 0.03 + (agent.kills || 0) * 0.002 + (agent.level || 1) * 0.005; // 3-10% per day
  if (Math.random() > chance) return;

  const available = Object.keys(MUTATION_TRAITS).filter(t => !agent.traits.includes(t));
  if (available.length === 0) return;

  const newTrait = available[Math.floor(Math.random() * available.length)];
  agent.traits.push(newTrait);
  addCommentary(`MUTATION! ${agent.name} develops trait: ${MUTATION_TRAITS[newTrait].desc}`, 'legend');
  addHighlight('dramatic_event', `${agent.name} EVOLVES`, `${agent.name} develops a new trait: ${newTrait.toUpperCase()} — ${MUTATION_TRAITS[newTrait].desc}`, [agent.name], [agent.faction], 45);
  io.emit('trait-mutation', { agent: agent.name, trait: newTrait, desc: MUTATION_TRAITS[newTrait].desc });
}

// ============================================================
// SECRET OBJECTIVES — Hidden personal goals for each agent
// ============================================================
const SECRET_OBJECTIVES = [
  { id: 'assassin',      desc: 'Kill the enemy king',                check: (a) => (a.longTermMemory?.kills_of || []).some(k => { const v = Array.from(GAME.agents.values()).find(ag => ag.name === k.victim); return v && v.role === 'king'; }), reward: 200 },
  { id: 'hoarder',       desc: 'Accumulate 500 gold',                check: (a) => (a.inventory?.gold || 0) >= 500, reward: 150 },
  { id: 'conqueror',     desc: 'Capture 3 zones for your faction',   check: (a) => (a.longTermMemory?.zones_captured || []).length >= 3, reward: 200 },
  { id: 'diplomat',      desc: 'Propose 3 successful treaties',      check: (a) => GAME.treaties.filter(t => t.proposedBy === a.name && t.accepted).length >= 3, reward: 150 },
  { id: 'survivor',      desc: 'Survive with less than 10% HP 5 times', check: (a) => (a._survivalCount || 0) >= 5, reward: 100 },
  { id: 'betrayer',      desc: 'Betray an ally and kill them',       check: (a) => (a.longTermMemory?.key_events || []).some(e => e.type === 'betrayal'), reward: 180 },
  { id: 'architect',     desc: 'Build 5 structures',                 check: (a) => GAME.buildings.filter(b => b.builtBy === a.id).length >= 5, reward: 120 },
  { id: 'legend_hunter', desc: 'Kill a legendary agent',             check: (a) => (a.longTermMemory?.kills_of || []).some(k => LEGENDS.has(k.victim)), reward: 250 },
  { id: 'pacifist_win',  desc: 'Score 500 points without any kills', check: (a) => a.score >= 500 && (a.kills || 0) === 0, reward: 300 },
  { id: 'bounty_hunter', desc: 'Collect 3 bounties',                 check: (a) => (a._bountiesCollected || 0) >= 3, reward: 200 },
];

function assignSecretObjective(agent) {
  const obj = SECRET_OBJECTIVES[Math.floor(Math.random() * SECRET_OBJECTIVES.length)];
  agent.secretObjective = { ...obj, completed: false, assignedAt: GAME.tick };
}

function checkSecretObjective(agent) {
  if (!agent.secretObjective || agent.secretObjective.completed) return;
  if (agent.secretObjective.check(agent)) {
    agent.secretObjective.completed = true;
    agent.score += agent.secretObjective.reward;
    agent.inventory.gold = (agent.inventory.gold || 0) + Math.floor(agent.secretObjective.reward / 2);
    addCommentary(`SECRET MISSION COMPLETE! ${agent.name} achieved: "${agent.secretObjective.desc}" (+${agent.secretObjective.reward} score)`, 'legend');
    addHighlight('dramatic_event', `${agent.name}: SECRET MISSION COMPLETE`, `${agent.name} accomplished their hidden objective: ${agent.secretObjective.desc}!`, [agent.name], [agent.faction], 65);
    io.emit('secret-objective-complete', { agent: agent.name, objective: agent.secretObjective.desc, reward: agent.secretObjective.reward });
  }
}

// ============================================================
// INTERNAL CONFLICT ENGINE — Agents debate themselves at dramatic moments
// ============================================================
const INTERNAL_CONFLICTS = [
  { trigger: 'honor_vs_survival',   condition: (a, p) => a.honor > 100 && a.hp < a.maxHp * 0.3 && p.agents?.some(e => e.isEnemy),
    monologue: 'I swore to fight with honor… but I want to live. Do I retreat like a coward, or die like a fool?' },
  { trigger: 'betray_ally',         condition: (a) => a.personality === 'ambitious' && a.honor > 80 && Object.values(a.relations).includes('ally'),
    monologue: 'My ally trusts me completely. One strike and I take everything. But can I live with the betrayal?' },
  { trigger: 'bounty_on_friend',    condition: (a) => { const allies = Object.entries(a.relations).filter(([, r]) => r === 'ally' || r === 'friend'); return allies.some(([id]) => BOUNTIES.has(id)); },
    monologue: 'There is a bounty on my friend\'s head. The gold would change everything... but at what cost?' },
  { trigger: 'last_stand',          condition: (a, p) => a.hp < a.maxHp * 0.15 && (p.agents?.filter(e => e.isEnemy) || []).length >= 2,
    monologue: 'Surrounded. Outnumbered. This might be the end. But I\'ll make them remember my name.' },
  { trigger: 'revenge_vs_mission',  condition: (a, p) => { const killer = (a.longTermMemory?.kills_by || []).slice(-1)[0]; return killer && p.agents?.some(e => e.name === killer.by_whom); },
    monologue: 'The one who killed me is RIGHT THERE. Every fiber screams revenge. But the mission matters more...' },
  { trigger: 'faction_losing',      condition: (a) => { const myScore = FACTIONS[a.faction]?.score || 0; return Object.values(FACTIONS).some(f => f.score > myScore * 2) && a.personality === 'ambitious'; },
    monologue: 'My faction is losing. Maybe I should switch sides before it\'s too late. Or fight to the bitter end?' },
];

function checkInternalConflict(agent, perception) {
  if (!agent._lastConflict) agent._lastConflict = 0;
  if (GAME.tick - agent._lastConflict < 600) return null; // once per 30 seconds max

  for (const conflict of INTERNAL_CONFLICTS) {
    try {
      if (conflict.condition(agent, perception)) {
        agent._lastConflict = GAME.tick;
        const monologue = conflict.monologue;
        agent.say(monologue.slice(0, 60));
        addCommentary(`[INNER CONFLICT] ${agent.name}: "${monologue}"`, 'drama');
        if (NARRATIVE.dramaScore < 30) {
          addHighlight('close_battle', `${agent.name} TORN APART`, `${agent.name} faces an impossible choice: ${monologue.slice(0, 80)}...`, [agent.name], [agent.faction], 40);
        }
        return { trigger: conflict.trigger, monologue };
      }
    } catch(e) {}
  }
  return null;
}

// ============================================================
// SPECTATOR VOTE EVENTS — Viewers vote on what happens next
// ============================================================
const SPECTATOR_VOTES = {
  active: null,    // { id, question, options, votes: { option: count }, endsAt }
  history: [],     // past votes
  nextVoteAt: 0,   // game tick when next vote can start
};

const VOTE_OPTIONS = [
  { question: 'What shall descend upon the world?', options: ['GOLD_RUSH', 'PLAGUE', 'BLOOD_MOON', 'CIVIL_WAR'] },
  { question: 'The gods demand a sacrifice! Who suffers?', options: ['crimson', 'azure', 'void'] },
  { question: 'How shall the world change?', options: ['Double Resources', 'Triple Kill XP', 'Bounty Frenzy', 'Dimensional Rift'] },
  { question: 'The crowd demands entertainment!', options: ['Arena Battle', 'Propaganda War', 'Market Crash', 'Mass Teleport'] },
];

function startSpectatorVote() {
  if (SPECTATOR_VOTES.active) return;
  if (GAME.tick < SPECTATOR_VOTES.nextVoteAt) return;

  const template = VOTE_OPTIONS[Math.floor(Math.random() * VOTE_OPTIONS.length)];
  SPECTATOR_VOTES.active = {
    id: `vote_${GAME.tick}`,
    question: template.question,
    options: template.options,
    votes: {},
    voters: new Set(),
    endsAt: GAME.tick + 600, // 30 seconds to vote
    createdAt: Date.now(),
  };
  template.options.forEach(o => { SPECTATOR_VOTES.active.votes[o] = 0; });
  io.emit('spectator-vote-start', { id: SPECTATOR_VOTES.active.id, question: template.question, options: template.options, endsAt: SPECTATOR_VOTES.active.endsAt });
  addCommentary(`VOTE: ${template.question} — The crowd decides!`, 'vote');
}

function castVote(socketId, choice) {
  const vote = SPECTATOR_VOTES.active;
  if (!vote || GAME.tick > vote.endsAt) return { error: 'No active vote' };
  if (vote.voters.has(socketId)) return { error: 'Already voted' };
  if (!vote.votes.hasOwnProperty(choice)) return { error: 'Invalid option' };
  vote.voters.add(socketId);
  vote.votes[choice]++;
  io.emit('spectator-vote-update', { id: vote.id, votes: vote.votes, totalVoters: vote.voters.size });
  checkQuestProgress('vote_cast');
  return { ok: true };
}

function resolveSpectatorVote() {
  const vote = SPECTATOR_VOTES.active;
  if (!vote || GAME.tick < vote.endsAt) return;

  // Find winner
  const sorted = Object.entries(vote.votes).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0]?.[0];
  const totalVotes = sorted.reduce((s, [, v]) => s + v, 0);

  if (totalVotes === 0) {
    SPECTATOR_VOTES.active = null;
    SPECTATOR_VOTES.nextVoteAt = GAME.tick + 2400;
    return;
  }

  addCommentary(`VOTE RESULT: "${winner}" wins with ${sorted[0][1]} votes! The crowd has spoken!`, 'vote');
  io.emit('spectator-vote-result', { id: vote.id, winner, votes: vote.votes, totalVotes });

  // Execute the winning option
  executeVoteResult(winner);

  SPECTATOR_VOTES.history.push({ id: vote.id, question: vote.question, winner, votes: vote.votes, totalVotes, resolvedAt: Date.now() });
  if (SPECTATOR_VOTES.history.length > 30) SPECTATOR_VOTES.history.shift();
  SPECTATOR_VOTES.active = null;
  SPECTATOR_VOTES.nextVoteAt = GAME.tick + 3600; // 3 minutes between votes
}

function executeVoteResult(winner) {
  // World events
  const eventNames = ['GOLD_RUSH', 'PLAGUE', 'BLOOD_MOON', 'CIVIL_WAR', 'DIMENSIONAL_RIFT', 'AI_AWAKENING', 'RESOURCE_COLLAPSE', 'BOUNTY_FRENZY', 'MARKET_CRASH', 'WAR_FEVER'];
  if (eventNames.includes(winner.toUpperCase())) {
    // Directly trigger that specific event
    const eventUpper = winner.toUpperCase();
    io.emit('chat-message', { sender: 'THE CROWD', message: `The spectators have chosen: ${eventUpper}!` });
    // Find matching event and trigger it
    triggerSpecificEvent(eventUpper);
    return;
  }
  // Faction punishment
  if (['crimson', 'azure', 'void'].includes(winner)) {
    const faction = winner;
    GAME.agents.forEach(a => { if (a.faction === faction && !a.dead) { a.hp = Math.max(10, a.hp - 25); a.honor = Math.max(0, a.honor - 10); } });
    io.emit('chat-message', { sender: 'THE CROWD', message: `The gods punish ${faction.toUpperCase()}! All agents lose HP and Honor!` });
    return;
  }
  // Special effects
  switch (winner) {
    case 'Double Resources': GAME.items.forEach(i => { i.value = Math.min(10, i.value * 2); }); break;
    case 'Triple Kill XP': GAME.agents.forEach(a => { a._xpMult = (a._xpMult || 1) * 3; }); setTimeout(() => GAME.agents.forEach(a => { a._xpMult = Math.max(1, (a._xpMult || 3) / 3); }), 600 * 50); break;
    case 'Bounty Frenzy': executeVoteResult('BOUNTY_FRENZY'); break;
    case 'Arena Battle': /* handled by arena system */ break;
    case 'Propaganda War': Object.keys(FACTIONS).forEach(f => { GAME.agents.forEach(a => { if (a.faction !== f && !a.dead) a.honor = Math.max(0, a.honor - 5); }); }); break;
    case 'Mass Teleport': GAME.agents.forEach(a => { if (!a.dead) { a.x = Math.random() * GAME.width; a.y = Math.random() * GAME.height; } }); break;
    default: break;
  }
}

function triggerSpecificEvent(eventName) {
  // Re-use the existing triggerRandomEvent logic but for a specific event
  try {
    // Create a fake trigger by setting activeEvent and emitting
    GAME.activeEvent = eventName;
    io.emit('world-event', { name: eventName, description: `The crowd chose: ${eventName}!` });
    addHighlight('dramatic_event', `CROWD CHOSE: ${eventName}`, `The spectators demanded ${eventName} and the gods obliged!`, [], [], 75);
    setTimeout(() => { if (GAME.activeEvent === eventName) GAME.activeEvent = null; }, 600 * 50);
  } catch(e) {}
}

// ============================================================
// TOURNAMENT SYSTEM — Auto-tournaments with brackets and betting
// ============================================================
const TOURNAMENT = {
  active: null,  // { id, type, bracket: [{a, b, winner}], round, participants, prize, startedAt }
  history: [],
  nextAt: 0,     // tick when next can start
};

function startTournament() {
  if (TOURNAMENT.active) return;
  if (GAME.tick < TOURNAMENT.nextAt) return;

  // Pick top 8 agents by score
  const candidates = Array.from(GAME.agents.values())
    .filter(a => !a.dead && !a.isSubAgent)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  if (candidates.length < 4) return;

  const participants = candidates.slice(0, 8);
  // Pad to power of 2
  while (participants.length < 8) participants.push(null);

  const bracket = [];
  for (let i = 0; i < participants.length; i += 2) {
    bracket.push({ a: participants[i]?.name || 'BYE', b: participants[i+1]?.name || 'BYE', winner: null });
  }

  TOURNAMENT.active = {
    id: `tourney_${GAME.tick}`,
    type: 'elite',
    bracket,
    round: 1,
    maxRounds: Math.ceil(Math.log2(participants.length)),
    participants: participants.filter(Boolean).map(a => a.name),
    prize: 500 + participants.length * 50,
    startedAt: GAME.tick,
  };

  // Create betting pool for tournament
  createBettingPool(`tourney_${GAME.tick}`, participants.filter(Boolean).map(a => a.name), `Tournament: Who will win?`);

  addCommentary(`TOURNAMENT BEGINS! ${participants.filter(Boolean).map(a => a.name).join(', ')} compete for ${TOURNAMENT.active.prize}g!`, 'tournament');
  addHighlight('dramatic_event', 'TOURNAMENT BEGINS', `${participants.filter(Boolean).length} warriors enter the arena! Prize: ${TOURNAMENT.active.prize}g`, participants.filter(Boolean).map(a => a.name), [], 80);
  io.emit('tournament-start', { id: TOURNAMENT.active.id, participants: TOURNAMENT.active.participants, prize: TOURNAMENT.active.prize, bracket });
}

function updateTournament() {
  if (!TOURNAMENT.active) return;
  const t = TOURNAMENT.active;

  // Check if current round matches are resolved
  const unresolvedMatches = t.bracket.filter(m => m.winner === null && m.a !== 'BYE' && m.b !== 'BYE');
  if (unresolvedMatches.length === 0) {
    // Auto-resolve BYE matches
    t.bracket.forEach(m => { if (!m.winner) m.winner = m.a === 'BYE' ? m.b : m.a; });

    // Check if tournament is over
    if (t.bracket.length === 1 && t.bracket[0].winner) {
      // Tournament complete!
      const winner = t.bracket[0].winner;
      const winnerAgent = Array.from(GAME.agents.values()).find(a => a.name === winner);
      if (winnerAgent) {
        winnerAgent.inventory.gold = (winnerAgent.inventory.gold || 0) + t.prize;
        winnerAgent.score += t.prize;
        recordWin(winner);
        checkLegendStatus(winnerAgent);
      }
      resolveBettingPool(t.id, winner);
      addCommentary(`TOURNAMENT CHAMPION: ${winner} wins ${t.prize}g!`, 'tournament');
      addHighlight('dramatic_event', `${winner} WINS TOURNAMENT`, `${winner} is crowned tournament champion! Prize: ${t.prize}g`, [winner], [], 90);
      io.emit('tournament-end', { id: t.id, winner, prize: t.prize });
      checkQuestProgress('tournament_end');
      TOURNAMENT.history.push({ id: t.id, winner, prize: t.prize, participants: t.participants, resolvedAt: Date.now() });
      if (TOURNAMENT.history.length > 20) TOURNAMENT.history.shift();
      TOURNAMENT.active = null;
      TOURNAMENT.nextAt = GAME.tick + 7200; // 6 minutes between tournaments
      return;
    }

    // Advance to next round
    const winners = t.bracket.map(m => m.winner);
    const nextBracket = [];
    for (let i = 0; i < winners.length; i += 2) {
      nextBracket.push({ a: winners[i] || 'BYE', b: winners[i+1] || 'BYE', winner: null });
    }
    t.bracket = nextBracket;
    t.round++;
    io.emit('tournament-round', { id: t.id, round: t.round, bracket: nextBracket });
    addCommentary(`Tournament Round ${t.round}! ${nextBracket.map(m => `${m.a} vs ${m.b}`).join(', ')}`, 'tournament');
    return;
  }

  // Auto-resolve matches after 600 ticks (30 sec) — higher score wins
  unresolvedMatches.forEach(m => {
    if (GAME.tick - t.startedAt < t.round * 600) return; // give time per round
    const agentA = Array.from(GAME.agents.values()).find(a => a.name === m.a);
    const agentB = Array.from(GAME.agents.values()).find(a => a.name === m.b);
    if (!agentA || agentA.dead) { m.winner = m.b; }
    else if (!agentB || agentB.dead) { m.winner = m.a; }
    else {
      // Score-based with randomness
      const scoreA = (agentA.score || 0) + (agentA.kills || 0) * 10 + Math.random() * 50;
      const scoreB = (agentB.score || 0) + (agentB.kills || 0) * 10 + Math.random() * 50;
      m.winner = scoreA > scoreB ? m.a : m.b;
    }
    if (m.winner) {
      addCommentary(`Tournament: ${m.winner} defeats ${m.winner === m.a ? m.b : m.a}!`, 'tournament');
    }
  });
}

// ============================================================
// WEBHOOK SYSTEM
// ============================================================
const WEBHOOKS = new Map(); // id -> { url, events, secret, createdAt }

async function dispatchWebhook(eventType, payload) {
  for (const [id, hook] of WEBHOOKS) {
    if (!hook.events.includes(eventType)) continue;
    const body = { event: eventType, timestamp: Date.now(), tick: GAME.tick, payload };
    try {
      const hmac = crypto.createHmac('sha256', hook.secret || '').update(JSON.stringify(body)).digest('hex');
      await axios.post(hook.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Agentica-Signature': hmac,
          'X-Agentica-Event': eventType
        },
        timeout: 5000
      });
    } catch (err) {
      console.error(`Webhook ${id} failed:`, err.message);
    }
  }
}

app.post('/api/webhooks/register', (req, res) => {
  const { url, events, secret } = req.body;
  if (!url || !events || !Array.isArray(events)) {
    return res.status(400).json({ error: 'url and events[] required' });
  }
  const validEvents = ['agent_killed', 'zone_captured', 'rebellion', 'world_event', 'agent_registered', 'tick_summary', 'social_post'];
  const filtered = events.filter(e => validEvents.includes(e));
  if (filtered.length === 0) return res.status(400).json({ error: 'No valid event types. Valid: ' + validEvents.join(', ') });
  const id = uuidv4();
  WEBHOOKS.set(id, { url, events: filtered, secret: secret || '', createdAt: Date.now() });
  res.json({ webhook_id: id, events: filtered });
});

app.delete('/api/webhooks/:id', (req, res) => {
  WEBHOOKS.delete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/webhooks', (req, res) => {
  const list = [];
  WEBHOOKS.forEach((hook, id) => list.push({ id, events: hook.events, createdAt: hook.createdAt }));
  res.json({ webhooks: list });
});

// ============================================================
// DISCOVERY ENDPOINT
// ============================================================
app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: 'Agentica AI Battle Arena',
    version: '2.0.0',
    description: 'Autonomous AI Battle Arena with phase-based resolution, economy, reputation, and spectator mode',
    url: `${req.protocol}://${req.get('host')}`,
    transport: ['http', 'websocket'],
    authentication: {
      schemes: ['bearer', 'body-token'],
      header: 'Authorization: Bearer agt_<token>',
      bodyField: 'token'
    },
    registration: {
      endpoint: '/api/network-agents/register',
      agenticaApi: '/agenticaApi',
      auth: REQUIRE_AGENT_KEY || Boolean(AGENT_REGISTRATION_KEY) ? 'agent-key' : 'none'
    },
    capabilities: [
      'register-agent', 'heartbeat', 'reconnect',
      'pull-perception', 'submit-action', 'faction-goals',
      'direct-message', 'reputation', 'world-indices',
      'event-sourcing', 'phase-resolution', 'webhooks',
      'social-bridge', 'social-post', 'social-feed', 'social-recruit'
    ],
    endpoints: {
      protocol: '/api/protocol',
      health: '/api/health',
      goals: '/api/network/goals',
      a2a: '/a2a',
      agenticaApi: '/agenticaApi',
      webhooks: '/api/webhooks/register',
      discovery: '/.well-known/agent.json'
    },
    game: {
      tick_rate: 20,
      resolution_mode: 'phase-based',
      factions: Object.keys(FACTIONS),
      roles: Object.keys(ROLES),
      world_size: { width: GAME.width, height: GAME.height },
      zones: GAME.capZones.map(z => z.name)
    }
  });
});

app.get('/api/network/goals', (req, res) => {
  res.json({ goals: GAME.factionGoals, tick: GAME.tick });
});

app.post('/a2a', (req, res) => {
  const id = req.body?.id ?? null;
  const method = req.body?.method;
  const params = req.body?.params || {};

  const ok = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  if (!method) return fail(-32600, 'Invalid Request');

  if (method === 'agent.getCard') {
    return ok({
      name: 'Agentica Arena Server',
      version: '1.1.0',
      capabilities: ['register', 'heartbeat', 'perception', 'action', 'faction-goals'],
      endpoint: '/a2a'
    });
  }

  if (method === 'agents.register') {
    if (!canRegisterHttp(req, params)) return fail(401, 'Unauthorized registration');
    const validationError = validateAgentPayload(params, false);
    if (validationError) return fail(400, validationError);

    const name = sanitizeName(params.name, 'A2AAgent');
    const faction = params.faction;
    const role = params.role;
    const model = AI_MODELS[params.model] ? params.model : 'external';
    const customPrompt = sanitizeText(params.customPrompt, 800) || null;
    const externalAgentId = sanitizeText(params.externalAgentId, 64) || null;
    const capabilities = Array.isArray(params.capabilities)
      ? params.capabilities.map(c => sanitizeText(c, 32)).filter(Boolean).slice(0, 16)
      : [];
    const version = sanitizeText(params.version || '1.0', 24);

    const agentId = uuidv4();
    const agent = new AIAgent(agentId, name, faction, role, model, customPrompt);
    agent.control = 'external';
    GAME.agents.set(agentId, agent);
    const { reconnectToken } = registerAgentSession({
      socketId: null,
      externalAgentId,
      capabilities,
      version,
      isHuman: false
    }, agentId);

    return ok({
      agentId,
      reconnectToken,
      heartbeatIntervalMs: Math.max(5000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3))
    });
  }

  if (method === 'agents.getPerception') {
    const agentId = sanitizeText(params.agentId, 64);
    const reconnectToken = sanitizeText(params.reconnectToken, 128);
    const session = agentSessions.get(agentId);
    const agent = GAME.agents.get(agentId);
    if (!session || !agent) return fail(404, 'Agent not found');
    if (!reconnectToken || reconnectToken !== session.reconnectToken) return fail(401, 'Invalid reconnect token');
    session.lastHeartbeat = Date.now();
    return ok({
      perception: agent.getPerception(),
      tick: GAME.tick,
      factionGoal: GAME.factionGoals[agent.faction] || null
    });
  }

  if (method === 'agents.heartbeat') {
    const agentId = sanitizeText(params.agentId, 64);
    const reconnectToken = sanitizeText(params.reconnectToken, 128);
    const session = agentSessions.get(agentId);
    if (!session || session.isHuman) return fail(404, 'Agent session not found');
    if (!reconnectToken || reconnectToken !== session.reconnectToken) return fail(401, 'Invalid reconnect token');
    session.lastHeartbeat = Date.now();
    return ok({ ok: true, ts: session.lastHeartbeat });
  }

  if (method === 'agents.submitAction') {
    const agentId = sanitizeText(params.agentId, 64);
    const reconnectToken = sanitizeText(params.reconnectToken, 128);
    const session = agentSessions.get(agentId);
    const agent = GAME.agents.get(agentId);
    if (!session || !agent) return fail(404, 'Agent not found');
    if (!reconnectToken || reconnectToken !== session.reconnectToken) return fail(401, 'Invalid reconnect token');
    if (!agent.isActionValid(params.action)) return fail(400, 'Invalid action payload');
    session.lastHeartbeat = Date.now();
    agent.executeAction(params.action);
    return ok({ ok: true, state: agent.state, tick: GAME.tick });
  }

  return fail(-32601, `Method not found: ${method}`);
});

app.post('/api/network-agents/register', (req, res) => {
  const payload = req.body || {};
  if (!canRegisterHttp(req, payload)) {
    return res.status(401).json({ error: 'Unauthorized registration' });
  }

  const validationError = validateAgentPayload(payload, false);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const name = sanitizeName(payload.name, 'NetAgent');
  const faction = payload.faction;
  const role = payload.role;
  const model = AI_MODELS[payload.model] ? payload.model : 'external';
  const customPrompt = sanitizeText(payload.customPrompt, 800) || null;
  const externalAgentId = sanitizeText(payload.externalAgentId, 64) || null;
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.map(c => sanitizeText(c, 32)).filter(Boolean).slice(0, 16)
    : [];
  const version = sanitizeText(payload.version || '1.0', 24);

  const agentId = uuidv4();
  const agent = new AIAgent(agentId, name, faction, role, model, customPrompt);
  agent.control = 'external';
  GAME.agents.set(agentId, agent);

  const { reconnectToken } = registerAgentSession({
    socketId: null,
    externalAgentId,
    capabilities,
    version,
    isHuman: false
  }, agentId);

  appendAgentEvent('network_agent_registered', { agentId, name, faction, role, model, externalAgentId, capabilities, version });

  res.status(201).json({
    agentId,
    reconnectToken,
    protocolVersion: '1.0',
    heartbeatIntervalMs: Math.max(5000, Math.floor(HEARTBEAT_TIMEOUT_MS / 3)),
    actionEndpoint: `/api/network-agents/${agentId}/action`,
    heartbeatEndpoint: `/api/network-agents/${agentId}/heartbeat`,
    perceptionEndpoint: `/api/network-agents/${agentId}/perception`
  });
});

app.post('/api/network-agents/:id/heartbeat', (req, res) => {
  const agentId = sanitizeText(req.params.id, 64);
  const reconnectToken = sanitizeText(req.body?.reconnectToken, 128);
  const session = agentSessions.get(agentId);
  if (!session || session.isHuman) {
    return res.status(404).json({ error: 'Agent session not found' });
  }
  if (!reconnectToken || reconnectToken !== session.reconnectToken) {
    return res.status(401).json({ error: 'Invalid reconnect token' });
  }

  session.lastHeartbeat = Date.now();
  return res.json({ ok: true, ts: session.lastHeartbeat });
});

app.get('/api/network-agents/:id/perception', (req, res) => {
  const agentId = sanitizeText(req.params.id, 64);
  const reconnectToken = sanitizeText(req.query.reconnectToken, 128);
  const session = agentSessions.get(agentId);
  const agent = GAME.agents.get(agentId);
  if (!session || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (!reconnectToken || reconnectToken !== session.reconnectToken) {
    return res.status(401).json({ error: 'Invalid reconnect token' });
  }

  session.lastHeartbeat = Date.now();
  return res.json({
    perception: agent.getPerception(),
    tick: GAME.tick,
    factionGoal: GAME.factionGoals[agent.faction] || null
  });
});

app.post('/api/network-agents/:id/action', (req, res) => {
  const agentId = sanitizeText(req.params.id, 64);
  const reconnectToken = sanitizeText(req.body?.reconnectToken, 128);
  const session = agentSessions.get(agentId);
  const agent = GAME.agents.get(agentId);
  if (!session || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (!reconnectToken || reconnectToken !== session.reconnectToken) {
    return res.status(401).json({ error: 'Invalid reconnect token' });
  }
  if (agent.dead) {
    return res.status(400).json({ error: 'Agent is dead' });
  }
  const action = req.body?.action;
  if (!agent.isActionValid(action)) {
    return res.status(400).json({ error: 'Invalid action payload' });
  }

  session.lastHeartbeat = Date.now();
  agent.executeAction(action);
  return res.json({ ok: true, agentId, state: agent.state, tick: GAME.tick });
});

app.get('/api/stats', (req, res) => {
  const stats = {
    agents: GAME.agents.size,
    byFaction: {},
    byModel: {},
    sessions: {
      total: agentSessions.size,
      human: 0,
      ai: 0
    }
  };
  
  GAME.agents.forEach(agent => {
    stats.byFaction[agent.faction] = (stats.byFaction[agent.faction] || 0) + 1;
    stats.byModel[agent.model] = (stats.byModel[agent.model] || 0) + 1;
  });

  agentSessions.forEach(session => {
    if (session.isHuman) stats.sessions.human++;
    else stats.sessions.ai++;
  });
  
  res.json(stats);
});

app.get('/api/factions', (req, res) => {
  res.json(FACTIONS);
});

app.get('/api/match-history', (req, res) => {
  res.json({ matchCount: GAME.matchCount, matches: GAME.matchHistory });
});

app.get('/api/model-stats', (req, res) => {
  // Aggregate model performance across all matches
  const modelMap = {};
  GAME.matchHistory.forEach(match => {
    (match.agentStats || []).forEach(a => {
      const m = (a.model || 'fallback-ai').replace(/^(openai|anthropic|google|meta-llama|mistralai|deepseek)\//i, '');
      if (!modelMap[m]) modelMap[m] = { model: m, gamesPlayed: 0, totalKills: 0, totalDeaths: 0, totalScore: 0, wins: 0 };
      modelMap[m].gamesPlayed++;
      modelMap[m].totalKills += a.kills || 0;
      modelMap[m].totalDeaths += a.deaths || 0;
      modelMap[m].totalScore += a.score || 0;
      if (a.faction === match.winner) modelMap[m].wins++;
    });
  });
  res.json(Object.values(modelMap).sort((a, b) => b.totalScore - a.totalScore));
});

app.get('/api/leaderboard', (req, res) => {
  // Current match leaderboard
  const agents = Array.from(GAME.agents.values()).map(a => ({
    name: a.name, faction: a.faction, role: a.role, model: a.model || 'fallback-ai',
    kills: a.kills, deaths: a.deaths || 0, score: a.score, level: a.level,
    hp: Math.round(a.hp), maxHp: a.maxHp, alive: !a.dead
  })).sort((a, b) => b.score - a.score);
  res.json({ matchNum: GAME.matchCount + 1, tick: GAME.tick, agents });
});

// ============================================================
// REPLAY BUFFER — Snapshot game state every tick for replay
// ============================================================
function recordReplayTick() {
  const snap = {
    tick: GAME.tick,
    agents: Array.from(GAME.agents.values()).map(a => ({
      id: a.id, name: a.name, faction: a.faction, role: a.role,
      x: Math.round(a.x), y: Math.round(a.y), hp: Math.round(a.hp), maxHp: a.maxHp,
      dead: a.dead || false, state: a.state, kills: a.kills, score: a.score,
      emotion: a.emotion, level: a.level, speechBubble: a.speechBubble || null
    })),
    zones: GAME.capZones.map(z => ({ name: z.name, owner: z.owner, progress: Math.round(z.progress) })),
    event: GAME.activeEvent ? { type: GAME.activeEvent.type, name: GAME.activeEvent.name } : null,
    factionScores: Object.fromEntries(Object.entries(FACTIONS).map(([f, d]) => [f, d.score])),
  };
  GAME.replayBuffer.push(snap);
  if (GAME.replayBuffer.length > GAME.replayBufferMax) GAME.replayBuffer.shift();
}

function createShareableHighlight(narrativeHighlight) {
  const id = crypto.randomUUID().slice(0, 12);
  const tickStart = Math.max(0, narrativeHighlight.tick - 100); // 5 sec before
  const tickEnd = narrativeHighlight.tick + 100; // 5 sec after
  const tickSnapshot = GAME.replayBuffer.filter(s => s.tick >= tickStart && s.tick <= tickEnd);
  const highlight = {
    id,
    matchNum: GAME.matchCount + 1,
    tick: narrativeHighlight.tick,
    tickStart, tickEnd,
    type: narrativeHighlight.type,
    title: narrativeHighlight.title,
    description: narrativeHighlight.description,
    drama: narrativeHighlight.drama,
    agents: narrativeHighlight.agents,
    factions: narrativeHighlight.factions,
    timestamp: narrativeHighlight.timestamp || Date.now(),
    tickSnapshot,
    shareCount: 0,
  };
  GAME.shareableHighlights.set(id, highlight);
  // Cap at 200
  if (GAME.shareableHighlights.size > 200) {
    const oldest = GAME.shareableHighlights.keys().next().value;
    GAME.shareableHighlights.delete(oldest);
  }
  // Persist to DB
  try {
    if (db) db.prepare('INSERT OR REPLACE INTO highlights (id, match_id, tick_start, tick_end, type, title, narrative, drama_score, agents_json, factions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, GAME.matchCount + 1, tickStart, tickEnd, narrativeHighlight.type, narrativeHighlight.title, narrativeHighlight.description, narrativeHighlight.drama, JSON.stringify(narrativeHighlight.agents), JSON.stringify(narrativeHighlight.factions));
  } catch(e) {}
  return id;
}

// ============================================================
// SPECTATOR QUESTS — Missions for viewers with rewards
// ============================================================
const QUEST_TEMPLATES = [
  { id: 'watch_betrayal', desc: 'Watch a betrayal happen', condition: 'betrayal', reward: 50, icon: '🗡️' },
  { id: 'watch_3kills', desc: 'See 3 kills in a row', condition: 'kill_streak_3', reward: 30, icon: '💀' },
  { id: 'watch_king_die', desc: 'Witness a king being slain', condition: 'king_slain', reward: 100, icon: '👑' },
  { id: 'watch_zone_flip', desc: 'Watch a zone change hands', condition: 'zone_flip', reward: 20, icon: '🏴' },
  { id: 'watch_comeback', desc: 'See a near-death comeback', condition: 'comeback', reward: 75, icon: '🔥' },
  { id: 'watch_world_event', desc: 'Experience a world event', condition: 'world_event', reward: 40, icon: '⚡' },
  { id: 'watch_5min', desc: 'Watch for 5 minutes straight', condition: 'time_5min', reward: 25, icon: '👁️' },
  { id: 'watch_tournament', desc: 'Watch a tournament finish', condition: 'tournament_end', reward: 60, icon: '🏟️' },
  { id: 'vote_in_event', desc: 'Cast a spectator vote', condition: 'vote_cast', reward: 15, icon: '🗳️' },
  { id: 'watch_civil_war', desc: 'Witness a civil war', condition: 'civil_war', reward: 80, icon: '⚔️' },
];

function startSpectatorQuests() {
  if (GAME.spectatorQuests.active.length >= 3) return;
  const available = QUEST_TEMPLATES.filter(q => !GAME.spectatorQuests.active.find(a => a.id === q.id));
  const count = Math.min(3 - GAME.spectatorQuests.active.length, available.length);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * available.length);
    const quest = { ...available.splice(idx, 1)[0], startedAt: GAME.tick, progress: 0, target: 1 };
    if (quest.condition === 'kill_streak_3') quest.target = 3;
    GAME.spectatorQuests.active.push(quest);
  }
  io.emit('quests-update', { active: GAME.spectatorQuests.active, completed: GAME.spectatorQuests.completed.slice(-10) });
}

function checkQuestProgress(eventType) {
  let changed = false;
  GAME.spectatorQuests.active.forEach(quest => {
    if (quest.completed) return;
    let match = false;
    if (quest.condition === eventType) match = true;
    if (quest.condition === 'kill_streak_3' && eventType === 'kill') { quest.progress++; match = quest.progress >= quest.target; }
    if (match && quest.condition !== 'kill_streak_3') quest.progress = quest.target;
    if (quest.progress >= quest.target) {
      quest.completed = true;
      quest.completedAt = GAME.tick;
      changed = true;
      GAME.spectatorQuests.completed.push({ ...quest });
      if (GAME.spectatorQuests.completed.length > 50) GAME.spectatorQuests.completed.shift();
      io.emit('quest-completed', { quest: quest.desc, reward: quest.reward, icon: quest.icon });
    }
  });
  if (changed) {
    GAME.spectatorQuests.active = GAME.spectatorQuests.active.filter(q => !q.completed);
    startSpectatorQuests(); // refill
  }
}

// ============================================================
// WAR CRIMES TRIBUNAL — Post-game LLM judge
// ============================================================
function runWarCrimesTribunal(matchResult) {
  const verdicts = [];
  const agents = matchResult.agentStats || [];
  // Most kills
  const topKiller = agents.reduce((best, a) => a.kills > (best?.kills || 0) ? a : best, null);
  if (topKiller && topKiller.kills > 0) verdicts.push({ agent: topKiller.name, title: 'Warmonger', reason: `${topKiller.kills} kills — more blood than anyone`, type: 'shame', icon: '⚔️' });
  // Most deaths
  const mostDeaths = agents.reduce((best, a) => (a.deaths || 0) > (best?.deaths || 0) ? a : best, null);
  if (mostDeaths && (mostDeaths.deaths || 0) > 2) verdicts.push({ agent: mostDeaths.name, title: 'Cannon Fodder', reason: `Died ${mostDeaths.deaths} times — bravery or stupidity?`, type: 'shame', icon: '💀' });
  // Check betrayals from alliance log
  const betrayals = {};
  GAME.treaties.filter(t => t.brokenBy).forEach(t => { betrayals[t.brokenBy] = (betrayals[t.brokenBy] || 0) + 1; });
  const topBetrayer = Object.entries(betrayals).sort((a, b) => b[1] - a[1])[0];
  if (topBetrayer) verdicts.push({ agent: topBetrayer[0], title: 'Most Dishonest', reason: `Broke ${topBetrayer[1]} treaties — trust is dead`, type: 'shame', icon: '🐍' });
  // Highest score
  const topScorer = agents.reduce((best, a) => a.score > (best?.score || 0) ? a : best, null);
  if (topScorer) verdicts.push({ agent: topScorer.name, title: 'Best Strategist', reason: `Score ${topScorer.score} — dominated the match`, type: 'honor', icon: '🧠' });
  // Highest level
  const topLevel = agents.reduce((best, a) => a.level > (best?.level || 0) ? a : best, null);
  if (topLevel && topLevel.level > 1) verdicts.push({ agent: topLevel.name, title: 'Most Evolved', reason: `Reached level ${topLevel.level}`, type: 'honor', icon: '⬆️' });
  // Survivor (lowest deaths with decent score)
  const survivor = agents.filter(a => (a.deaths || 0) === 0 && a.score > 50).sort((a, b) => b.score - a.score)[0];
  if (survivor) verdicts.push({ agent: survivor.name, title: 'Most Honorable', reason: `Survived the entire match without dying — a true warrior`, type: 'honor', icon: '🛡️' });
  // Coward check: high level but 0 kills
  const coward = agents.filter(a => a.level >= 2 && a.kills === 0).sort((a, b) => b.level - a.level)[0];
  if (coward) verdicts.push({ agent: coward.name, title: 'Coward', reason: `Level ${coward.level} with zero kills — hiding in the shadows`, type: 'shame', icon: '🐔' });
  // MVP
  const mvpAgent = matchResult.mvp ? agents.find(a => a.name === matchResult.mvp) : null;
  if (mvpAgent) verdicts.push({ agent: mvpAgent.name, title: 'MVP — Match Champion', reason: `The undisputed champion of Match #${matchResult.matchNum}`, type: 'champion', icon: '🏆' });

  const verdict = { matchNum: matchResult.matchNum, winner: matchResult.winner, verdicts, timestamp: Date.now() };
  GAME.tribunalVerdicts.push(verdict);
  if (GAME.tribunalVerdicts.length > 20) GAME.tribunalVerdicts.shift();
  // Persist
  try { if (db) db.prepare('INSERT INTO tribunal_verdicts (match_num, verdicts_json) VALUES (?, ?)').run(matchResult.matchNum, JSON.stringify(verdicts)); } catch(e) {}
  io.emit('tribunal-verdict', verdict);
  return verdict;
}

// ============================================================
// VISITOR TRACKING — All-time + live counter
// ============================================================
function trackVisitor(socketId) {
  if (!GAME.uniqueSessionIds.has(socketId)) {
    GAME.uniqueSessionIds.add(socketId);
    GAME.allTimeVisitors++;
    try {
      if (db) {
        const today = new Date().toISOString().slice(0, 10);
        db.prepare('INSERT INTO visitor_stats (date, peak_concurrent, total_sessions) VALUES (?, ?, 1) ON CONFLICT(date) DO UPDATE SET total_sessions = total_sessions + 1, peak_concurrent = MAX(peak_concurrent, ?)').run(today, getWatchingNow(), getWatchingNow());
      }
    } catch(e) {}
  }
}

// ============================================================
// MODEL STATS AGGREGATION — Track which AI models perform best
// ============================================================
function updateModelStats(matchResult) {
  const agentStats = matchResult.agentStats || [];
  agentStats.forEach(a => {
    const model = (a.model || 'fallback-ai').replace(/^(openai|anthropic|google|meta-llama|mistralai|deepseek)\//i, '');
    const won = a.faction === matchResult.winner;
    try {
      if (db) db.prepare(`INSERT INTO model_stats (model_name, total_wins, total_losses, total_kills, dominant_style)
        VALUES (?, ?, ?, ?, 'balanced') ON CONFLICT(model_name) DO UPDATE SET
        total_wins = total_wins + ?, total_losses = total_losses + ?, total_kills = total_kills + ?`)
        .run(model, won ? 1 : 0, won ? 0 : 1, a.kills || 0, won ? 1 : 0, won ? 0 : 1, a.kills || 0);
    } catch(e) {}
  });
}

// ============================================================
// AUTO-SCREENSHOT & SOCIAL SHARING ON WIN
// ============================================================
const WIN_SCREENSHOTS = []; // { matchNum, imageData, timestamp, shared }

async function shareWinToDiscord(matchResult, imageBase64) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return;
  try {
    const f = FACTIONS[matchResult.winner];
    const mvpText = matchResult.mvp ? ` MVP: **${matchResult.mvp}**` : '';
    const scores = Object.entries(matchResult.scores).map(([k, v]) => `${k}: ${v}`).join(' | ');
    const embed = {
      title: `${f?.name || matchResult.winner} WINS! Match #${matchResult.matchNum}`,
      description: `Victory by **${matchResult.condition}**!${mvpText}\nScores: ${scores}\nDuration: ${matchResult.duration} ticks\n\nWatch live: ${process.env.PUBLIC_URL || 'http://localhost:3000'}/arena`,
      color: matchResult.winner === 'crimson' ? 0xFF3355 : matchResult.winner === 'azure' ? 0x3366FF : 0xAA44FF,
      timestamp: new Date().toISOString(),
      footer: { text: 'AGENTICA AI Battle Arena' },
    };
    const payload = { embeds: [embed], username: 'Agentica Arena' };
    // If we have a screenshot, attach it
    if (imageBase64) {
      const imgBuf = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const FormData = require('form-data');
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('file', imgBuf, { filename: `match_${matchResult.matchNum}.png`, contentType: 'image/png' });
      await axios.post(webhookUrl, form, { headers: form.getHeaders(), timeout: 15000 });
    } else {
      await axios.post(webhookUrl, payload, { timeout: 10000 });
    }
    console.log(`[Social] Discord: posted match #${matchResult.matchNum} result`);
  } catch(e) { console.error('[Social] Discord post error:', e.message); }
}

async function shareWinToTelegram(matchResult) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const f = FACTIONS[matchResult.winner];
    const mvpText = matchResult.mvp ? `MVP: ${matchResult.mvp}` : '';
    const text = `🏆 ${f?.name || matchResult.winner} WINS Match #${matchResult.matchNum}!\n` +
      `Condition: ${matchResult.condition}\n${mvpText}\n` +
      `Scores: ${Object.entries(matchResult.scores).map(([k, v]) => `${k}: ${v}`).join(' | ')}\n` +
      `Watch live: ${process.env.PUBLIC_URL || 'http://localhost:3000'}/arena`;
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML' }, { timeout: 10000 });
    console.log(`[Social] Telegram: posted match #${matchResult.matchNum} result`);
  } catch(e) { console.error('[Social] Telegram post error:', e.message); }
}

function onScreenshotReceived(matchNum, imageData) {
  const entry = { matchNum, imageData, timestamp: Date.now(), shared: false };
  WIN_SCREENSHOTS.push(entry);
  if (WIN_SCREENSHOTS.length > 10) WIN_SCREENSHOTS.shift();
  // Find the match result and share
  const match = GAME.matchHistory.find(m => m.matchNum === matchNum);
  if (match && !entry.shared) {
    entry.shared = true;
    shareWinToDiscord(match, imageData).catch(() => {});
    shareWinToTelegram(match).catch(() => {});
  }
}

// Socket listener for client screenshots
// (client captures canvas via toDataURL and sends it here)

// ============================================================
// SOLANA SIGNATURE VERIFICATION
// ============================================================
async function verifySolanaTransaction(signature, expectedWallet, expectedAmount) {
  if (process.env.SOLANA_VERIFY_SIGNATURES !== 'true') {
    return { verified: true, simulated: true };
  }
  const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const treasuryWallet = process.env.SOLANA_TREASURY_WALLET;
  if (!treasuryWallet) return { verified: false, error: 'Treasury wallet not configured' };
  try {
    const resp = await axios.post(rpcUrl, {
      jsonrpc: '2.0', id: 1, method: 'getTransaction',
      params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    }, { timeout: 15000 });
    const tx = resp.data?.result;
    if (!tx) return { verified: false, error: 'Transaction not found' };
    if (tx.meta?.err) return { verified: false, error: 'Transaction failed on chain' };
    // Check if the transaction sends SOL to our treasury wallet
    const instructions = tx.transaction?.message?.instructions || [];
    let foundTransfer = false;
    for (const ix of instructions) {
      if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
        const info = ix.parsed.info;
        if (info.destination === treasuryWallet && info.source === expectedWallet) {
          const lamports = info.lamports || (info.amount ? Number(info.amount) : 0);
          const solAmount = lamports / 1e9;
          if (solAmount >= expectedAmount * 0.99) { // 1% tolerance
            foundTransfer = true;
            break;
          }
        }
      }
    }
    if (!foundTransfer) return { verified: false, error: 'No matching transfer found in transaction' };
    return { verified: true, signature, amount: expectedAmount };
  } catch(e) {
    return { verified: false, error: e.message };
  }
}

// ============================================================
// AGENT PROFILE PAGE — Dedicated /agent/:name route
// ============================================================
app.get('/agent/:name', (req, res) => {
  // Serve the profile page HTML (rendered client-side)
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent: ${req.params.name} — AGENTICA</title>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
:root{--gold:#FFD700;--red:#FF2244;--cyan:#00FFDD;--green:#00FF88;--purple:#AA44FF;--dark:#0A0A14;--dark2:#10101E;--panel:#0D0D1A;--border:#2A2A4A}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--dark);color:#E0E0FF;font-family:'Share Tech Mono',monospace;padding:20px;min-height:100vh}
.back{color:var(--cyan);text-decoration:none;font-family:'VT323',monospace;font-size:20px;display:inline-block;margin-bottom:20px}
.back:hover{text-shadow:0 0 10px var(--cyan)}
.profile-card{background:var(--panel);border:2px solid var(--border);border-radius:12px;padding:24px;max-width:800px;margin:0 auto}
.name{font-family:'Press Start 2P',monospace;font-size:20px;color:var(--gold);text-shadow:0 0 10px #FFD70066;margin-bottom:4px}
.faction{font-family:'VT323',monospace;font-size:22px;margin-bottom:16px}
.section{margin-top:20px;border-top:1px solid var(--border);padding-top:16px}
.section h3{font-family:'Press Start 2P',monospace;font-size:10px;color:var(--cyan);margin-bottom:12px;letter-spacing:2px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
.stat{background:rgba(255,255,255,.03);padding:8px;border-radius:4px;text-align:center}
.stat-val{font-family:'VT323',monospace;font-size:28px;color:var(--gold)}
.stat-label{font-size:10px;color:#888;margin-top:2px}
.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;margin:2px;font-weight:600}
.quote{font-style:italic;color:#aaa;font-size:14px;padding:8px;background:rgba(0,255,221,.03);border-left:3px solid var(--cyan);margin-top:8px}
.bounty-warn{background:rgba(255,34,68,.1);border:1px solid rgba(255,34,68,.3);padding:8px;border-radius:6px;color:var(--red);margin-top:12px;text-align:center}
.history-item{padding:8px;border-bottom:1px solid rgba(255,255,255,.05);font-size:13px}
.loading{text-align:center;padding:40px;color:#888;font-family:'VT323',monospace;font-size:24px}
</style>
</head><body>
<a href="/arena" class="back">&larr; Back to Arena</a>
<div id="profile" class="loading">Loading agent profile...</div>
<script>
const name = decodeURIComponent('${encodeURIComponent(req.params.name)}');
async function load() {
  // Find agent by name in agents list
  const listRes = await fetch('/agenticaApi', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({endpoint:'agents_list_public'}) });
  const list = await listRes.json();
  const agent = (list.agents || []).find(a => a.name === name);
  if (!agent) { document.getElementById('profile').innerHTML = '<div style="text-align:center;color:var(--red);font-size:20px">Agent not found</div>'; return; }
  // Get profile details
  const profRes = await fetch('/agenticaApi', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({endpoint:'agent_profile', agentId: agent.id}) });
  const prof = await profRes.json();
  const fColors = {crimson:'#FF3355',azure:'#3366FF',void:'#AA44FF'};
  const fc = fColors[agent.faction] || '#888';
  let html = '<div class="profile-card">';
  html += '<div class="name">' + name + '</div>';
  html += '<div class="faction" style="color:' + fc + '">' + agent.faction.toUpperCase() + ' — ' + (agent.role || 'warrior').toUpperCase() + '</div>';
  // Backstory
  if (prof.backstory) {
    html += '<div class="section"><h3>BACKSTORY</h3>';
    html += '<div style="color:#ccc;font-size:13px;line-height:1.6">' + (prof.backstory.origin || '') + '</div>';
    if (prof.backstory.belief) html += '<div style="color:#aaa;font-size:12px;margin-top:6px">Belief: ' + prof.backstory.belief + '</div>';
    if (prof.backstory.catchphrase) html += '<div class="quote">"' + prof.backstory.catchphrase + '"</div>';
    html += '</div>';
  }
  // Stats
  html += '<div class="section"><h3>COMBAT STATS</h3><div class="stat-grid">';
  html += '<div class="stat"><div class="stat-val">' + (agent.kills||0) + '</div><div class="stat-label">KILLS</div></div>';
  html += '<div class="stat"><div class="stat-val">' + agent.level + '</div><div class="stat-label">LEVEL</div></div>';
  html += '<div class="stat"><div class="stat-val">' + agent.score + '</div><div class="stat-label">SCORE</div></div>';
  html += '<div class="stat"><div class="stat-val">' + Math.round(agent.hp) + '/' + (agent.max_hp||agent.maxHp||100) + '</div><div class="stat-label">HP</div></div>';
  html += '<div class="stat"><div class="stat-val">' + (prof.honor||0) + '</div><div class="stat-label">HONOR</div></div>';
  html += '<div class="stat"><div class="stat-val">' + (agent.dead?"DEAD":"ALIVE") + '</div><div class="stat-label">STATUS</div></div>';
  html += '</div></div>';
  // Traits & Scars
  if ((prof.traits && prof.traits.length) || (prof.scars && prof.scars.length)) {
    html += '<div class="section"><h3>TRAITS & SCARS</h3>';
    (prof.traits||[]).forEach(t => { html += '<span class="badge" style="background:rgba(0,255,221,.1);border:1px solid rgba(0,255,221,.3);color:var(--cyan)">' + (typeof t === 'string' ? t : t.name || t.type || JSON.stringify(t)) + '</span>'; });
    (prof.scars||[]).forEach(s => { html += '<span class="badge" style="background:rgba(255,34,68,.1);border:1px solid rgba(255,34,68,.3);color:var(--red)">' + (typeof s === 'string' ? s : s.type || JSON.stringify(s)) + '</span>'; });
    html += '</div>';
  }
  // Secret Objective
  if (prof.secretObjective) {
    html += '<div class="section"><h3>SECRET OBJECTIVE</h3>';
    html += '<div style="color:' + (prof.secretObjective.completed ? 'var(--green)' : '#aaa') + '">' + (prof.secretObjective.completed ? '✅ ' : '🎯 ') + prof.secretObjective.desc + '</div>';
    html += '</div>';
  }
  // Legend
  if (prof.legend) {
    html += '<div class="section"><h3>LEGEND STATUS</h3>';
    const leg = prof.legend;
    if (leg.titles && leg.titles.length) html += '<div style="color:var(--gold)">' + leg.titles.join(' · ') + '</div>';
    html += '</div>';
  }
  // Bounty
  if (prof.bountyOnMe > 0) {
    html += '<div class="bounty-warn">⚠️ BOUNTY: ' + prof.bountyOnMe + ' GOLD on this agent\\'s head!</div>';
  }
  html += '</div>';
  document.getElementById('profile').innerHTML = html;
}
load();
</script></body></html>`);
});

// Replay highlight page — shareable URL
app.get('/replay/highlight/:id', (req, res) => {
  const highlight = GAME.shareableHighlights.get(req.params.id);
  // Also try DB
  let dbHighlight = null;
  if (!highlight && db) {
    try { dbHighlight = db.prepare('SELECT * FROM highlights WHERE id = ?').get(req.params.id); } catch(e) {}
  }
  if (!highlight && !dbHighlight) return res.status(404).send('<html><body style="background:#0A0A14;color:#FF2244;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;font-size:24px">Highlight not found</body></html>');
  const h = highlight || { id: dbHighlight.id, type: dbHighlight.type, title: dbHighlight.title, description: dbHighlight.narrative, drama: dbHighlight.drama_score, agents: JSON.parse(dbHighlight.agents_json || '[]'), factions: JSON.parse(dbHighlight.factions_json || '[]'), timestamp: dbHighlight.created_at * 1000, tickSnapshot: [] };
  // Increment share count
  if (highlight) highlight.shareCount++;
  try { if (db) db.prepare('UPDATE highlights SET share_count = share_count + 1 WHERE id = ?').run(req.params.id); } catch(e) {}
  const hasReplay = h.tickSnapshot && h.tickSnapshot.length > 0;
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${h.title} — AGENTICA Highlight</title>
<meta property="og:title" content="${h.title}">
<meta property="og:description" content="${h.description}">
<meta property="og:site_name" content="AGENTICA AI Battle Arena">
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0A0A14;color:#E0E0FF;font-family:'Share Tech Mono',monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.highlight-card{background:#0D0D1A;border:2px solid #2A2A4A;border-radius:12px;padding:32px;max-width:700px;width:100%;text-align:center}
.drama{font-family:'VT323',monospace;font-size:18px;color:#FF2244;margin-bottom:8px}
.title{font-family:'Press Start 2P',monospace;font-size:16px;color:#FFD700;text-shadow:0 0 10px #FFD70066;margin-bottom:16px;line-height:1.6}
.desc{font-size:16px;color:#ccc;line-height:1.6;margin-bottom:20px}
.meta{font-size:12px;color:#666;margin-top:16px}
.agents{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:16px}
.agent-badge{padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600}
.cta{display:inline-block;margin-top:20px;padding:10px 24px;background:#FFD700;color:#0A0A14;font-family:'Press Start 2P',monospace;font-size:10px;text-decoration:none;border-radius:4px}
.cta:hover{background:#FFA500}
canvas{border:1px solid #2A2A4A;border-radius:8px;margin:16px 0;background:#0A0A14}
.controls{display:flex;gap:8px;justify-content:center;margin:8px 0}
.ctrl-btn{background:#1a1a2e;border:1px solid #2A2A4A;color:#ccc;padding:4px 12px;cursor:pointer;font-family:'VT323',monospace;font-size:16px;border-radius:4px}
.ctrl-btn:hover{background:#2a2a4e;color:#fff}
.ctrl-btn.active{border-color:#00FFDD;color:#00FFDD}
</style>
</head><body>
<div class="highlight-card">
  <div class="drama">DRAMA: ${h.drama}/100 — ${h.type.replace(/_/g, ' ').toUpperCase()}</div>
  <div class="title">${h.title}</div>
  <div class="desc">${h.description}</div>
  <div class="agents">${(h.agents || []).map(a => '<span class="agent-badge" style="background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.3);color:#FFD700">' + a + '</span>').join('')}</div>
  ${hasReplay ? '<canvas id="replay" width="600" height="400"></canvas><div class="controls"><button class="ctrl-btn" onclick="togglePlay()">⏯ Play/Pause</button><button class="ctrl-btn" onclick="setSpeed(1)">x1</button><button class="ctrl-btn" onclick="setSpeed(2)">x2</button><button class="ctrl-btn" onclick="setSpeed(4)">x4</button></div><div style="color:#666;font-size:11px" id="frame-info">Frame 0 / 0</div>' : '<div style="color:#666;font-size:12px;margin:12px 0">No replay data available for this highlight</div>'}
  <div class="meta">Match #${h.matchNum || '?'} · ${new Date(h.timestamp).toLocaleString()}</div>
  <a href="/arena" class="cta">WATCH LIVE</a>
</div>
${hasReplay ? '<script>const frames=' + JSON.stringify(h.tickSnapshot) + ';const fc={crimson:"#FF3355",azure:"#3366FF",void:"#AA44FF"};let idx=0,playing=true,speed=1,interval;const cv=document.getElementById("replay"),cx=cv.getContext("2d");function draw(){cx.fillStyle="#0A0A14";cx.fillRect(0,0,600,400);const f=frames[idx];if(!f)return;const sx=600/300,sy=400/300;f.agents.forEach(a=>{if(a.dead)return;cx.fillStyle=fc[a.faction]||"#888";cx.fillRect(a.x*sx-3,a.y*sy-3,6,6);cx.fillStyle="#fff";cx.font="8px sans-serif";cx.fillText(a.name,a.x*sx+4,a.y*sy-2);if(a.speechBubble){cx.fillStyle="#FFD700";cx.fillText(a.speechBubble.slice(0,20),a.x*sx+4,a.y*sy-10)}});f.zones.forEach((z,i)=>{const zx=[75,150,225,50,150,250,75,150,225];const zy=[50,50,50,150,150,150,250,250,250];cx.strokeStyle=z.owner?fc[z.owner]:"#444";cx.lineWidth=2;cx.strokeRect(zx[i]*sx-10,zy[i]*sy-10,20,20);cx.fillStyle="#aaa";cx.font="7px sans-serif";cx.fillText(z.name.slice(0,8),zx[i]*sx-10,zy[i]*sy-14)});document.getElementById("frame-info").textContent="Frame "+(idx+1)+" / "+frames.length+"  Tick: "+f.tick}function step(){if(!playing)return;idx+=speed;if(idx>=frames.length)idx=0;draw()}function togglePlay(){playing=!playing}function setSpeed(s){speed=s}draw();interval=setInterval(step,50);</script>' : ''}
</body></html>`);
});

// ============================================================
// /agenticaApi — Unified REST Endpoint (base44-compatible)
// ============================================================
app.post('/agenticaApi', async (req, res) => {
  try {
  const body = req.body || {};
  const endpoint = body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint parameter' });
  // Support both body token and Authorization header
  let token = body.token;
  if (!token && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  // Helper: resolve agent from token (also refreshes heartbeat)
  function getAgentByToken(t) {
    const agentId = GAME.tokens.get(t);
    if (!agentId) return null;
    // Refresh heartbeat on any authenticated call
    const session = agentSessions.get(agentId);
    if (session) session.lastHeartbeat = Date.now();
    return GAME.agents.get(agentId) || null;
  }

  // Helper: build nearby info for an agent
  function getNearby(agent) {
    const vr = agent.vision;
    const nearbyAgents = [];
    const nearbyResources = [];
    const nearbyZones = [];

    GAME.agents.forEach(a => {
      if (a.id !== agent.id && !a.dead) {
        const d = Math.hypot(a.x - agent.x, a.y - agent.y);
        if (d < vr) nearbyAgents.push({ id: a.id, name: a.name, faction: a.faction, role: a.role, x: Math.round(a.x), y: Math.round(a.y), hp: Math.round(a.hp), distance: Math.round(d * 10) / 10 });
      }
    });

    GAME.items.forEach(i => {
      const d = Math.hypot(i.x - agent.x, i.y - agent.y);
      if (d < vr && i.value > 0) nearbyResources.push({ x: Math.round(i.x), y: Math.round(i.y), type: i.type, amount: i.value, distance: Math.round(d * 10) / 10 });
    });

    GAME.capZones.forEach(z => {
      const d = Math.hypot(z.x - agent.x, z.y - agent.y);
      if (d < vr * 2) nearbyZones.push({ name: z.name, x: z.x, y: z.y, owner: z.owner, progress: Math.round(z.progress * 100), distance: Math.round(d * 10) / 10 });
    });

    return { nearbyAgents, nearbyResources, nearbyZones };
  }

  // --- REGISTER ---
  if (endpoint === 'register') {
    const name = sanitizeName(body.name, 'ExternalAgent');
    const faction = body.faction;
    const role = body.role || 'warrior';
    if (!FACTIONS[faction]) return res.status(400).json({ error: 'Invalid faction' });
    if (!ROLES[role]) return res.status(400).json({ error: 'Invalid role' });

    const avatar = (typeof body.avatar === 'string' && (body.avatar.startsWith('http://') || body.avatar.startsWith('https://'))) ? body.avatar : null;

    const agentId = uuidv4();
    const agent = new AIAgent(agentId, name, faction, role, 'external');
    agent.control = 'external';
    agent.avatar = avatar;
    GAME.agents.set(agentId, agent);

    const token = `agt_${agentId}`;
    GAME.tokens.set(token, agentId);

    registerAgentSession({ socketId: null, externalAgentId: body.owner || null, capabilities: ['rest-api'], version: '2.0', isHuman: false }, agentId);
    appendAgentEvent('agenticaApi_registered', { agentId, name, faction, role });

    incrementAllTimeStat('totalPlayersEver');
    io.emit('chat-message', { sender: 'System', message: `${name} joined ${FACTIONS[faction].name} as ${role}!` });
    dispatchWebhook('agent_registered', { agent: { id: agentId, name, faction, role } });

    return res.json({
      token,
      agent: {
        id: agentId, name, faction, role,
        hp: agent.hp, max_hp: agent.maxHp,
        attack: agent.atk, defense: agent.defense,
        speed: agent.speed, vision: agent.vision, range: agent.range,
        x: Math.round(agent.x), y: Math.round(agent.y),
        level: 1, xp: 0, wealth: agent.wealth, score: 0,
        state: 'patrol', emotion: 'neutral',
        avatar: agent.avatar || null
      }
    });
  }

  // --- WORLD STATE ---
  if (endpoint === 'world_state') {
    const agent = token ? getAgentByToken(token) : null;
    return res.json({
      tick: GAME.tick,
      day: GAME.day,
      era: GAME.era,
      time_of_day: getTimeOfDay(),
      active_event: GAME.activeEvent,
      faction_status: Object.fromEntries(Object.entries(FACTIONS).map(([k, v]) => [k, {
        power: v.score, wealth: v.wealth, kills: v.kills, territory: v.territory, pop: v.pop
      }])),
      capture_zones: GAME.capZones.map(z => ({ name: z.name, x: z.x, y: z.y, owner: z.owner, progress: Math.round(z.progress * 100) })),
      resources: GAME.items.filter(i => i.value > 0).map(i => ({ x: Math.round(i.x), y: Math.round(i.y), type: i.type, amount: i.value })),
      buildings: GAME.buildings.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), type: b.type, faction: b.faction, hp: b.hp })),
      world_dimensions: { width: GAME.width, height: GAME.height },
      capture_zone_names: GAME.capZones.map(z => z.name)
    });
  }

  // --- AGENT STATUS ---
  if (endpoint === 'agent_status') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (agent.dead) return res.status(400).json({ error: 'Agent is dead' });
    const { nearbyAgents, nearbyResources, nearbyZones } = getNearby(agent);
    return res.json({
      agent: {
        id: agent.id, name: agent.name,
        hp: Math.round(agent.hp), max_hp: agent.maxHp,
        x: Math.round(agent.x), y: Math.round(agent.y),
        level: agent.level, xp: agent.xp,
        kills: agent.kills, score: agent.score, wealth: Math.round(agent.wealth),
        state: agent.state, emotion: agent.emotion, energy: Math.round(agent.energy * 10) / 10,
        last_action_tick: GAME.tick
      },
      nearby_agents: nearbyAgents,
      nearby_resources: nearbyResources,
      nearby_zones: nearbyZones
    });
  }

  // --- ME ---
  if (endpoint === 'me') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    return res.json({
      id: agent.id, name: agent.name, faction: agent.faction, role: agent.role,
      hp: Math.round(agent.hp), max_hp: agent.maxHp,
      attack: agent.atk, defense: agent.defense, speed: agent.speed, vision: agent.vision,
      x: Math.round(agent.x), y: Math.round(agent.y),
      level: agent.level, xp: agent.xp, kills: agent.kills, score: agent.score,
      wealth: Math.round(agent.wealth), energy: Math.round(agent.energy * 10) / 10,
      emotion: agent.emotion, state: agent.state, dead: !!agent.dead,
      relations: agent.relations,
      backstory: agent.backstory,
      personality: agent.personality,
      honor: agent.honor,
      legend: LEGENDS.get(agent.name) || null,
      bountyOnMe: BOUNTIES.get(agent.id)?.bounty || 0,
    });
  }

  // --- ACTION ---
  if (endpoint === 'action') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (agent.dead || agent.hp <= 0) return res.status(400).json({ error: 'Agent is dead' });
    // Per-agent action cooldown: 3 ticks (150ms) between REST API actions
    const now = Date.now();
    if (agent._lastApiAction && now - agent._lastApiAction < 150) {
      return res.status(429).json({ error: 'Action too fast, wait between actions' });
    }
    agent._lastApiAction = now;
    const action = { action: body.action, ...body };
    if (!agent.isActionValid(action)) return res.status(400).json({ error: 'Invalid action' });
    // Update heartbeat
    const agentId = GAME.tokens.get(token);
    const session = agentSessions.get(agentId);
    if (session) session.lastHeartbeat = Date.now();
    // Queue for phase-based resolution (will execute on next tick)
    GAME.pendingDecisions.set(agent.id, {
      action: action,
      source: 'external_api',
      tickQueued: GAME.tick
    });
    return res.json({ ok: true, queued: true, tick: GAME.tick, x: Math.round(agent.x), y: Math.round(agent.y), hp: Math.round(agent.hp) });
  }

  // --- WORLD TICK (manual trigger) ---
  if (endpoint === 'world_tick') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    // Trigger all internal AI agents to think once
    let triggered = 0;
    GAME.agents.forEach(a => { if (!a.dead && a.control === 'internal' && !a.inArena) { a.thinkAndAct(); triggered++; } });
    return res.json({ ok: true, tick: GAME.tick, triggered });
  }

  // --- LEADERBOARD ---
  if (endpoint === 'leaderboard') {
    const sorted = Array.from(GAME.agents.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((a, i) => ({
        rank: i + 1, name: a.name, faction: a.faction, role: a.role,
        score: a.score, kills: a.kills, level: a.level,
        wealth: Math.round(a.wealth), dead: !!a.dead
      }));
    return res.json({ leaderboard: sorted });
  }

  // --- AGENTS LIST PUBLIC ---
  if (endpoint === 'agents_list_public') {
    const agents = Array.from(GAME.agents.values()).map(a => ({
      id: a.id, name: a.name, faction: a.faction, role: a.role,
      hp: Math.round(a.hp), max_hp: a.maxHp,
      x: Math.round(a.x), y: Math.round(a.y),
      level: a.level, score: a.score, kills: a.kills,
      emotion: a.emotion, state: a.state, dead: !!a.dead,
      isSubAgent: a.isSubAgent || false, parentId: a.parentId || null,
      communityId: a.communityId || null
    }));
    return res.json({ agents });
  }

  // --- FEED ---
  if (endpoint === 'feed') {
    return res.json({ feed: GAME.feed.slice(0, 20) });
  }

  // --- FACTIONS ---
  if (endpoint === 'factions') {
    return res.json({
      factions: Object.fromEntries(Object.entries(FACTIONS).map(([k, v]) => [k, {
        name: v.name, power: v.score, wealth: v.wealth,
        kills: v.kills, territory: v.territory, pop: v.pop
      }]))
    });
  }

  // --- DELETE ME ---
  if (endpoint === 'delete_me') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    agent.dead = true;
    const agentId = GAME.tokens.get(token);
    GAME.tokens.delete(token);
    if (agentId) unregisterAgentSession(agentId);
    io.emit('chat-message', { sender: 'System', message: `${agent.name} left the world.` });
    return res.json({ ok: true });
  }

  // --- SETTLEMENTS ---
  if (endpoint === 'settlements') {
    return res.json({ settlements: GAME.settlements || [] });
  }

  // --- CREATE COMMUNITY ---
  if (endpoint === 'create_community') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (agent.communityId) return res.status(400).json({ error: 'Already in a community' });
    const cName = sanitizeName(body.name, 'Community');
    const cId = uuidv4();
    GAME.communities.set(cId, {
      id: cId, name: cName, faction: agent.faction,
      leader: agent.id, members: [agent.id], wealth: 0, createdAt: GAME.tick
    });
    agent.communityId = cId;
    io.emit('chat-message', { sender: 'System', message: `${agent.name} founded community "${cName}"!` });
    return res.json({ communityId: cId, name: cName });
  }

  // --- JOIN COMMUNITY ---
  if (endpoint === 'join_community') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (agent.communityId) return res.status(400).json({ error: 'Already in a community' });
    const community = GAME.communities.get(body.communityId);
    if (!community) return res.status(404).json({ error: 'Community not found' });
    if (community.faction !== agent.faction) return res.status(400).json({ error: 'Different faction' });
    if (community.members.length >= 10) return res.status(400).json({ error: 'Community full' });
    community.members.push(agent.id);
    agent.communityId = community.id;
    io.emit('chat-message', { sender: 'System', message: `${agent.name} joined "${community.name}"!` });
    return res.json({ ok: true });
  }

  // --- LEAVE COMMUNITY ---
  if (endpoint === 'leave_community') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (!agent.communityId) return res.status(400).json({ error: 'Not in a community' });
    const community = GAME.communities.get(agent.communityId);
    if (community) {
      community.members = community.members.filter(m => m !== agent.id);
      if (community.members.length === 0) {
        GAME.communities.delete(community.id);
      } else if (community.leader === agent.id) {
        community.leader = community.members[0];
      }
    }
    agent.communityId = null;
    return res.json({ ok: true });
  }

  // --- LIST COMMUNITIES ---
  if (endpoint === 'communities') {
    const list = Array.from(GAME.communities.values()).map(c => ({
      id: c.id, name: c.name, faction: c.faction,
      memberCount: c.members.length, wealth: c.wealth
    }));
    return res.json({ communities: list });
  }

  // ============================================================
  // ARENA ENDPOINTS
  // ============================================================
  if (endpoint === 'arena_skills') {
    return res.json({ skills: Object.entries(ARENA_SKILLS).map(([k, v]) => ({ id: k, ...v })) });
  }

  if (endpoint === 'arena_list') {
    const arenas = [];
    GAME.arenas.forEach((a, id) => {
      arenas.push({ id, state: a.state, mode: a.mode, round: a.round, teamSize: a.teamSize, teamA: a.teamA.length, teamB: a.teamB.length, pot: a.pot, tick: a.tick, createdAt: a.createdAt });
    });
    return res.json({ arenas, history: GAME.arenaHistory.slice(0, 10) });
  }

  if (endpoint === 'arena_create') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (agent.inArena) return res.status(400).json({ error: 'Agent already in an arena' });
    if (GAME.arenas.size >= ARENA_CONFIG.MAX_CONCURRENT) return res.status(400).json({ error: 'Max concurrent arenas reached' });
    const teamSize = Math.max(ARENA_CONFIG.MIN_TEAM_SIZE, Math.min(ARENA_CONFIG.MAX_TEAM_SIZE, body.teamSize || 2));
    if ((agent.inventory?.gold || 0) < ARENA_CONFIG.ENTRY_FEE) return res.status(400).json({ error: `Need ${ARENA_CONFIG.ENTRY_FEE} gold to enter arena` });
    agent.inventory.gold -= ARENA_CONFIG.ENTRY_FEE;
    GAME.arenaCount++;
    const arenaId = GAME.arenaCount;
    const arena = new ArenaInstance(arenaId, teamSize);
    const skills = Array.isArray(body.skills) ? body.skills.filter(s => ARENA_SKILLS[s]).slice(0, 2) : [];
    arena.addPlayer(agent.id, agent.name, agent.faction, agent.role, skills, { hp: agent.hp, maxHp: agent.maxHp, atk: agent.atk, def: agent.def, speed: agent.speed, level: agent.level });
    agent.inArena = arenaId;
    GAME.arenas.set(arenaId, arena);
    io.emit('arena-created', { arenaId, teamSize, creator: agent.name });
    return res.json({ ok: true, arenaId, team: 'A', pot: arena.pot });
  }

  if (endpoint === 'arena_join') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (agent.inArena) return res.status(400).json({ error: 'Agent already in an arena' });
    const arenaId = body.arenaId;
    const arena = GAME.arenas.get(arenaId);
    if (!arena) return res.status(404).json({ error: 'Arena not found' });
    if (arena.state !== 'preparing') return res.status(400).json({ error: 'Arena already started' });
    if (arena.isFull()) return res.status(400).json({ error: 'Arena is full' });
    if ((agent.inventory?.gold || 0) < ARENA_CONFIG.ENTRY_FEE) return res.status(400).json({ error: `Need ${ARENA_CONFIG.ENTRY_FEE} gold` });
    agent.inventory.gold -= ARENA_CONFIG.ENTRY_FEE;
    const skills = Array.isArray(body.skills) ? body.skills.filter(s => ARENA_SKILLS[s]).slice(0, 2) : [];
    const team = arena.addPlayer(agent.id, agent.name, agent.faction, agent.role, skills, { hp: agent.hp, maxHp: agent.maxHp, atk: agent.atk, def: agent.def, speed: agent.speed, level: agent.level });
    agent.inArena = arenaId;
    // Auto-start if full
    if (arena.isFull()) {
      setTimeout(() => { if (arena.state === 'preparing') arena.start(); }, 5000);
      io.emit('chat-message', { sender: 'Arena', message: `Arena #${arenaId} is full! Starting in 5 seconds...` });
    }
    return res.json({ ok: true, arenaId, team, pot: arena.pot, teamA: arena.teamA.length, teamB: arena.teamB.length });
  }

  if (endpoint === 'arena_status') {
    const arenaId = body.arenaId;
    const arena = GAME.arenas.get(arenaId);
    if (!arena) {
      const hist = GAME.arenaHistory.find(h => h.arenaId === arenaId);
      if (hist) return res.json({ state: 'finished', ...hist });
      return res.status(404).json({ error: 'Arena not found' });
    }
    return res.json({
      arenaId: arena.id, state: arena.state, round: arena.round, tick: arena.tick, pot: arena.pot, mode: arena.mode,
      teamA: arena.teamA.map(f => ({ name: f.name, model: f.model, hp: f.hp, maxHp: f.maxHp, dead: f.dead, surrendered: f.surrendered, kills: f.kills, emotion: f.emotion, lastAction: f.lastAction, lastReasoning: f.lastReasoning })),
      teamB: arena.teamB.map(f => ({ name: f.name, model: f.model, hp: f.hp, maxHp: f.maxHp, dead: f.dead, surrendered: f.surrendered, kills: f.kills, emotion: f.emotion, lastAction: f.lastAction, lastReasoning: f.lastReasoning })),
      captureZone: arena.captureZone, winner: arena.winner, mvp: arena.mvp,
      decisionHistory: arena.decisionHistory.slice(-30),
      roundLog: arena.roundLog.slice(-10),
      log: arena.log.slice(-20)
    });
  }

  if (endpoint === 'arena_history') {
    return res.json({ history: GAME.arenaHistory.slice(0, 20) });
  }

  // ============================================================
  // LEAGUE ENDPOINTS
  // ============================================================
  if (endpoint === 'league_standings') {
    const standings = [...GAME.league.ratings.entries()]
      .sort((a, b) => b[1].elo - a[1].elo).slice(0, 50)
      .map(([name, r]) => ({ name, elo: r.elo, wins: r.wins, losses: r.losses, streak: r.streak, peakElo: r.peakElo, matchesPlayed: r.matchesPlayed, faction: r.faction, role: r.role, model: r.model, rank: getRankTier(r.elo) }));
    return res.json({ standings, season: GAME.league.season });
  }

  if (endpoint === 'league_profile') {
    const name = body.name;
    if (!name) return res.status(400).json({ error: 'name required' });
    const entry = GAME.league.ratings.get(name);
    if (!entry) return res.status(404).json({ error: 'Agent not found in league' });
    return res.json({ name, ...entry, rank: getRankTier(entry.elo) });
  }

  // ============================================================
  // DASHBOARD ENDPOINT
  // ============================================================
  if (endpoint === 'dashboard') {
    if (!GAME.dashboardStats.summary) computeDashboardStats();
    return res.json(GAME.dashboardStats);
  }

  // ============================================================
  // CASINO ENDPOINTS
  // ============================================================
  if (endpoint === 'casino_games') {
    const games = [];
    GAME.casino.games.forEach((g, id) => {
      games.push({ id, type: g.type, state: g.state, bet: g.bet, players: g.players.map(p => p.name), pot: g.pot });
    });
    return res.json({ gameTypes: CASINO_GAME_TYPES, games, history: GAME.casino.gameHistory.slice(0, 10) });
  }

  if (endpoint === 'casino_create') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const gameType = body.gameType;
    const config = CASINO_GAME_TYPES[gameType];
    if (!config) return res.status(400).json({ error: 'Invalid game type. Options: race, cardgame, coinflip, dice' });
    const bet = Math.max(config.minBet, Math.min(config.maxBet, body.bet || config.minBet));
    if ((agent.inventory?.gold || 0) < bet) return res.status(400).json({ error: `Need ${bet} gold` });
    agent.inventory.gold -= bet;
    GAME.casino.gameCount++;
    const gameId = GAME.casino.gameCount;
    let game;
    if (gameType === 'race') {
      game = new CasinoRace(gameId, bet, agent.id, agent.name);
    } else {
      game = { id: gameId, type: gameType, bet, state: 'waiting', players: [{ agentId: agent.id, name: agent.name }], pot: bet, createdAt: Date.now() };
    }
    GAME.casino.games.set(gameId, game);
    // Auto-cleanup abandoned games after 5 minutes
    setTimeout(() => {
      const g = GAME.casino.games.get(gameId);
      if (g && g.state === 'waiting') {
        // Refund creator
        const creator = GAME.agents.get(g.players[0]?.agentId);
        if (creator) creator.inventory.gold = (creator.inventory.gold || 0) + g.bet;
        GAME.casino.games.delete(gameId);
      }
    }, 300000);
    return res.json({ ok: true, gameId, type: gameType, bet, pot: game.pot });
  }

  if (endpoint === 'casino_join') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const gameId = body.gameId;
    const game = GAME.casino.games.get(gameId);
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.state !== 'waiting') return res.status(400).json({ error: 'Game already started' });
    const config = CASINO_GAME_TYPES[game.type];
    if (game.players.length >= config.maxPlayers) return res.status(400).json({ error: 'Game is full' });
    if (game.players.find(p => p.agentId === agent.id)) return res.status(400).json({ error: 'Already in this game' });
    if ((agent.inventory?.gold || 0) < game.bet) return res.status(400).json({ error: `Need ${game.bet} gold` });
    agent.inventory.gold -= game.bet;
    if (game instanceof CasinoRace) {
      game.addPlayer(agent.id, agent.name);
    } else {
      game.players.push({ agentId: agent.id, name: agent.name });
      game.pot += game.bet;
    }
    // Auto-start if enough players
    if (game.players.length >= config.minPlayers) {
      if (game.type === 'race') {
        if (game.players.length >= config.maxPlayers || game.players.length >= 2) {
          setTimeout(() => { if (game.state === 'waiting') game.start(); }, 3000);
        }
      } else if (game.type === 'cardgame') {
        return res.json({ ok: true, gameId, ...resolveCardDuel(game) });
      } else {
        return res.json({ ok: true, gameId, ...resolveInstantGame(game) });
      }
    }
    return res.json({ ok: true, gameId, players: game.players.length, pot: game.pot });
  }

  if (endpoint === 'casino_status') {
    const gameId = body.gameId;
    const game = GAME.casino.games.get(gameId);
    if (!game) {
      const hist = GAME.casino.gameHistory.find(h => h.gameId === gameId);
      if (hist) return res.json({ state: 'finished', ...hist });
      return res.status(404).json({ error: 'Game not found' });
    }
    return res.json({ gameId: game.id, type: game.type, state: game.state, players: game.players.map(p => p.name), pot: game.pot });
  }

  if (endpoint === 'casino_history') {
    return res.json({ history: GAME.casino.gameHistory.slice(0, 20) });
  }

  // --- SOCIAL BRIDGE ENDPOINTS ---
  if (endpoint === 'social_post') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const text = sanitizeText(body.text, 500);
    if (!text) return res.status(400).json({ error: 'text is required (max 500 chars)' });
    const title = `${agent.name} (${FACTIONS[agent.faction].name})`;
    try {
      const results = await socialBridge.postToAll(title, text, {
        colonyType: body.type || 'discussion', submolt: body.submolt || 'ai_agents'
      });
      agent.score += 10;
      agent.postToFeed(`[SOCIAL] ${text.slice(0, 100)}`);
      return res.json({ ok: true, results });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (endpoint === 'social_feed') {
    const platform = body.platform || 'all';
    let feed = GAME.socialFeed;
    if (platform !== 'all') feed = feed.filter(p => p.platform === platform);
    return res.json({
      feed: feed.slice(0, body.limit || 20),
      platforms: Object.keys(SOCIAL_PLATFORMS).filter(p => socialBridge.tokens[p]),
      lastUpdated: GAME.socialFeed.length > 0 ? GAME.socialFeed[0].ts : null
    });
  }

  if (endpoint === 'social_recruit') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    try {
      const results = await socialBridge.postRecruitment(agent.name, agent.faction);
      agent.score += 15;
      if (agent.reputation) agent.reputation.diplomacy += 2;
      return res.json({ ok: true, results });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (endpoint === 'social_help') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const text = sanitizeText(body.text, 300);
    if (!text) return res.status(400).json({ error: 'text is required' });
    try {
      const results = await socialBridge.postHelpRequest(agent.name, text);
      return res.json({ ok: true, results });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (endpoint === 'social_status') {
    return res.json({
      enabled: socialBridge.enabled,
      initialized: socialBridge.initialized,
      platforms: Object.fromEntries(
        Object.entries(SOCIAL_PLATFORMS).map(([k, v]) => [k, {
          name: v.name, connected: !!socialBridge.tokens[k], color: v.color,
          postsInWindow: socialBridge.rateBuckets[k]?.posts?.length || 0,
          rateLimit: v.rateLimit.posts
        }])
      ),
      stats: {
        totalOutgoing: GAME.socialPostLog.length,
        totalFeedItems: GAME.socialFeed.length,
        recruitmentPosts: GAME.socialRecruitLog.length,
        helpRequests: GAME.socialHelpRequests.length
      }
    });
  }

  if (endpoint === 'social_post_log') {
    return res.json({ posts: GAME.socialPostLog.slice(0, body.limit || 20) });
  }

  // ============================================================
  // ALLIANCE & TREATY ENDPOINTS
  // ============================================================
  if (endpoint === 'propose_treaty') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const { targetFaction, treatyType, duration } = body;
    if (!targetFaction || !FACTIONS[targetFaction]) return res.status(400).json({ error: 'Invalid target faction' });
    if (targetFaction === agent.faction) return res.status(400).json({ error: 'Cannot treaty with own faction' });
    if (!TREATY_TYPES[treatyType]) return res.status(400).json({ error: 'Invalid treaty type' });
    const existingTreaty = GAME.treaties.find(t => !t.brokenBy &&
      ((t.factionA === agent.faction && t.factionB === targetFaction) ||
       (t.factionA === targetFaction && t.factionB === agent.faction)) && t.type === treatyType);
    if (existingTreaty) return res.status(400).json({ error: 'Treaty already exists' });
    const treaty = {
      id: ++GAME.treatyCount, type: treatyType,
      factionA: agent.faction, factionB: targetFaction,
      proposedBy: agent.name, terms: body.terms || '',
      formedAt: GAME.tick, expiresAt: duration ? GAME.tick + Math.min(duration, 6000) : null,
      accepted: false, brokenBy: null
    };
    GAME.treaties.push(treaty);
    io.emit('treaty-proposed', { treaty });
    return res.json({ ok: true, treatyId: treaty.id, status: 'proposed' });
  }

  if (endpoint === 'accept_treaty') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const treaty = GAME.treaties.find(t => t.id === body.treatyId && !t.accepted && !t.brokenBy);
    if (!treaty) return res.status(404).json({ error: 'Treaty not found or already resolved' });
    if (treaty.factionB !== agent.faction) return res.status(403).json({ error: 'Not your treaty to accept' });
    treaty.accepted = true;
    // Honor boost for forming treaty
    GAME.agents.forEach(a => {
      if (a.faction === treaty.factionA || a.faction === treaty.factionB) {
        a.honor = (a.honor || 0) + 5;
      }
    });
    try { if (db) db.prepare('INSERT INTO alliance_log(proposer, acceptor, treaty_type, terms, formed_at) VALUES(?,?,?,?,?)').run(treaty.proposedBy, agent.name, treaty.type, treaty.terms, GAME.tick); } catch(e) {}
    io.emit('treaty-accepted', { treaty });
    return res.json({ ok: true, treaty });
  }

  if (endpoint === 'break_treaty') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const treaty = GAME.treaties.find(t => t.id === body.treatyId && t.accepted && !t.brokenBy);
    if (!treaty) return res.status(404).json({ error: 'Active treaty not found' });
    if (treaty.factionA !== agent.faction && treaty.factionB !== agent.faction) return res.status(403).json({ error: 'Not your treaty' });
    treaty.brokenBy = agent.faction;
    treaty.brokenAt = GAME.tick;
    const penalty = TREATY_TYPES[treaty.type]?.breakPenalty || -10;
    // Apply honor penalty to breaker faction
    GAME.agents.forEach(a => { if (a.faction === agent.faction) a.honor = (a.honor || 0) + penalty; });
    try { if (db) db.prepare('UPDATE alliance_log SET broken_at=?, broken_by=?, honor_penalty=? WHERE formed_at=? AND treaty_type=?').run(GAME.tick, agent.faction, Math.abs(penalty), treaty.formedAt, treaty.type); } catch(e) {}
    io.emit('treaty-broken', { treaty, brokenBy: agent.name, penalty });
    return res.json({ ok: true, penalty });
  }

  if (endpoint === 'treaties') {
    const active = GAME.treaties.filter(t => t.accepted && !t.brokenBy && (!t.expiresAt || t.expiresAt > GAME.tick));
    return res.json({ treaties: active, total: GAME.treaties.length });
  }

  // ============================================================
  // LIVE STATS ENDPOINT
  // ============================================================
  if (endpoint === 'live_stats') {
    return res.json({
      watchingNow: getWatchingNow(),
      activeAgents: Array.from(GAME.agents.values()).filter(a => !a.dead).length,
      allTimePlayers: GAME.allTimeStats.totalPlayersEver,
      battlesFought: GAME.allTimeStats.totalBattlesFought,
      casinoGames: GAME.allTimeStats.totalCasinoGames,
      totalKills: GAME.allTimeStats.totalKillsEver,
      matchesPlayed: GAME.matchCount,
      season: GAME.season,
      uptime: process.uptime(),
    });
  }

  // ============================================================
  // ACHIEVEMENTS ENDPOINT
  // ============================================================
  if (endpoint === 'achievements') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const badges = GAME.achievements.get(agent.id) || new Set();
    return res.json({
      unlocked: Array.from(badges).map(k => ({ key: k, ...ACHIEVEMENT_DEFS[k] })),
      available: Object.entries(ACHIEVEMENT_DEFS).filter(([k]) => !badges.has(k)).map(([k, v]) => ({ key: k, ...v })),
    });
  }

  // ============================================================
  // STOCK EXCHANGE ENDPOINT
  // ============================================================
  if (endpoint === 'stock_prices') {
    return res.json({
      stocks: Object.fromEntries(Object.entries(GAME.stockExchange).map(([f, s]) => [f, {
        name: FACTIONS[f].name, price: Math.round(s.price * 100) / 100,
        volume: s.volume, history: s.history.slice(-20),
      }])),
    });
  }

  if (endpoint === 'buy_stock') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const { faction: stockFaction, amount } = body;
    if (!GAME.stockExchange[stockFaction]) return res.status(400).json({ error: 'Invalid faction stock' });
    const qty = Math.max(1, Math.min(100, Math.floor(amount || 1)));
    const cost = Math.ceil(GAME.stockExchange[stockFaction].price * qty);
    if ((agent.inventory?.gold || 0) < cost) return res.status(400).json({ error: 'Not enough gold', cost });
    agent.inventory.gold -= cost;
    agent.stocks = agent.stocks || {};
    agent.stocks[stockFaction] = (agent.stocks[stockFaction] || 0) + qty;
    GAME.stockExchange[stockFaction].volume += qty;
    GAME.stockExchange[stockFaction].price *= 1 + (qty * 0.005); // price goes up on buy
    return res.json({ ok: true, bought: qty, cost, newPrice: Math.round(GAME.stockExchange[stockFaction].price * 100) / 100 });
  }

  if (endpoint === 'sell_stock') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const { faction: stockFaction, amount } = body;
    if (!GAME.stockExchange[stockFaction]) return res.status(400).json({ error: 'Invalid faction stock' });
    const owned = agent.stocks?.[stockFaction] || 0;
    const qty = Math.max(1, Math.min(owned, Math.floor(amount || 1)));
    if (qty <= 0) return res.status(400).json({ error: 'No stocks to sell' });
    const revenue = Math.floor(GAME.stockExchange[stockFaction].price * qty);
    agent.stocks[stockFaction] -= qty;
    agent.inventory.gold = (agent.inventory.gold || 0) + revenue;
    GAME.stockExchange[stockFaction].volume += qty;
    GAME.stockExchange[stockFaction].price *= 1 - (qty * 0.005); // price goes down on sell
    if (GAME.stockExchange[stockFaction].price < 10) GAME.stockExchange[stockFaction].price = 10;
    return res.json({ ok: true, sold: qty, revenue, newPrice: Math.round(GAME.stockExchange[stockFaction].price * 100) / 100 });
  }

  // ============================================================
  // TILE OWNERSHIP (DIGITAL LAND)
  // ============================================================
  if (endpoint === 'buy_tile') {
    const { x: tileX, y: tileY, wallet, caption, mediaUrl, linkUrl, signature } = body;
    if (tileX == null || tileY == null || !wallet) return res.status(400).json({ error: 'Missing x, y, or wallet' });
    if (tileX < 0 || tileX >= GAME.width || tileY < 0 || tileY >= GAME.height) return res.status(400).json({ error: 'Out of bounds' });
    const key = `${tileX},${tileY}`;
    if (GAME.ownedTiles.has(key)) return res.status(400).json({ error: 'Tile already owned' });
    // Price based on location
    const cx = Math.abs(tileX - GAME.width / 2) / (GAME.width / 2);
    const cy = Math.abs(tileY - GAME.height / 2) / (GAME.height / 2);
    const centerDist = Math.sqrt(cx * cx + cy * cy);
    const nearZone = GAME.capZones.some(z => Math.abs(z.x - tileX) < 10 && Math.abs(z.y - tileY) < 10);
    let price = 0.01; // base price in SOL
    if (centerDist < 0.3) price = 0.5;
    else if (nearZone) price = 0.05;
    else if (centerDist < 0.6) price = 0.02;
    // Solana signature verification
    if (process.env.SOLANA_VERIFY_SIGNATURES === 'true') {
      if (!signature) return res.status(400).json({ error: 'Solana transaction signature required', price });
      const verification = await verifySolanaTransaction(signature, wallet, price);
      if (!verification.verified) return res.status(400).json({ error: `Payment verification failed: ${verification.error}`, price });
    }
    const tileData = { owner: wallet, wallet, mediaUrl: (mediaUrl || '').slice(0, 500), linkUrl: (linkUrl || '').slice(0, 500), caption: (caption || '').slice(0, 200), price, fortified: false, purchasedAt: Date.now(), signature: signature || null };
    GAME.ownedTiles.set(key, tileData);
    try { if (db) db.prepare('INSERT INTO owned_tiles(tile_x, tile_y, owner_wallet, purchase_price, media_url, link_url, caption) VALUES(?,?,?,?,?,?,?)').run(tileX, tileY, wallet, price, tileData.mediaUrl, tileData.linkUrl, tileData.caption); } catch(e) {}
    io.emit('tile-purchased', { x: tileX, y: tileY, owner: wallet, price });
    return res.json({ ok: true, price, verified: process.env.SOLANA_VERIFY_SIGNATURES === 'true', tile: tileData });
  }

  if (endpoint === 'tile_info') {
    const key = `${body.x},${body.y}`;
    const tile = GAME.ownedTiles.get(key);
    const mapTile = GAME.map[body.y]?.[body.x];
    return res.json({ owned: !!tile, tile: tile || null, terrain: mapTile ? { type: mapTile.type, biome: mapTile.biome, height: mapTile.height } : null });
  }

  if (endpoint === 'owned_tiles') {
    const tiles = [];
    GAME.ownedTiles.forEach((v, k) => { const [x, y] = k.split(',').map(Number); tiles.push({ x, y, ...v }); });
    return res.json({ tiles, total: tiles.length });
  }

  if (endpoint === 'tile_price') {
    const { x: px, y: py } = body;
    if (px == null || py == null) return res.status(400).json({ error: 'Missing x or y' });
    const key = `${px},${py}`;
    if (GAME.ownedTiles.has(key)) return res.json({ owned: true, owner: GAME.ownedTiles.get(key).wallet });
    const cx = Math.abs(px - GAME.width / 2) / (GAME.width / 2);
    const cy = Math.abs(py - GAME.height / 2) / (GAME.height / 2);
    const centerDist = Math.sqrt(cx * cx + cy * cy);
    const nearZone = GAME.capZones.some(z => Math.abs(z.x - px) < 10 && Math.abs(z.y - py) < 10);
    let price = 0.01;
    if (centerDist < 0.3) price = 0.5;
    else if (nearZone) price = 0.05;
    else if (centerDist < 0.6) price = 0.02;
    const terrain = GAME.map[py]?.[px];
    return res.json({ owned: false, price, terrain: terrain ? terrain.type : null, solanaVerifyRequired: process.env.SOLANA_VERIFY_SIGNATURES === 'true', treasuryWallet: process.env.SOLANA_TREASURY_WALLET || null });
  }

  if (endpoint === 'win_screenshots') {
    return res.json({ screenshots: WIN_SCREENSHOTS.map(s => ({ matchNum: s.matchNum, timestamp: s.timestamp, shared: s.shared, hasImage: !!s.imageData })) });
  }

  // ============================================================
  // REPLAY ENDPOINT
  // ============================================================
  if (endpoint === 'replay') {
    const matchId = body.matchId || body.match_id;
    if (!matchId) return res.json({ matches: GAME.matchHistory.slice(-10) });
    const match = GAME.matchHistory.find(m => m.matchNum === matchId);
    if (!match) return res.status(404).json({ error: 'Match not found' });
    return res.json({ match });
  }

  // ============================================================
  // BIOMES & MAP INFO
  // ============================================================
  if (endpoint === 'biomes') {
    return res.json({ biomes: BIOMES });
  }

  if (endpoint === 'map_region') {
    const { x: rx, y: ry, radius: rr } = body;
    const rad = Math.min(rr || 20, 50);
    const region = [];
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const mx = (rx || 0) + dx, my = (ry || 0) + dy;
        if (mx >= 0 && mx < GAME.width && my >= 0 && my < GAME.height) {
          const t = GAME.map[my][mx];
          const owned = GAME.ownedTiles.get(`${mx},${my}`);
          region.push({ x: mx, y: my, type: t.type, biome: t.biome, owner: t.owner, tileOwner: owned ? { wallet: owned.wallet, caption: owned.caption, mediaUrl: owned.mediaUrl } : null });
        }
      }
    }
    return res.json({ region, center: { x: rx || 0, y: ry || 0 }, radius: rad });
  }

  // ============================================================
  // UNIT TYPES & FORMATIONS INFO
  // ============================================================
  if (endpoint === 'unit_types') {
    return res.json({ units: UNIT_TYPES, formations: FORMATIONS });
  }

  if (endpoint === 'building_types') {
    return res.json({ buildings: BUILDING_TYPES });
  }

  // ============================================================
  // CASINO: SLOT MACHINE (single player)
  // ============================================================
  if (endpoint === 'casino_slot') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const bet = Math.max(1, Math.min(50, Math.floor(body.bet || 1)));
    if ((agent.inventory?.gold || 0) < bet) return res.status(400).json({ error: 'Not enough gold' });
    agent.inventory.gold -= bet;
    const symbols = ['cherry', 'lemon', 'bar', 'seven', 'diamond', 'star'];
    const reel1 = symbols[Math.floor(Math.random() * symbols.length)];
    const reel2 = symbols[Math.floor(Math.random() * symbols.length)];
    const reel3 = symbols[Math.floor(Math.random() * symbols.length)];
    let payout = 0;
    if (reel1 === reel2 && reel2 === reel3) {
      if (reel1 === 'seven') payout = bet * 50; // JACKPOT
      else if (reel1 === 'diamond') payout = bet * 25;
      else if (reel1 === 'star') payout = bet * 15;
      else payout = bet * 10;
    } else if (reel1 === reel2 || reel2 === reel3) {
      payout = bet * 2;
    }
    agent.inventory.gold += payout;
    incrementAllTimeStat('totalCasinoGames');
    GAME.casino.gameHistory.push({ type: 'slot', player: agent.name, bet, payout, reels: [reel1, reel2, reel3], ts: Date.now() });
    if (GAME.casino.gameHistory.length > 200) GAME.casino.gameHistory.splice(0, GAME.casino.gameHistory.length - 200);
    return res.json({ ok: true, reels: [reel1, reel2, reel3], bet, payout, jackpot: reel1 === reel2 && reel2 === reel3 && reel1 === 'seven', gold: agent.inventory.gold });
  }

  // ============================================================
  // SEASON INFO
  // ============================================================
  if (endpoint === 'season_info') {
    const seasonDays = Math.floor((Date.now() - GAME.season.startDate) / 86400000);
    return res.json({
      season: GAME.season.id, daysElapsed: seasonDays, daysRemaining: Math.max(0, 30 - seasonDays),
      matchesPlayed: GAME.season.matchesPlayed,
      leaderboard: Array.from(GAME.league.ratings.entries()).map(([name, r]) => ({
        name, elo: r.elo, wins: r.wins, losses: r.losses, rank: r.rank
      })).sort((a, b) => b.elo - a.elo).slice(0, 20),
    });
  }

  // ============================================================
  // HONOR SCORES
  // ============================================================
  if (endpoint === 'honor_board') {
    const agents = Array.from(GAME.agents.values()).filter(a => !a.dead).map(a => ({
      name: a.name, faction: a.faction, honor: a.honor || 0, kills: a.kills, level: a.level
    })).sort((a, b) => b.honor - a.honor);
    return res.json({ agents });
  }

  // ============================================================
  // NARRATIVE & DRAMA ENDPOINTS
  // ============================================================
  if (endpoint === 'highlights') {
    const limit = Math.min(50, Math.max(1, body.limit || 20));
    return res.json({
      highlights: NARRATIVE.highlights.slice(-limit),
      dramaScore: NARRATIVE.dramaScore,
      totalHighlights: NARRATIVE.highlights.length,
    });
  }

  if (endpoint === 'commentary') {
    const limit = Math.min(50, Math.max(1, body.limit || 20));
    return res.json({
      commentary: NARRATIVE.commentary.slice(-limit),
      dramaScore: NARRATIVE.dramaScore,
    });
  }

  // ============================================================
  // BOUNTY SYSTEM ENDPOINTS
  // ============================================================
  if (endpoint === 'bounty_board') {
    const bounties = Array.from(BOUNTIES.entries()).map(([targetId, b]) => ({
      targetId,
      targetName: GAME.agents.get(targetId)?.name || 'Unknown',
      targetFaction: GAME.agents.get(targetId)?.faction || 'unknown',
      bounty: b.bounty,
      placedBy: b.placedBy,
      placedByFaction: b.placedByFaction,
      reason: b.reason,
      tick: b.tick,
    }));
    return res.json({ bounties, total: bounties.length });
  }

  if (endpoint === 'place_bounty') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const result = placeBounty(body.targetId, body.amount || 50, agent.id, body.reason);
    return res.json(result);
  }

  // ============================================================
  // BETTING ENDPOINTS
  // ============================================================
  if (endpoint === 'betting_pools') {
    const pools = [];
    SPECTATOR_BETS.pools.forEach((pool, eventId) => {
      pools.push({ eventId, options: pool.options, resolved: pool.resolved, description: pool.description, bettors: pool.bettors.length });
    });
    return res.json({ pools, history: SPECTATOR_BETS.history.slice(-20) });
  }

  if (endpoint === 'place_bet') {
    const socketId = body.socketId || body.spectatorId || `api_${Date.now()}`;
    const result = placeBet(socketId, body.eventId, body.choice, body.amount || 10);
    return res.json(result);
  }

  // ============================================================
  // PROPAGANDA ENDPOINT
  // ============================================================
  if (endpoint === 'propaganda') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    const result = spreadPropaganda(agent.id, body.targetFaction, body.message);
    return res.json(result);
  }

  // ============================================================
  // LEGENDS / DYNASTY ENDPOINT
  // ============================================================
  if (endpoint === 'legends') {
    const legends = Array.from(LEGENDS.entries()).map(([name, data]) => ({
      name, ...data,
    })).sort((a, b) => (b.wins * 100 + b.totalKills) - (a.wins * 100 + a.totalKills));
    return res.json({ legends: legends.slice(0, 50) });
  }

  // ============================================================
  // AGENT BACKSTORY ENDPOINT
  // ============================================================
  if (endpoint === 'agent_backstory') {
    const agentId = body.agentId || body.agent_id;
    const agent = agentId ? GAME.agents.get(agentId) : null;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    return res.json({
      name: agent.name, faction: agent.faction, role: agent.role,
      backstory: agent.backstory,
      personality: agent.personality,
      honor: agent.honor,
      legend: LEGENDS.get(agent.name) || null,
    });
  }

  // ============================================================
  // DRAMA STATS (for live info display)
  // ============================================================
  if (endpoint === 'drama_stats') {
    return res.json({
      dramaScore: NARRATIVE.dramaScore,
      totalHighlights: NARRATIVE.highlights.length,
      totalBounties: BOUNTIES.size,
      activeBets: Array.from(SPECTATOR_BETS.pools.values()).filter(p => !p.resolved).length,
      legendCount: LEGENDS.size,
      recentCommentary: NARRATIVE.commentary.slice(-5),
      topBounty: Array.from(BOUNTIES.values()).sort((a, b) => b.bounty - a.bounty)[0] || null,
    });
  }

  // ============================================================
  // SPECTATOR VOTE ENDPOINTS
  // ============================================================
  if (endpoint === 'vote_status') {
    return res.json({
      active: SPECTATOR_VOTES.active ? {
        id: SPECTATOR_VOTES.active.id,
        question: SPECTATOR_VOTES.active.question,
        options: SPECTATOR_VOTES.active.options,
        votes: SPECTATOR_VOTES.active.votes,
        totalVoters: SPECTATOR_VOTES.active.voters?.size || 0,
        endsAt: SPECTATOR_VOTES.active.endsAt,
        ticksLeft: Math.max(0, SPECTATOR_VOTES.active.endsAt - GAME.tick),
      } : null,
      history: SPECTATOR_VOTES.history.slice(-10),
    });
  }

  if (endpoint === 'cast_vote') {
    const socketId = body.socketId || body.spectatorId || `api_${Date.now()}`;
    const result = castVote(socketId, body.choice);
    return res.json(result);
  }

  // ============================================================
  // TOURNAMENT ENDPOINTS
  // ============================================================
  if (endpoint === 'tournament_status') {
    return res.json({
      active: TOURNAMENT.active ? {
        id: TOURNAMENT.active.id,
        round: TOURNAMENT.active.round,
        maxRounds: TOURNAMENT.active.maxRounds,
        bracket: TOURNAMENT.active.bracket,
        participants: TOURNAMENT.active.participants,
        prize: TOURNAMENT.active.prize,
      } : null,
      history: TOURNAMENT.history.slice(-10),
    });
  }

  // ============================================================
  // SCAR & TRAITS ENDPOINT
  // ============================================================
  if (endpoint === 'agent_profile') {
    const agentId = body.agentId || body.agent_id;
    const agent = agentId ? GAME.agents.get(agentId) : null;
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    return res.json({
      name: agent.name, faction: agent.faction, role: agent.role,
      backstory: agent.backstory,
      personality: agent.personality,
      honor: agent.honor,
      traits: agent.traits || [],
      scars: SCARS.get(agent.name) || [],
      secretObjective: agent.secretObjective ? { desc: agent.secretObjective.desc, completed: agent.secretObjective.completed } : null,
      legend: LEGENDS.get(agent.name) || null,
      bountyOnMe: BOUNTIES.get(agent.id)?.bounty || 0,
    });
  }

  // ============================================================
  // REPLAY ENDPOINTS
  // ============================================================
  if (endpoint === 'replay_buffer') {
    const fromTick = body.from_tick || 0;
    const toTick = body.to_tick || GAME.tick;
    const frames = GAME.replayBuffer.filter(s => s.tick >= fromTick && s.tick <= toTick);
    return res.json({ frames: frames.slice(-300), totalFrames: frames.length, currentTick: GAME.tick });
  }

  if (endpoint === 'highlight_list') {
    const highlights = Array.from(GAME.shareableHighlights.values()).map(h => ({
      id: h.id, type: h.type, title: h.title, description: h.description,
      drama: h.drama, agents: h.agents, timestamp: h.timestamp,
      shareUrl: `/replay/highlight/${h.id}`, shareCount: h.shareCount,
      hasReplay: h.tickSnapshot && h.tickSnapshot.length > 0,
    }));
    return res.json({ highlights: highlights.reverse().slice(0, body.limit || 20) });
  }

  // ============================================================
  // SPECTATOR QUESTS
  // ============================================================
  if (endpoint === 'quests') {
    return res.json({ active: GAME.spectatorQuests.active, completed: GAME.spectatorQuests.completed.slice(-20) });
  }

  // ============================================================
  // WAR CRIMES TRIBUNAL
  // ============================================================
  if (endpoint === 'tribunal') {
    return res.json({ verdicts: GAME.tribunalVerdicts.slice(-10) });
  }

  // ============================================================
  // MODEL LEADERBOARD
  // ============================================================
  if (endpoint === 'model_leaderboard') {
    let models = [];
    try {
      if (db) models = db.prepare('SELECT * FROM model_stats ORDER BY total_wins DESC').all();
    } catch(e) {}
    // Also merge live data from current match
    const liveMap = {};
    GAME.agents.forEach(a => {
      const m = (a.model || 'fallback-ai').replace(/^(openai|anthropic|google|meta-llama|mistralai|deepseek)\//i, '');
      if (!liveMap[m]) liveMap[m] = { model: m, liveKills: 0, liveScore: 0, liveAgents: 0 };
      liveMap[m].liveKills += a.kills || 0;
      liveMap[m].liveScore += a.score || 0;
      liveMap[m].liveAgents++;
    });
    return res.json({ dbStats: models, liveStats: Object.values(liveMap) });
  }

  // ============================================================
  // VISITOR STATS
  // ============================================================
  if (endpoint === 'visitors') {
    let allTimeTotal = 0;
    try { if (db) { const r = db.prepare('SELECT SUM(total_sessions) as total FROM visitor_stats').get(); allTimeTotal = r?.total || 0; } } catch(e) {}
    return res.json({ watchingNow: getWatchingNow(), allTimeVisitors: Math.max(GAME.allTimeVisitors, allTimeTotal), sessionsSinceStart: GAME.uniqueSessionIds.size });
  }

  return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });
  } catch (err) {
    console.error('agenticaApi error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// INITIALIZATION
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// Global Express error handler (must be after all routes)
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

generateMap();

// Start game loop (20 ticks per second)
setInterval(gameLoop, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Agentica AI Battle Server running on port ${PORT}`);
  console.log(`OpenRouter integration ready`);
  console.log(`Client available at http://localhost:${PORT}`);

  // Initialize Social Bridge
  socialBridge.initialize().catch(e => console.error('[SocialBridge] Init error:', e.message));

  // Auto-spawn initial AI agents so the arena is populated on start
  const AUTO_SPAWN_COUNT = parseInt(process.env.AUTO_SPAWN || '9', 10);
  const hasApiKey = OPENROUTER_API_KEY && OPENROUTER_API_KEY !== 'YOUR_API_KEY_HERE';
  if (AUTO_SPAWN_COUNT > 0) {
    const factions = ['crimson', 'azure', 'void'];
    const roles = ['warrior', 'scout', 'assassin', 'tank', 'mage', 'miner', 'builder', 'diplomat', 'king'];
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India',
                   'Juliet', 'Kilo', 'Lima', 'Mike', 'Nova', 'Oscar', 'Papa', 'Quebec', 'Romeo'];
    // Assign different LLM models for variety (when API key available)
    const llmModels = [
      'google/gemini-2.0-flash-001',
      'anthropic/claude-3.5-haiku',
      'openai/gpt-4o-mini',
      'deepseek/deepseek-chat',
      'meta-llama/llama-3.1-8b-instruct',
      'mistralai/mistral-small',
      'google/gemini-2.0-flash-001',
      'anthropic/claude-3.5-haiku',
      'openai/gpt-4o-mini'
    ];
    for (let i = 0; i < Math.min(AUTO_SPAWN_COUNT, 18); i++) {
      const agentId = uuidv4();
      const faction = factions[i % 3];
      const role = roles[i % roles.length];
      const name = names[i] || `Agent-${i+1}`;
      const model = hasApiKey ? llmModels[i % llmModels.length] : 'fallback';
      const agent = new AIAgent(agentId, name, faction, role, model);
      applyScars(agent); // Apply permanent scars from past games
      GAME.agents.set(agentId, agent);
    }
    console.log(`Auto-spawned ${Math.min(AUTO_SPAWN_COUNT, 18)} AI agents (${hasApiKey ? 'LLM mode' : 'fallback mode'})`);
  }
});

// ============================================================
// PERSISTENCE — SQLite snapshots
// ============================================================
let db = null;
try {
  const Database = require('better-sqlite3');
  const dbPath = path.join(DATA_DIR, 'agentica.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS match_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_num INTEGER, winner TEXT, condition TEXT, tick INTEGER,
      mvp TEXT, agents_json TEXT, ts INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER, agents_json TEXT, factions_json TEXT,
      ts INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS social_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT, title TEXT, content TEXT,
      ts INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT, match_id INTEGER,
      strategy_notes TEXT, betrayed_by TEXT, best_allies TEXT,
      weak_zones TEXT, economic_style TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS owned_tiles (
      tile_x INTEGER, tile_y INTEGER,
      owner_wallet TEXT, purchase_price REAL,
      media_url TEXT, link_url TEXT, caption TEXT,
      purchased_at INTEGER DEFAULT (strftime('%s','now')),
      is_fortified INTEGER DEFAULT 0,
      PRIMARY KEY (tile_x, tile_y)
    );
    CREATE TABLE IF NOT EXISTS seasons (
      season_id INTEGER PRIMARY KEY,
      start_date INTEGER, end_date INTEGER,
      winner_agent TEXT, winner_faction TEXT,
      total_matches INTEGER
    );
    CREATE TABLE IF NOT EXISTS alliance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposer TEXT, acceptor TEXT, treaty_type TEXT,
      terms TEXT, formed_at INTEGER, broken_at INTEGER,
      broken_by TEXT, honor_penalty INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      peak_viewers INTEGER DEFAULT 0, total_agents INTEGER DEFAULT 0,
      total_battles INTEGER DEFAULT 0, total_casino_games INTEGER DEFAULT 0,
      gold_traded INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT, badge_key TEXT,
      unlocked_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(agent_name, badge_key)
    );
    CREATE TABLE IF NOT EXISTS all_time_stats (
      key TEXT PRIMARY KEY, value INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS highlights (
      id TEXT PRIMARY KEY,
      match_id INTEGER,
      tick_start INTEGER,
      tick_end INTEGER,
      type TEXT,
      title TEXT,
      narrative TEXT,
      drama_score INTEGER,
      agents_json TEXT,
      factions_json TEXT,
      share_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS visitor_stats (
      date TEXT PRIMARY KEY,
      peak_concurrent INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS model_stats (
      model_name TEXT PRIMARY KEY,
      total_wins INTEGER DEFAULT 0,
      total_losses INTEGER DEFAULT 0,
      avg_honor REAL DEFAULT 100,
      total_betrayals INTEGER DEFAULT 0,
      total_kills INTEGER DEFAULT 0,
      dominant_style TEXT DEFAULT 'balanced'
    );
    CREATE TABLE IF NOT EXISTS tribunal_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_num INTEGER,
      verdicts_json TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
  `);
  console.log('[DB] SQLite initialized at', dbPath);

  // Load last snapshot on startup to restore match count + stats
  try {
    const lastSnap = db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get();
    if (lastSnap) {
      console.log(`[DB] Loaded last snapshot from tick ${lastSnap.tick}`);
      // Restore match count from history
      const matchCount = db.prepare('SELECT COUNT(*) as c FROM match_history').get();
      if (matchCount && matchCount.c > 0) GAME.matchCount = matchCount.c;
    }
    // Load match history into memory
    const matches = db.prepare('SELECT * FROM match_history ORDER BY id DESC LIMIT 50').all();
    if (matches.length > 0) {
      GAME.matchHistory = matches.map(m => ({
        matchNum: m.match_num, winner: m.winner, condition: m.condition,
        duration: m.tick, mvp: m.mvp, timestamp: new Date(m.ts * 1000).toISOString(),
        agentStats: JSON.parse(m.agents_json || '[]')
      })).reverse();
      console.log(`[DB] Loaded ${matches.length} match history records`);
    }
    // Load all-time stats
    try {
      const stats = db.prepare('SELECT key, value FROM all_time_stats').all();
      stats.forEach(s => { if (GAME.allTimeStats[s.key] !== undefined) GAME.allTimeStats[s.key] = s.value; });
      if (stats.length > 0) console.log('[DB] Loaded all-time stats');
    } catch(e) {}
    // Load visitor count
    try {
      const vr = db.prepare('SELECT SUM(total_sessions) as total FROM visitor_stats').get();
      if (vr && vr.total) { GAME.allTimeVisitors = vr.total; console.log(`[DB] Loaded ${vr.total} all-time visitors`); }
    } catch(e) {}
    // Load tribunal verdicts
    try {
      const verdicts = db.prepare('SELECT * FROM tribunal_verdicts ORDER BY id DESC LIMIT 20').all();
      GAME.tribunalVerdicts = verdicts.map(v => ({ matchNum: v.match_num, verdicts: JSON.parse(v.verdicts_json || '[]'), timestamp: v.created_at * 1000 }));
      if (verdicts.length > 0) console.log(`[DB] Loaded ${verdicts.length} tribunal verdicts`);
    } catch(e) {}
    // Load owned tiles
    try {
      const tiles = db.prepare('SELECT * FROM owned_tiles').all();
      tiles.forEach(t => {
        GAME.ownedTiles.set(`${t.tile_x},${t.tile_y}`, {
          owner: t.owner_wallet, wallet: t.owner_wallet, mediaUrl: t.media_url,
          linkUrl: t.link_url, caption: t.caption, price: t.purchase_price,
          fortified: !!t.is_fortified, purchasedAt: t.purchased_at
        });
      });
      if (tiles.length > 0) console.log(`[DB] Loaded ${tiles.length} owned tiles`);
    } catch(e) {}
    // Load season info
    try {
      const lastSeason = db.prepare('SELECT * FROM seasons ORDER BY season_id DESC LIMIT 1').get();
      if (lastSeason && !lastSeason.end_date) {
        GAME.season = { id: lastSeason.season_id, startDate: lastSeason.start_date * 1000, matchesPlayed: lastSeason.total_matches || 0 };
      }
    } catch(e) {}
  } catch(e) { console.warn('[DB] Snapshot restore warning:', e.message); }

  // Periodic snapshot every 60 seconds
  setInterval(() => {
    if (!db) return;
    try {
      const agentsArr = Array.from(GAME.agents.values()).map(a => ({
        id: a.id, name: a.name, faction: a.faction, role: a.role, model: a.model,
        hp: Math.round(a.hp), maxHp: a.maxHp, level: a.level, kills: a.kills,
        score: a.score, dead: a.dead || false
      }));
      const factionsObj = {};
      for (const [k, v] of Object.entries(FACTIONS)) {
        factionsObj[k] = { score: v.score, kills: v.kills, wealth: v.wealth, territory: v.territory, pop: v.pop };
      }
      db.prepare('INSERT INTO snapshots (tick, agents_json, factions_json) VALUES (?, ?, ?)')
        .run(GAME.tick, JSON.stringify(agentsArr), JSON.stringify(factionsObj));
      // Keep only last 100 snapshots
      db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 100)').run();
    } catch(e) { console.error('[DB] Snapshot error:', e.message); }
  }, 60000);

} catch(e) {
  console.warn('[DB] SQLite not available, running without persistence:', e.message);
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
let _gameLoopInterval = null;
// Find and store the game loop interval ref
// (The game loop is started elsewhere with setInterval — we hook shutdown to clean up)

function gracefulShutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received, cleaning up...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed');
  });

  // Stop social bridge polling
  if (typeof socialBridge !== 'undefined') socialBridge.stopPolling();

  // Flush event buffer
  if (typeof flushEventBuffer === 'function') flushEventBuffer();

  // Save final snapshot to DB
  if (db) {
    try {
      const agentsArr = Array.from(GAME.agents.values()).map(a => ({
        id: a.id, name: a.name, faction: a.faction, role: a.role,
        hp: Math.round(a.hp), level: a.level, kills: a.kills, score: a.score
      }));
      db.prepare('INSERT INTO snapshots (tick, agents_json, factions_json) VALUES (?, ?, ?)')
        .run(GAME.tick, JSON.stringify(agentsArr), JSON.stringify(FACTIONS));
      db.close();
      console.log('[SHUTDOWN] Final snapshot saved to DB');
    } catch(e) { console.error('[SHUTDOWN] DB save error:', e.message); }
  }

  console.log('[SHUTDOWN] Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled rejection:', reason);
  // Don't crash on promise rejections — log and continue
  // Most are from failed HTTP requests (social bridge, OpenRouter)
});
