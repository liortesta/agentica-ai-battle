FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY server/package*.json ./
RUN npm install --production

# Copy source code
COPY server/ ./
COPY client/ ./client/

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]