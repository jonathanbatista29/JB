'use strict';
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const images = require('./images');

// Backup automático diário de todos os projetos.
// Cada execução cria uma pasta jbihm_AAAA-MM-DD_HH-MM-SS/ com:
//   backup-geral.json   todos os projetos (configuração + imagens), igual ao "Backup geral"
//   historico/<projeto>.db   histórico de cada projeto (opcional)
//   users.json          usuários (para recuperar o servidor inteiro)
// Mantém só as N pastas mais novas.
const CONFIG = path.join(storage.DATA_DIR, 'backup-auto.json');
const DEFAULT_DIR = path.join(storage.DATA_DIR, 'backups-auto');
const NAME_RE = /^jbihm_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
const DEFAULTS = { enabled: false, time: '02:00', folder: '', keep: 14, includeHistory: true, lastRun: null, lastResult: null, lastError: null, lastDay: null };

const pad = (n) => String(n).padStart(2, '0');

// Cria a pasta nível por nível. (O mkdirSync recursivo do Node pode travar em caminhos especiais,
// e a pasta de backup é digitada pelo usuário.)
function makeDir(dir) {
  const parts = [];
  let cur = path.resolve(dir);
  for (let i = 0; i < 64 && !fs.existsSync(cur); i++) {
    parts.unshift(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (!fs.existsSync(cur) || !fs.statSync(cur).isDirectory()) throw new Error(`Caminho inválido: ${cur}`);
  for (const p of parts) fs.mkdirSync(p);
}
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

class AutoBackup {
  constructor(pm, { log = () => {} } = {}) {
    this.pm = pm;
    this.log = log;
    this.running = false;
    this.cfg = { ...DEFAULTS };
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(CONFIG, 'utf8'))); } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(this.cfg, null, 2));
  }

  folder() {
    return this.cfg.folder ? path.resolve(storage.DATA_DIR, this.cfg.folder) : DEFAULT_DIR;
  }

  settings() {
    const { enabled, time, folder, keep, includeHistory, lastRun, lastResult, lastError } = this.cfg;
    return { enabled, time, folder, keep, includeHistory, lastRun, lastResult, lastError, folderPath: this.folder(), defaultFolder: DEFAULT_DIR, running: this.running, nextRun: this.nextRun() };
  }

  update({ enabled, time, folder, keep, includeHistory }) {
    if (time != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) throw new Error('Horário inválido (use HH:MM, ex.: 02:00)');
    const k = keep == null ? this.cfg.keep : Math.floor(Number(keep));
    if (!(k >= 1 && k <= 365)) throw new Error('Quantidade de cópias deve ser de 1 a 365');
    const f = folder == null ? this.cfg.folder : String(folder).trim();
    // Confere se a pasta existe (ou pode ser criada) e aceita gravação.
    const dir = f ? path.resolve(storage.DATA_DIR, f) : DEFAULT_DIR;
    try {
      makeDir(dir);
      const probe = path.join(dir, '.teste_gravacao');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe);
    } catch (e) {
      throw new Error(`Não foi possível gravar na pasta ${dir}: ${e.message}`);
    }
    Object.assign(this.cfg, {
      enabled: enabled == null ? this.cfg.enabled : Boolean(enabled),
      time: time == null ? this.cfg.time : String(time),
      folder: f, keep: k,
      includeHistory: includeHistory == null ? this.cfg.includeHistory : Boolean(includeHistory),
    });
    // Horário novo ainda não chegou hoje: deixa rodar (de novo) hoje nesse horário.
    if (time != null && this.todayAt() > new Date()) this.cfg.lastDay = null;
    this.save();
    return this.settings();
  }

  todayAt(now = new Date()) {
    const [hh, mm] = this.cfg.time.split(':').map(Number);
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    return d;
  }

  // Próxima execução: hoje no horário (ou agora, se o horário já passou e ainda não rodou hoje); senão amanhã.
  nextRun() {
    if (!this.cfg.enabled) return null;
    const now = new Date();
    const t = this.todayAt(now);
    if (this.cfg.lastDay === dayKey(now)) { t.setDate(t.getDate() + 1); return t.getTime(); }
    return Math.max(now.getTime(), t.getTime());
  }

  start() {
    this.timer = setInterval(() => this.tick(), 30000);
    setTimeout(() => this.tick(), 5000);
  }

  stop() {
    clearInterval(this.timer);
  }

  // Roda uma vez por dia, no horário escolhido (ou assim que o servidor ligar, se perdeu o horário).
  tick() {
    if (!this.cfg.enabled || this.running) return;
    const now = new Date();
    if (this.cfg.lastDay === dayKey(now) || now < this.todayAt(now)) return;
    this.run('agendado').catch(() => {});
  }

  async run(trigger = 'manual', who = null) {
    if (this.running) throw new Error('Já existe um backup em andamento');
    this.running = true;
    const started = new Date();
    const name = `jbihm_${dayKey(started)}_${pad(started.getHours())}-${pad(started.getMinutes())}-${pad(started.getSeconds())}`;
    const dest = path.join(this.folder(), name);
    try {
      makeDir(dest);
      const rts = [...this.pm.runtimes.values()];
      const bundle = {
        jbihm: 'backup', version: 1, exportedAt: started.toISOString(), automatic: true,
        projects: rts.map((rt) => ({ slug: rt.slug, project: rt.project, images: images.exportAll(rt.dir) })),
      };
      fs.writeFileSync(path.join(dest, 'backup-geral.json'), JSON.stringify(bundle));
      if (this.cfg.includeHistory) {
        makeDir(path.join(dest, 'historico'));
        for (const rt of rts) {
          rt.hist.flush();
          const f = path.join(dest, 'historico', `${rt.slug}.db`).replace(/'/g, "''");
          rt.hist.db.exec(`VACUUM INTO '${f}'`);
        }
      }
      const users = path.join(storage.DATA_DIR, 'users.json');
      if (fs.existsSync(users)) fs.copyFileSync(users, path.join(dest, 'users.json'));
      const removed = this.prune();
      const size = dirSize(dest);
      Object.assign(this.cfg, { lastRun: Date.now(), lastDay: dayKey(started), lastError: null,
        lastResult: `${rts.length} projeto(s), ${size >= 1048576 ? (size / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(size / 1024)) + ' KB'}${removed ? `, ${removed} cópia(s) antiga(s) apagada(s)` : ''}` });
      this.save();
      this.log(who, 'Backup automático', `${trigger}: ${name} (${this.cfg.lastResult})`);
      return { ok: true, name, size };
    } catch (e) {
      Object.assign(this.cfg, { lastRun: Date.now(), lastDay: dayKey(started), lastError: e.message, lastResult: null });
      this.save();
      this.log(who, 'Backup automático FALHOU', `${trigger}: ${e.message}`);
      throw e;
    } finally {
      this.running = false;
    }
  }

  // Apaga as cópias mais antigas além da quantidade configurada.
  prune() {
    const list = this.list();
    let n = 0;
    for (const b of list.slice(this.cfg.keep)) {
      fs.rmSync(path.join(this.folder(), b.name), { recursive: true, force: true });
      n++;
    }
    return n;
  }

  list() {
    const dir = this.folder();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME_RE.test(d.name) && fs.existsSync(path.join(dir, d.name, 'backup-geral.json')))
      .map((d) => {
        const p = path.join(dir, d.name);
        const hist = fs.existsSync(path.join(p, 'historico')) ? fs.readdirSync(path.join(p, 'historico')).filter((f) => f.endsWith('.db')) : [];
        return { name: d.name, ts: fs.statSync(path.join(p, 'backup-geral.json')).mtimeMs, size: dirSize(p), history: hist.map((f) => f.replace(/\.db$/, '')) };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  bundlePath(name) {
    if (!NAME_RE.test(name)) throw new Error('Backup inválido');
    const f = path.join(this.folder(), name, 'backup-geral.json');
    if (!fs.existsSync(f)) throw new Error('Backup não encontrado');
    return f;
  }

  historyPath(name, slug) {
    if (!NAME_RE.test(name) || !/^[a-z0-9-]+$/.test(slug)) throw new Error('Backup inválido');
    const f = path.join(this.folder(), name, 'historico', `${slug}.db`);
    return fs.existsSync(f) ? f : null;
  }
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

module.exports = { AutoBackup };
