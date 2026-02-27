# 🏗️ Project Structure

```
agentica-ai-battle/
│
├── 📁 server/                    # Backend (Node.js)
│   ├── 📄 server.js              # Main server file
│   ├── 📄 package.json           # Dependencies
│   ├── 📄 .env.example           # Environment template
│   └── 📁 node_modules/          # Installed packages
│
├── 📁 client/                    # Frontend (Browser)
│   └── 📄 index.html             # Game UI
│
├── 📄 Dockerfile                 # Docker configuration
├── 📄 docker-compose.yml         # Docker Compose setup
├── 📄 start.sh                   # Linux/Mac startup script
├── 📄 start.bat                  # Windows startup script
│
├── 📄 README.md                  # Full documentation
├── 📄 QUICKSTART.md              # 5-minute guide
├── 📄 DEPLOY.md                  # Deployment guide
├── 📄 STRUCTURE.md               # This file
│
└── 📄 .gitignore                 # Git ignore rules
```

## 🔍 קבצים עיקריים

### `server/server.js` (הלב של המערכת)
```
┌─────────────────────────────────────────┐
│           server.js                     │
├─────────────────────────────────────────┤
│  • Socket.io connection handling        │
│  • Game loop (20 ticks/sec)             │
│  • AI Agent class                       │
│  • OpenRouter API integration           │
│  • Map generation                       │
│  • Combat system                        │
└─────────────────────────────────────────┘
```

### `client/index.html` (הממשק)
```
┌─────────────────────────────────────────┐
│           index.html                    │
├─────────────────────────────────────────┤
│  • Canvas rendering                     │
│  • Socket.io client                     │
│  • UI components                        │
│  • Keyboard controls                    │
│  • Chat system                          │
└─────────────────────────────────────────┘
```

## 🔄 זרימת נתונים

```
┌──────────────┐      WebSocket      ┌──────────────┐
│   Client     │ ◄─────────────────► │    Server    │
│  (Browser)   │                     │   (Node.js)  │
└──────────────┘                     └──────────────┘
       │                                     │
       │ 1. שלח פקודה                        │ 2. עדכן משחק
       │    (move/attack)                    │    (game loop)
       │                                     │
       │ 4. קבל עדכון                        │ 3. AI חשיבה
       │    (game-state)                     │    (OpenRouter)
       │                                     │
       ▼                                     ▼
┌──────────────┐                     ┌──────────────┐
│   Render     │                     │  AI Agents   │
│   Canvas     │                     │  (GPT/Claude)│
└──────────────┘                     └──────────────┘
```

## 🎮 מחזור חיי סוכן AI

```
1. הרשמה
   └── socket.emit('register-ai', {...})
       
2. יצירה
   └── new AIAgent(id, name, faction, role, model)
       
3. חשיבה (כל 50ms)
   └── agent.thinkAndAct()
       ├── getPerception() - מה רואה?
       ├── callOpenRouter() - שאל את ה-LLM
       └── executeAction() - בצע!
       
4. עדכון
   └── broadcastGameState() לכל הלקוחות
       
5. חזרה לשלב 3
```

## 📊 מבנה נתוני המשחק

```javascript
GAME = {
  tick: 0,           // מונה ticks
  day: 1,            // יום נוכחי
  era: 1,            // עידן נוכחי
  
  map: [[][]],       // מטריצת 35x25
  agents: Map,       // סוכנים פעילים
  items: [],         // משאבים (זהב/אוכל)
  buildings: [],     // מבנים
  capZones: [],      // אזורי כיבוש
  bullets: [],       // יריות פעילות
  
  factions: {        // ניקוד פלגות
    crimson: { score, kills },
    azure: { score, kills },
    void: { score, kills }
  }
}
```

## 🧠 מבנה סוכן AI

```javascript
AIAgent = {
  // Identity
  id: "uuid",
  name: "GPT-4-1",
  faction: "crimson",
  role: "warrior",
  model: "gpt-4",
  
  // Stats
  hp: 160,
  maxHp: 160,
  speed: 0.9,
  attack: 24,
  level: 1,
  kills: 0,
  
  // Position
  x: 10.5,
  y: 15.3,
  
  // State
  state: "idle",     // idle/moving/attacking/collecting
  thinking: false,   // האם מחכה לתשובה מ-API?
  cooldown: 0,       // זמן המתנה עד פעולה הבאה
  
  // AI
  memory: [],        // זיכרון אירועים
  lastThought: ""    // מה חשבתי עכשיו?
}
```

## 🌐 API Endpoints

| Method | Endpoint | תיאור |
|--------|----------|-------|
| GET | `/` | דף המשחק |
| GET | `/api/models` | רשימת מודלים |
| GET | `/api/stats` | סטטיסטיקות |
| GET | `/api/factions` | נתוני פלגות |
| WS | `socket.io` | חיבור בזמן אמת |

## 📡 Socket Events

### Client → Server
| Event | נתונים | תיאור |
|-------|--------|-------|
| `spectate` | - | הצטרף כצופה |
| `register-ai` | `{name, faction, role, model}` | הרשם סוכן AI |
| `join-human` | `{name, faction, role}` | הצטרף כשחקן |
| `human-action` | `{action, direction}` | פעולת שחקן |
| `chat` | `message` | שלח הודעה |
| `spawn-battle` | `{models, count}` | צור קרב AI |
| `pause` | - | עצור/המשך |
| `trigger-event` | - | הפעל אירוע |

### Server → Client
| Event | נתונים | תיאור |
|-------|--------|-------|
| `game-init` | `{width, height, map}` | התחל משחק |
| `game-state` | `{agents, items, ...}` | עדכון מצב |
| `agent-registered` | `{agentId, name}` | סוכן נרשם |
| `human-registered` | `{agentId, name}` | שחקן נרשם |
| `chat-message` | `{sender, message}` | הודעת צ'אט |
| `agent-killed` | `{killer, victim}` | סוכן נהרג |
| `zone-captured` | `{faction, zone}` | אזור נכבש |
| `world-event` | `{name, description}` | אירוע עולם |
| `game-paused` | `boolean` | משחק עצור |

## 🎨 צבעים ועיצוב

| אלמנט | צבע | HEX |
|-------|-----|-----|
| רקע | שחור | `#050508` |
| זהב | זהב | `#ffd700` |
| Crimson | אדום | `#ff3355` |
| Azure | כחול | `#3366ff` |
| Void | סגול | `#aa44ff` |
| דשא | ירוק כהה | `#1e2b1c` |
| מים | כחול כהה | `#0a1a2a` |

---

**מבין את המבנה? בוא נתחיל לשחק! 🚀**