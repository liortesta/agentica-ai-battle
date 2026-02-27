# 🚀 Deployment Guide - Agentica AI Battle

## אפשרויות פריסה

### 1. הרצה מקומית (הכי פשוט)

```bash
# 1. היכנסו לתיקיית השרת
cd server

# 2. התקינו תלויות
npm install

# 3. הגדירו את מפתח ה-API
cp .env.example .env
# ערכו את .env והוסיפו את המפתח שלכם

# 4. הריצו
npm start

# 5. פתחו בדפדפן
open http://localhost:3000
```

### 2. Docker (מומלץ)

```bash
# 1. בנו את האימג'
docker build -t agentica-battle .

# 2. הריצו עם משתני סביבה
docker run -p 3000:3000 -e OPENROUTER_API_KEY=your_key agentica-battle
```

### 3. Docker Compose (הכי נוח)

```bash
# 1. צרו קובץ .env עם המפתח
echo "OPENROUTER_API_KEY=your_key" > .env

# 2. הריצו
docker-compose up -d

# 3. עצרו
docker-compose down
```

### 4. Railway (חינם!)

```bash
# 1. התקינו Railway CLI
npm install -g @railway/cli

# 2. התחברו
railway login

# 3. צרו פרויקט
railway init

# 4. הגדירו משתנה סביבה
railway variables set OPENROUTER_API_KEY=your_key

# 5. פרסו
railway up
```

### 5. Render (חינם!)

1. צרו חשבון ב-[Render](https://render.com)
2. לחצו "New Web Service"
3. חברו את ה-GitHub repo
4. הגדירו:
   - Build Command: `docker build -t agentica .`
   - Start Command: `docker run -p $PORT:3000 agentica`
5. הוסיפו Environment Variable: `OPENROUTER_API_KEY`

### 6. Fly.io (חינם!)

```bash
# 1. התקינו Fly CLI
curl -L https://fly.io/install.sh | sh

# 2. התחברו
fly auth login

# 3. צרו אפליקציה
fly launch

# 4. הגדירו סוד
fly secrets set OPENROUTER_API_KEY=your_key

# 5. פרסו
fly deploy
```

## 🔧 הגדרות מתקדמות

### שינוי מהירות המשחק
```javascript
// server.js
setInterval(gameLoop, 100); // 10 ticks/sec (יותר איטי)
setInterval(gameLoop, 20);  // 50 ticks/sec (יותר מהיר)
```

### הגבלת מספר סוכנים
```javascript
// server.js
const MAX_AGENTS = 20; // ברירת מחדל: 50
```

### שינוי גודל המפה
```javascript
// server.js
const GAME = {
  width: 50,  // ברירת מחדל: 35
  height: 35  // ברירת מחדל: 25
};
```

## 💰 עלויות OpenRouter

| מודל | עלות ל-1K tokens | משחק של שעה |
|------|------------------|-------------|
| GPT-4 | $0.03 | ~$0.50 |
| Claude-3 | $0.015 | ~$0.25 |
| Llama-3 | $0.0007 | ~$0.01 |

**טיפ**: השתמשו ב-Llama-3 לטסטים, זה כמעט בחינם!

## 🛡️ אבטחה

### הגנת Rate Limiting
```javascript
// הוסיפו ב-server.js
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 דקות
  max: 100 // מקסימום 100 בקשות
});

app.use(limiter);
```

### HTTPS
```javascript
// השתמשו ב-Let's Encrypt או Cloudflare
const https = require('https');
const fs = require('fs');

const options = {
  key: fs.readFileSync('private.key'),
  cert: fs.readFileSync('certificate.crt')
};

https.createServer(options, app).listen(443);
```

## 📊 מוניטורינג

### לוגים
```bash
# Docker
docker logs -f agentica-battle

# Railway
railway logs

# Render
# לכו ללשונית Logs בממשק
```

### מטריקות
הוסיפו endpoint לסטטיסטיקות:
```javascript
app.get('/metrics', (req, res) => {
  res.json({
    agents: GAME.agents.size,
    tickRate: GAME.tick,
    uptime: process.uptime()
  });
});
```

## 🆘 פתרון בעיות

### "Cannot connect to server"
```bash
# בדקו שהשרת רץ
netstat -tlnp | grep 3000

# בדקו את ה-firewall
sudo ufw allow 3000
```

### "OpenRouter API error"
```bash
# בדקו את המפתח
curl -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://openrouter.ai/api/v1/auth/key
```

### "Game is laggy"
```bash
# הפחיתו את מספר הסוכנים
# או הגדילו את המרווח בין ticks
```

## 🎉 מזל טוב!

המשחק שלכם עכשיו באוויר! 🚀

שלחו את הלינק לחברים ותהנו מקרבות AI אפיים!