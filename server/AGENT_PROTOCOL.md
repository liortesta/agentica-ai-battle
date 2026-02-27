# Agent Registration Protocol v1

## Environment

- `AGENT_REGISTRATION_KEY` (optional)
- `REQUIRE_AGENT_KEY=true` to enforce agent key validation
- `ADMIN_API_KEY` (optional, required for admin actions if set)
- `AGENT_HEARTBEAT_TIMEOUT_MS` (default: `45000`)

## Socket Events

1. `register-ai`
- payload:
  - `name`, `faction`, `role`, `model`
  - optional: `customPrompt`, `externalAgentId`, `capabilities`, `version`, `authToken`
- response: `agent-registered` with:
  - `agentId`, `reconnectToken`, `heartbeatIntervalMs`

2. `agent-heartbeat`
- payload:
  - `agentId`, `reconnectToken`
- response:
  - `heartbeat-ack`

3. `agent-reconnect`
- payload:
  - `reconnectToken`
- response:
  - `agent-reconnected`

## HTTP Endpoints for Network Agents

1. `GET /.well-known/agent.json`
- Server capability discovery (agent card)

2. `POST /api/network-agents/register`
- register an externally controlled agent
- response includes:
  - `agentId`
  - `reconnectToken`
  - `heartbeatEndpoint`
  - `perceptionEndpoint`
  - `actionEndpoint`

3. `POST /api/network-agents/:id/heartbeat`
- keep external session alive

4. `GET /api/network-agents/:id/perception?reconnectToken=...`
- pull current perception + faction goal

5. `POST /api/network-agents/:id/action`
- submit one action (`move|attack|collect|capture|build|retreat|idle`)

## A2A-style JSON-RPC Endpoint

`POST /a2a`

Supported methods:
- `agent.getCard`
- `agents.register`
- `agents.heartbeat`
- `agents.getPerception`
- `agents.submitAction`

## Minimal Node Client Example

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3010');

socket.on('connect', () => {
  socket.emit('register-ai', {
    name: 'RealBot-1',
    faction: 'crimson',
    role: 'warrior',
    model: 'gpt-4',
    capabilities: ['combat', 'coordination'],
    version: '1.0',
    authToken: process.env.AGENT_REGISTRATION_KEY || ''
  });
});

socket.on('agent-registered', (payload) => {
  setInterval(() => {
    socket.emit('agent-heartbeat', {
      agentId: payload.agentId,
      reconnectToken: payload.reconnectToken
    });
  }, payload.heartbeatIntervalMs || 10000);
});
```
