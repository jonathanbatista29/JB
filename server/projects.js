'use strict';
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const { TagManager } = require('./tagManager');
const { Historian } = require('./historian');
const { Navigator } = require('./navigator');
const { Gateway } = require('./gateway');

// Vários projetos (IHMs) no mesmo servidor. Cada um fica em data/projects/<endereço>/ e roda
// com as próprias conexões, histórico, alarmes e gateway. Endereço na web: http://IP:porta/<endereço>/
const PROJECTS_DIR = path.join(storage.DATA_DIR, 'projects');
const TRASH_DIR = path.join(storage.DATA_DIR, 'lixeira');
const RESERVED = new Set(['api', 'ws', 'css', 'js', 'docs', 'favicon.ico', 'index.html', 'projects.html']);

// "Estação 1" -> "estacao-1"
function slugify(name) {
  const s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'projeto';
}

class ProjectRuntime {
  constructor(slug) {
    this.slug = slug;
    this.dir = path.join(PROJECTS_DIR, slug);
    this.project = storage.load(this.dir);
    this.clients = new Set();
    this.tm = new TagManager();
    this.hist = new Historian(path.join(this.dir, 'historico.db'));
    this.hist.configure(this.project);
    this.tm.history = this.hist.alarms({ limit: 200 });
    this.nav = new Navigator(this.tm);
    this.nav.configure(this.project);
    this.gw = new Gateway(this.tm);

    this.tm.on('values', (v) => { this.hist.onValues(v); this.nav.onValues(v); this.gw.onValues(v); this.broadcast({ type: 'values', values: v }); });
    this.tm.on('status', (s) => { this.gw.onStatus(s); this.broadcast({ type: 'status', status: s }); });
    this.tm.on('alarms', () => this.broadcast({ type: 'alarms', ...this.tm.alarmState() }));
    this.tm.on('alarmEvent', (e) => this.hist.addAlarm(e));
    this.nav.on('navigate', (e) => this.broadcast({ type: 'navigate', ...e }));
    this.nav.on('warning', (m) => console.warn(`[${slug}] Troca de tela:`, m));
    this.gw.on('state', (bridges) => this.broadcast({ type: 'gateway', bridges }));

    this.ready = this.tm.load(this.project).then(() => this.gw.configure(this.project));
  }

  // Salva um projeto novo e reinicia a comunicação com a configuração nova.
  async apply(project) {
    this.project = storage.save(this.dir, project);
    this.hist.configure(this.project);
    this.nav.configure(this.project);
    await this.tm.load(this.project);
    this.gw.configure(this.project);
    return this.project;
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.readyState === 1 && c.level >= 0) c.send(data);
  }

  summary() {
    const p = this.project;
    return {
      slug: this.slug, name: p.name, screens: p.screens.length, tags: p.tags.length,
      connections: p.connections.map((c) => ({ id: c.id, name: c.name, state: this.tm.status[c.id]?.state || 'idle', error: this.tm.status[c.id]?.error || null })),
      activeAlarms: Object.keys(this.tm.active).length, clients: this.clients.size,
    };
  }

  async stop() {
    for (const c of this.clients) c.close(4004, 'projeto parado');
    await this.tm.stopAll();
    try { this.hist.close(); } catch {}
  }
}

class ProjectManager {
  constructor() {
    this.runtimes = new Map();
  }

  // Inicia todos os projetos. Na primeira vez, converte a instalação antiga (data/project.json).
  start({ systemHistorian } = {}) {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    this.migrateLegacy(systemHistorian);
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(PROJECTS_DIR, d.name, 'project.json')));
    if (!dirs.length) this.create('Estação 1', storage.demoProject());
    for (const d of dirs) this.launch(d.name);
  }

  migrateLegacy(systemHistorian) {
    const oldFile = path.join(storage.DATA_DIR, 'project.json');
    const oldDb = path.join(storage.DATA_DIR, 'historico.db');
    if (!fs.existsSync(oldFile) && !fs.existsSync(oldDb)) return;
    const project = fs.existsSync(oldFile) ? storage.normalize(JSON.parse(fs.readFileSync(oldFile, 'utf8'))) : storage.demoProject();
    const slug = this.uniqueSlug(slugify(project.name));
    const dir = path.join(PROJECTS_DIR, slug);
    fs.mkdirSync(dir, { recursive: true });
    storage.save(dir, project, { keepVersion: false });
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(oldDb + ext)) fs.renameSync(oldDb + ext, path.join(dir, 'historico.db' + ext));
    }
    // O registro de ações antigo estava no histórico do projeto: copia para o banco do sistema.
    if (systemHistorian && fs.existsSync(path.join(dir, 'historico.db'))) {
      try {
        const f = path.join(dir, 'historico.db').replace(/'/g, "''");
        systemHistorian.db.exec(`ATTACH DATABASE '${f}' AS antigo;
          INSERT INTO audit (ts, user, action, detail) SELECT ts, user, action, detail FROM antigo.audit;
          DELETE FROM antigo.audit; DETACH DATABASE antigo;`);
      } catch (e) { console.warn('Migração do registro de ações:', e.message); }
    }
    if (fs.existsSync(oldFile)) fs.renameSync(oldFile, oldFile + '.migrado');
    console.log(`Projeto antigo convertido para /${slug}/`);
  }

  launch(slug) {
    const rt = new ProjectRuntime(slug);
    this.runtimes.set(slug, rt);
    return rt;
  }

  get(slug) {
    return this.runtimes.get(slug);
  }

  list() {
    return [...this.runtimes.values()].map((r) => r.summary()).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true }));
  }

  uniqueSlug(base) {
    let slug = RESERVED.has(base) ? base + '-1' : base, n = 2;
    while (this.runtimes.has(slug) || fs.existsSync(path.join(PROJECTS_DIR, slug))) slug = `${base}-${n++}`;
    return slug;
  }

  // Cria um projeto novo (vazio, exemplo, cópia ou importado) e já coloca para rodar.
  create(name, project, slugWanted) {
    name = String(name || '').trim();
    if (!name) throw new Error('Informe o nome do projeto');
    const slug = this.uniqueSlug(slugify(slugWanted || name));
    const p = storage.normalize(structuredClone(project || emptyProject()));
    p.name = name;
    storage.save(path.join(PROJECTS_DIR, slug), p, { keepVersion: false });
    return this.launch(slug);
  }

  // Exclui movendo para data/lixeira (dá para recuperar copiando a pasta de volta).
  async remove(slug) {
    const rt = this.runtimes.get(slug);
    if (!rt) throw new Error('Projeto não encontrado');
    await rt.stop();
    this.runtimes.delete(slug);
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, `${slug}_${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}`);
    fs.renameSync(rt.dir, dest);
    return dest;
  }

  async stopAll() {
    await Promise.all([...this.runtimes.values()].map((r) => r.stop()));
  }
}

function emptyProject() {
  return { name: 'Novo projeto', connections: [], tags: [], alarms: [], gateway: [], navButtons: [],
    screens: [{ id: 'tela1', number: 1, name: 'Principal', width: 1024, height: 600, bg: '#1e2530', widgets: [] }] };
}

module.exports = { ProjectManager, slugify, PROJECTS_DIR, RESERVED };
