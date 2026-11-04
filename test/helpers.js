'use strict';
// Funções de apoio dos testes: servidor temporário, cliente HTTP com login e equipamentos simulados.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

const tmpDir = (prefix = 'jbihm-teste-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Espera uma condição ficar verdadeira (para dados que chegam por leitura cíclica).
async function waitFor(fn, { timeout = 8000, interval = 100, msg = 'condição' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Tempo esgotado esperando ${msg} (último: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

// Sobe o servidor da IHM num processo separado, com uma pasta de dados vazia.
async function startServer({ dataDir = tmpDir(), env = {} } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  await waitFor(() => output.includes('JB IHM rodando'), { timeout: 15000, msg: 'o servidor iniciar' }).catch((e) => {
    child.kill();
    throw new Error(`${e.message}\n${output}`);
  });
  return {
    url: `http://127.0.0.1:${port}`, port, dataDir, child,
    output: () => output,
    async stop() {
      if (child.exitCode != null) return;
      child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
      if (child.exitCode == null) child.kill('SIGKILL');
    },
  };
}

// Cliente HTTP que guarda o cookie de sessão (como um navegador).
class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }

  async req(method, url, body, { raw = false, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookie) h.Cookie = this.cookie;
    let payload;
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) { payload = body; h['Content-Type'] ||= 'application/octet-stream'; }
      else { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    }
    const r = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) {
      const v = sc.split(';')[0];
      this.cookie = v.endsWith('=') ? '' : v;
    }
    if (raw) return r;
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json, text, headers: r.headers };
  }

  get(u, o) { return this.req('GET', u, undefined, o); }
  post(u, b, o) { return this.req('POST', u, b ?? {}, o); }
  put(u, b, o) { return this.req('PUT', u, b ?? {}, o); }
  del(u, o) { return this.req('DELETE', u, undefined, o); }

  // Primeiro acesso: admin/admin, troca obrigatória da senha e novo login.
  async loginAdmin(newPass = 'Teste#123') {
    let r = await this.post('/api/login', { username: 'admin', password: newPass });
    if (r.status === 200) return r;
    r = await this.post('/api/login', { username: 'admin', password: 'admin' });
    if (r.status !== 200) throw new Error('login admin falhou: ' + r.text);
    await this.post('/api/me/password', { oldPassword: 'admin', newPassword: newPass });
    return this.post('/api/login', { username: 'admin', password: newPass });
  }
}

// PLC Modbus TCP simulado (registradores e coils em memória).
function fakeModbus(port) {
  const ModbusRTU = require('modbus-serial');
  const hr = new Array(500).fill(0);
  const coils = new Array(500).fill(false);
  const server = new ModbusRTU.ServerTCP({
    getHoldingRegister: (a) => hr[a], getInputRegister: (a) => hr[a],
    getCoil: (a) => coils[a], getDiscreteInput: (a) => coils[a],
    setRegister: (a, v) => { hr[a] = v; }, setCoil: (a, v) => { coils[a] = v; },
  }, { host: '127.0.0.1', port, unitID: 1 });
  const f32 = (a) => { const b = Buffer.alloc(4); b.writeUInt16BE(hr[a], 0); b.writeUInt16BE(hr[a + 1], 2); return b.readFloatBE(0); };
  return { hr, coils, f32, close: () => new Promise((r) => server.close(r)) };
}

// Multímetro SCPI simulado, respondendo como o DM858 (FUNC? devolve "VOLT" para tensão DC).
function fakeDmm(port) {
  const state = { func: 'VOLT:DC', commands: [] };
  const base = { 'VOLT:DC': 12, 'VOLT:AC': 220, 'CURR:DC': 0.5, 'CURR:AC': 1.2, RES: 1000, FREQ: 60, CAP: 1e-6 };
  const sockets = new Set();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    s.on('error', () => {});
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const cmd = buf.slice(0, i).trim().toUpperCase();
        buf = buf.slice(i + 1);
        state.commands.push(cmd);
        if (cmd === '*IDN?') s.write('RIGOL TECHNOLOGIES,DM858E,TESTE0001,00.01.02\n');
        else if (cmd === 'READ?') s.write((state.overload ? '9.9E37' : (base[state.func] ?? 1).toExponential(6)) + '\n');
        else if (cmd === 'FUNC?') s.write(`"${state.func.replace(/:DC$/, '')}"\n`);
        else if (cmd.startsWith('CONF:')) state.func = cmd.slice(5);
        else if (cmd === '*RST') state.func = 'VOLT:DC';
      }
    });
  });
  server.listen(port, '127.0.0.1');
  return { state, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

module.exports = { ROOT, tmpDir, freePort, sleep, waitFor, startServer, Client, fakeModbus, fakeDmm };
