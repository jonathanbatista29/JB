'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const storage = require('./storage');

// HTTPS opcional. Arquivos em data/https/: config.json, cert.pem (público) e key.pem (privado).
// O HTTP continua funcionando (na rede local) a menos que "redirecionar para HTTPS" esteja ligado.
const DIR = path.join(storage.DATA_DIR, 'https');
const CFG = path.join(DIR, 'config.json');
const CERT = path.join(DIR, 'cert.pem');
const KEY = path.join(DIR, 'key.pem');
const DEFAULTS = { enabled: false, port: 3443, redirect: false };

class HttpsManager {
  constructor({ app, onUpgrade }) {
    this.app = app;
    this.onUpgrade = onUpgrade;
    this.server = null;
    this.error = null;
    this.cfg = { ...DEFAULTS };
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(CFG, 'utf8'))); } catch {}
  }

  hasCert() {
    return fs.existsSync(CERT) && fs.existsSync(KEY);
  }

  certInfo() {
    if (!this.hasCert()) return null;
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(CERT));
      return { subject: x.subject, issuer: x.issuer, altNames: x.subjectAltName || '', validFrom: x.validFrom, validTo: x.validTo,
        expired: new Date(x.validTo) < new Date(), selfSigned: x.subject === x.issuer, fingerprint: x.fingerprint256 };
    } catch (e) {
      return { error: e.message };
    }
  }

  status() {
    return { ...this.cfg, running: Boolean(this.server), error: this.error, cert: this.certInfo(), hosts: localHosts() };
  }

  saveCfg() {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CFG, JSON.stringify(this.cfg, null, 2));
  }

  async update({ enabled, port, redirect }) {
    const p = port == null ? this.cfg.port : Math.floor(Number(port));
    if (!(p >= 1 && p <= 65535)) throw new Error('Porta inválida');
    if (enabled && !this.hasCert()) throw new Error('Gere ou envie um certificado antes de ligar o HTTPS');
    Object.assign(this.cfg, { enabled: enabled == null ? this.cfg.enabled : Boolean(enabled), port: p, redirect: redirect == null ? this.cfg.redirect : Boolean(redirect) });
    this.saveCfg();
    await this.restart();
    if (this.cfg.enabled && this.error) throw new Error(this.error);
    return this.status();
  }

  // Certificado autoassinado com o nome do computador e os IPs da rede (o navegador vai pedir para confiar).
  async generate(extraHosts = []) {
    const selfsigned = require('selfsigned');
    const names = new Set(['localhost', os.hostname(), ...extraHosts.map((h) => String(h).trim()).filter(Boolean)]);
    const ips = new Set(['127.0.0.1', ...localHosts()]);
    for (const n of [...names]) if (/^\d+\.\d+\.\d+\.\d+$/.test(n)) { ips.add(n); names.delete(n); }
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 5);
    const pems = await selfsigned.generate([{ name: 'commonName', value: `JB IHM ${os.hostname()}` }, { name: 'organizationName', value: 'JB IHM' }], {
      keySize: 2048, algorithm: 'sha256', notBeforeDate: new Date(), notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [...[...names].map((value) => ({ type: 2, value })), ...[...ips].map((ip) => ({ type: 7, ip }))] },
      ],
    });
    this.writeCert(pems.cert, pems.private);
    await this.restart();
    return this.status();
  }

  // Certificado próprio (ex.: da empresa ou Let's Encrypt), em PEM.
  async setCustom(certPem, keyPem) {
    let x;
    try { x = new crypto.X509Certificate(certPem); } catch { throw new Error('Certificado inválido (use o formato PEM: -----BEGIN CERTIFICATE-----)'); }
    let key;
    try { key = crypto.createPrivateKey(keyPem); } catch { throw new Error('Chave privada inválida (use o formato PEM, sem senha)'); }
    if (!x.checkPrivateKey(key)) throw new Error('A chave privada não corresponde ao certificado');
    this.writeCert(certPem, keyPem);
    await this.restart();
    return this.status();
  }

  writeCert(cert, key) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CERT, cert);
    fs.writeFileSync(KEY, key, { mode: 0o600 });
  }

  publicCert() {
    return this.hasCert() ? fs.readFileSync(CERT, 'utf8') : null;
  }

  async start() {
    if (!this.cfg.enabled || !this.hasCert()) return;
    this.error = null;
    await new Promise((resolve) => {
      let srv;
      try {
        srv = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, this.app);
      } catch (e) {
        this.error = `Certificado não pôde ser usado: ${e.message}`;
        return resolve();
      }
      srv.on('upgrade', this.onUpgrade);
      srv.once('error', (e) => {
        this.error = e.code === 'EADDRINUSE' ? `A porta ${this.cfg.port} já está em uso` : e.message;
        resolve();
      });
      srv.listen(this.cfg.port, process.env.HOST || '0.0.0.0', () => {
        this.server = srv;
        console.log(`HTTPS ativo em https://localhost:${this.cfg.port}/`);
        resolve();
      });
    });
  }

  async stop() {
    const s = this.server;
    this.server = null;
    if (s) await new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  // Middleware para o servidor HTTP: manda o navegador para o endereço HTTPS quando configurado.
  redirectMiddleware() {
    return (req, res, next) => {
      if (!this.cfg.redirect || !this.server || req.secure) return next();
      // A página de download do certificado continua em HTTP (para instalar antes de confiar).
      if (req.path === '/api/https/cert.crt') return next();
      const host = String(req.headers.host || 'localhost').replace(/:\d+$/, '');
      res.redirect(307, `https://${host}:${this.cfg.port}${req.originalUrl}`);
    };
  }
}

function localHosts() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

module.exports = { HttpsManager };
