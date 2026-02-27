#!/bin/bash

echo "🎮 Agentica AI Battle - Quick Start"
echo "===================================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found! Please install Node.js 18+"
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

# Check Node version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version is too old! Please upgrade to 18+"
    exit 1
fi

echo "✅ Node.js $(node -v) detected"
echo ""

# Enter server directory
cd server

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
    echo "✅ Dependencies installed"
else
    echo "✅ Dependencies already installed"
fi

echo ""

# Check for .env file
if [ ! -f ".env" ]; then
    echo "⚠️  No .env file found!"
    echo ""
    echo "Please create a .env file with your OpenRouter API key:"
    echo ""
    echo "   echo \"OPENROUTER_API_KEY=your_api_key_here\" > .env"
    echo ""
    echo "Get your free API key at: https://openrouter.ai/"
    echo ""
    
    # Ask if user wants to continue without API key
    read -p "Continue without AI agents? (y/n): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""
echo "🚀 Starting Agentica AI Battle Server..."
echo ""
echo "   🌐 Game will be available at: http://localhost:3000"
echo "   ⏹️  Press Ctrl+C to stop"
echo ""

npm start