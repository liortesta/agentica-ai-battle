# ⚡ Quick Start - 5 דקות להרצה!

## שלב 1: קבלת מפתח API (2 דקות)

1. היכנסו ל-[OpenRouter](https://openrouter.ai/)
2. צרו חשבון חינם
3. לכו ל-[Keys](https://openrouter.ai/keys)
4. צרו מפתח חדש והעתיקו אותו

## שלב 2: הרצה (3 דקות)

### Linux/Mac:
```bash
# 1. היכנסו לתיקייה
cd agentica-ai-battle

# 2. הריצו
./start.sh
```

### Windows:
```cmd
:: 1. היכנסו לתיקייה
cd agentica-ai-battle

:: 2. הריצו
start.bat
```

### או ידני:
```bash
cd server
npm install
echo "OPENROUTER_API_KEY=your_key" > .env
npm start
```

## שלב 3: שחקו! 🎮

פתחו את הדפדפן ב-`http://localhost:3000`

### אפשרויות:

| כפתור | מה עושה |
|-------|---------|
| **Join Battle** | הצטרפו כשחקן אנושי |
| **Start AI Battle** | צפו ב-AI נלחם |
| **Pause** | עצרו את המשחק |
| **Event** | הפעילו אירוע אקראי |

### שליטה (כשחקן):
- ⬆️⬇️⬅️➡️ - תזוזה
- רווח - התקפה
- C - איסוף משאבים
- X - כיבוש אזור

## 🎯 מה עכשיו?

### רוצים טורניר?
```javascript
// בלחצן "Start AI Battle" בחרו כמה מודלים
// GPT-4 vs Claude vs Gemini!
```

### רוצים להתאים אישית?
```javascript
// ערכו את server.js
const AI_MODELS = {
  'my-custom-model': {
    name: 'My Bot',
    personality: 'super aggressive'
  }
};
```

### רוצים לפרסם באינטרנט?
```bash
# Railway (חינם)
npm install -g @railway/cli
railway login
railway up

# או Render, Fly.io, ועוד...
# ראו DEPLOY.md לפרטים
```

## 💡 טיפים

1. **התחילו עם Llama-3** - זול יותר לטסטים
2. **צפו ב-Agent List** - רואים מה כל AI חושב
3. **בדקו את ה-Kill Feed** - מי מנצח?
4. **שחקו עם חברים** - כולם יכולים להצטרף!

## 🆘 בעיות נפוצות

| בעיה | פתרון |
|------|-------|
| "Cannot find module" | הריצו `npm install` |
| "Invalid API key" | בדקו את הקובץ `.env` |
| "Port already in use" | שינו את ה-PORT ב-.env |
| "AI not responding" | בדקו חיבור אינטרנט |

## 📞 תמיכה

נתקעתם? פתחו Issue ב-GitHub!

---

**מזל טוב! עכשיו יש לכם קרב AI אמיתי! 🚀**