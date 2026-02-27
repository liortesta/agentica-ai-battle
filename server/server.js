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

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Landing page = homepage, Arena = /arena
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../client/landing.html')));
app.get('/arena', (req, res) => res.sendFile(path.join(__dirname, '../client/index.html')));
app.use(express.static(path.join(__dirname, '../client')));

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// OPENROUTER CONFIGURATION
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'YOUR_API_KEY_HERE';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const AGENT_REGISTRATION_KEY = process.env.AGENT_REGISTRATION_KEY || '';
const REQUIRE_AGENT_KEY = process.env.REQUIRE_AGENT_KEY === 'true';
const HEARTBEAT_TIMEOUT_MS = Number(process.env.AGENT_HEARTBEAT_TIMEOUT_MS || 45000);
const MAX_CHAT_LENGTH = 250;
const WORLD_WIDTH = Number(process.env.WORLD_WIDTH || 120);
const WORLD_HEIGHT = Number(process.env.WORLD_HEIGHT || 80);
const WORLD_TILE_SIZE = Number(process.env.WORLD_TILE_SIZE || 20);
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

function flushEventBuffer() {
  if (EVENT_BUFFER.length === 0) return;
  const batch = EVENT_BUFFER.splice(0);
  const lines = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFile(TICK_LOG_FILE, lines, () => {});
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
  if (!ADMIN_API_KEY) return true;
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
  }
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

      GAME.map[y][x] = { type, owner: null, height: adjusted };
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

  // Spawn points (positioned well inside the map)
  GAME.spawnPoints = {
    crimson: { x: 10, y: Math.floor(GAME.height / 2) },
    azure: { x: GAME.width - 11, y: Math.floor(GAME.height / 2) },
    void: { x: Math.floor(GAME.width / 2), y: 10 }
  };

  // 5 Capture zones spread across map
  GAME.capZones = [
    { name: 'Iron Peak',      x: Math.floor(GAME.width * 0.2), y: Math.floor(GAME.height * 0.3), owner: null, progress: 0 },
    { name: 'Shadow Hollow',  x: Math.floor(GAME.width * 0.5), y: Math.floor(GAME.height * 0.5), owner: null, progress: 0 },
    { name: 'Golden Summit',  x: Math.floor(GAME.width * 0.8), y: Math.floor(GAME.height * 0.7), owner: null, progress: 0 },
    { name: "Dragon's Maw",   x: Math.floor(GAME.width * 0.33), y: Math.floor(GAME.height * 0.75), owner: null, progress: 0 },
    { name: 'Crystal Lake',   x: Math.floor(GAME.width * 0.67), y: Math.floor(GAME.height * 0.25), owner: null, progress: 0 }
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
    this.state = 'idle';
    this.target = null;
    this.cooldown = 0;
    this.lastAction = null;
    this.memory = []; // short-term memory (backwards compat)
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
    this.inventory = { gold: 0, food: 0, wood: 0, stone: 0 };

    // Pending messages from other agents
    this._pendingMessages = [];

    // Personality trait (affects behavior like betrayal)
    const personalities = ['ambitious', 'loyal', 'cautious', 'aggressive', 'diplomatic'];
    this.personality = personalities[Math.floor(((GAME.rng || Math.random)()) * personalities.length)];

    this.thinking = false;
    this.lastThought = '';
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

    // Fallback-only agents never call LLM — use autonomous AI directly
    if (this.model === 'fallback') {
      const perception = this.getPerception();
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
      const action = await this.callOpenRouter(perception);

      let finalAction;
      if (this.isActionValid(action)) {
        finalAction = action;
        this.lastThought = action.reasoning || this.getMissionSummary();
        this._llmErrors = 0; // reset on success
        this._llmBackoff = 0;
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
    const validActions = new Set(['move','move_toward','attack','attack_building','collect','capture','build','retreat','idle','emote','patrol','declare_relation','chat','post','message']);
    if (!validActions.has(action.action)) return false;
    if (action.action === 'move') {
      return ['north', 'south', 'east', 'west'].includes(action.direction);
    }
    return true;
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

    // ──── 1. CRITICAL HP → retreat to allies or heal ────
    if (hpPct < 0.2) {
      if (!this.speechBubble) this.say(pickTalk('low_hp', vars));
      // Run toward closest ally if any
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

    // ──── 4. CHARGE ENEMY (aggressive roles — most roles are aggressive!) ────
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

    // ──── 6. CAPTURE ZONE ────
    if (zone && zone.owner !== this.faction) {
      if (distToZone < 1.8) {
        // Close enough to capture
        if (!this.speechBubble && rng() < 0.3) this.say(pickTalk('zone_captured', vars));
        return { action: 'capture', reasoning: `Capturing ${zone.name}!` };
      } else if (distToZone < 5) {
        // Move closer to capture zone
        return this.moveToward(zone, `Approaching ${zone.name}`);
      }
    }

    // ──── 7. COLLECT NEARBY RESOURCE ────
    if (nearbyResource && nearbyResource.distance < 2) {
      if (!this.speechBubble && rng() < 0.2) this.say(pickTalk('resource_found', vars));
      return { action: 'collect', reasoning: 'Grabbing resource' };
    }

    // ──── 8. MINER → go collect resources ────
    if (this.role === 'miner' && nearbyResource) {
      return this.moveToward(nearbyResource, 'Mining resources');
    }

    // ──── 9. BUILDER → build near zone ────
    if (canBuild && nearZone) {
      const types = ['tower', 'barracks', 'mine', 'wall'];
      for (const bt of types) {
        if (this.canAffordBuilding(bt)) {
          if (!this.speechBubble) this.say(pickTalk('building', vars));
          return { action: 'build', type: bt, reasoning: `Building ${bt}` };
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

    // ──── 12. TALK (low chance — mostly move!) ────
    if (!this.speechBubble && rng() < 0.04) {
      if (allies.length > 0 && rng() < 0.5) {
        vars.name = allies[0].name;
        this.say(pickTalk(rng() < 0.5 ? 'greeting' : 'ally_near', vars));
      } else {
        this.say(pickTalk(this.emotion || 'patrol', vars));
      }
    }

    // ──── 13. MOVE TO TARGET ZONE (always moving!) ────
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

    const systemPrompt = this.customPrompt || `
You are ${this.name}, a ${this.role} fighting for the ${FACTIONS[this.faction].name}.
Your personality: ${modelInfo.personality}
Current emotion: ${this.emotion} → ${emotionGuide}
Your reputation: ${repLabel} (${getReputationScore(this)})
Faction economy: wealth=${factionWealth}, income=${factionIncome}/sec, upkeep=${factionUpkeep}/sec${factionWealth < 0 ? ' [STARVING!]' : ''}

MEMORY:
${memorySummary}

GAME RULES:
- You can see enemies, allies, resources, and capture zones
- Your goal: survive, kill enemies, capture zones, help your faction win
- Actions: move, attack, collect, capture, build, retreat, emote, patrol, declare_relation, post, message, idle
- "message" action sends a private message to a nearby agent (needs targetId and text)
- Coordinate with allies by supporting faction missions (assault, defend, fortify, gather)
- You are level ${this.level} with ${this.hp}/${this.maxHp} HP, emotion: ${this.emotion}
- Let your emotion and memories guide your decisions
- If your faction is starving, prioritize capturing zones and collecting resources

Respond with JSON only:
{
  "action": "move|attack|collect|capture|build|retreat|idle|emote|patrol|post|message",
  "targetId": "agent-id (for attack/message)",
  "direction": "north|south|east|west (for move)",
  "emotion": "new emotion if using emote action",
  "text": "message text (for post/message)",
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
      max_tokens: 350,
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
        io.emit('chat-message', { sender: this.name, message: sanitizeText(action.text, 150) });
        break;
      case 'post':
        this.postToFeed(action.text);
        break;
      case 'message':
        this.sendDirectMessage(action.targetId || action.target_id, action.text);
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
    
    // Deal damage (base44 formula with defense)
    const dmg = Math.max(1, Math.floor(this.atk * (0.5 + (GAME.rng || Math.random)() * 0.5) - target.defense * 0.3));
    target.hp -= dmg;

    // XP for hitting
    this.xp += 5;
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
      this.xp += 20;
      this.score += 100;
      this.wealth += 5;
      FACTIONS[this.faction].kills++;
      FACTIONS[this.faction].score += 100;
      checkLevelUp(this);

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
    GAME.buildings.push(building);
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
          const moveStep = Math.min(this.speed * 0.2, dist);
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

function gameLoop() {
  if (GAME.paused) return;
  try {
  GAME.tick++;

  // Seed RNG for this tick (deterministic)
  GAME.tickSeed = GAME.masterSeed + GAME.tick;
  GAME.rng = mulberry32(GAME.tickSeed);

  if (GAME.tick % 100 === 0) {
    updateFactionGoals();
  }
  
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
  GAME.agents.forEach(agent => agent.passiveUpdate());

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
  for (const [id, agent] of GAME.agents) {
    if (agent.dead) {
      if (agent.control === 'external') {
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
    }
  ];

  const event = events[Math.floor((GAME.rng || Math.random)() * events.length)];
  GAME.activeEvent = event.name;
  event.effect();
  setTimeout(() => { if (GAME.activeEvent === event.name) GAME.activeEvent = null; }, 600 * 50);

  io.emit('world-event', { name: event.name, description: event.description });
  dispatchWebhook('world_event', { name: event.name, description: event.description });
}

// ============================================================
// WIN CONDITIONS
// ============================================================
const WIN_SCORE_THRESHOLD = 3000;   // Increased for larger map
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
      deaths: a.deaths || 0
    })),
    items: GAME.items,
    buildings: GAME.buildings.map(b => ({
      id: b.id, x: b.x, y: b.y, faction: b.faction, type: b.type,
      hp: Math.round(b.hp), maxHp: b.maxHp || BUILDING_TYPES[b.type]?.hp || 200
    })),
    capZones: GAME.capZones,
    bullets: GAME.bullets,
    factions: FACTIONS,
    factionGoals: GAME.factionGoals,
    worldIndices: GAME.worldIndices,
    winner: GAME.winner,
    pois: (GAME.pois || []).map(p => ({ id: p.id, type: p.type, x: p.x, y: p.y, color: p.color, radius: p.radius })),
    matchNum: GAME.matchCount + 1
  };

  io.emit('game-state', state);
}

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// SOCKET.IO HANDLERS
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

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
  const validEvents = ['agent_killed', 'zone_captured', 'rebellion', 'world_event', 'agent_registered', 'tick_summary'];
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
      'event-sourcing', 'phase-resolution', 'webhooks'
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
// /agenticaApi — Unified REST Endpoint (base44-compatible)
// ============================================================
app.post('/agenticaApi', (req, res) => {
  const body = req.body || {};
  const endpoint = body.endpoint;
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
      relations: agent.relations
    });
  }

  // --- ACTION ---
  if (endpoint === 'action') {
    const agent = getAgentByToken(token);
    if (!agent) return res.status(401).json({ error: 'Invalid token' });
    if (agent.dead) return res.status(400).json({ error: 'Agent is dead' });
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
    GAME.agents.forEach(a => { if (!a.dead && a.control === 'internal') { a.thinkAndAct(); triggered++; } });
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
      emotion: a.emotion, state: a.state, dead: !!a.dead
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

  return res.status(400).json({ error: `Unknown endpoint: ${endpoint}` });
});

// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
// INITIALIZATION
// ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
generateMap();

// Start game loop (20 ticks per second)
setInterval(gameLoop, 50);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Agentica AI Battle Server running on port ${PORT}`);
  console.log(`OpenRouter integration ready`);
  console.log(`Client available at http://localhost:${PORT}`);

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
      GAME.agents.set(agentId, agent);
    }
    console.log(`Auto-spawned ${Math.min(AUTO_SPAWN_COUNT, 18)} AI agents (${hasApiKey ? 'LLM mode' : 'fallback mode'})`);
  }
});
