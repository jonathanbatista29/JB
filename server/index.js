'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const storage = require('./storage');
const models = require('./models');
const { TagManager } = require('./tagManager');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const tm = new TagManager();
let project = storage.load();
tm.load(project);

app.get('/api/project', (req, res) => res.json(project));

app.put('/api/project', async (req, res) => {
  try {
    project = storage.save(req.body);
    await tm.load(project);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/api/models', (req, res) => res.json(models));

app.get('/api/values', (req, res) => res.json(tm.values));

app.post('/api/write', async (req, res) => {
  try {
    await tm.write(req.body.tag, req.body.value);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}

tm.on('values', (values) => broadcast({ type: 'values', values }));
tm.on('status', (status) => broadcast({ type: 'status', status }));
tm.on('alarms', () => broadcast({ type: 'alarms', ...tm.alarmState() }));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', values: tm.values, status: tm.status, ...tm.alarmState() }));
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'write') {
      try {
        await tm.write(msg.tag, msg.value);
        ws.send(JSON.stringify({ type: 'writeResult', id: msg.id, ok: true }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'writeResult', id: msg.id, ok: false, error: e.message }));
      }
    } else if (msg.type === 'ack') {
      tm.ack(msg.id);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`JB IHM rodando em http://localhost:${PORT}`);
});
