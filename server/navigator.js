'use strict';
const { EventEmitter } = require('events');

// Troca de tela comandada pelo PLC.
//  - Por número: um tag INT/DINT com o número da tela (project.navigation.requestTag).
//  - Por bit: cada tela pode ter um tag BOOL que a abre quando liga (screen.openTag).
// Opcionalmente a IHM zera o pedido depois de trocar e escreve a tela atual em outro tag.
// Roda no servidor para que o "zerar" aconteça uma vez só, mesmo com vários painéis abertos.
class Navigator extends EventEmitter {
  constructor(tm) {
    super();
    this.tm = tm;
    this.project = { screens: [], navigation: {} };
    this.prev = new Map(); // tag -> último valor visto
    this.lastReported = null;
  }

  configure(project) {
    this.project = project;
    this.prev.clear();
    // Avalia o estado atual na próxima leitura (o PLC pode já estar pedindo uma tela).
  }

  onValues(changed) {
    const nav = this.project.navigation || {};
    if (nav.requestTag && changed[nav.requestTag]) this.checkRequest(nav, changed[nav.requestTag]);
    for (const s of this.project.screens) {
      if (s.openTag && changed[s.openTag]) this.checkBit(s, changed[s.openTag]);
    }
  }

  checkRequest(nav, val) {
    if (val.q !== 'good') return;
    const n = Number(val.v);
    const prev = this.prev.get(nav.requestTag);
    this.prev.set(nav.requestTag, n);
    if (!Number.isFinite(n) || n <= 0 || n === prev) return;
    const screen = this.project.screens.find((s) => Number(s.number) === n);
    if (!screen) return this.emit('warning', `PLC pediu a tela nº ${n}, que não existe`);
    this.emit('navigate', { screen: screen.id, source: `${nav.requestTag} = ${n}` });
    if (nav.resetRequest) this.reset(nav.requestTag, 0);
  }

  checkBit(screen, val) {
    if (val.q !== 'good') return;
    const on = val.v === true || (typeof val.v === 'number' && val.v !== 0);
    const prev = this.prev.get(screen.openTag);
    this.prev.set(screen.openTag, on);
    if (!on || prev === true) return; // só na subida (desligado -> ligado)
    this.emit('navigate', { screen: screen.id, source: `${screen.openTag} ligou` });
    if (screen.resetOpenTag) this.reset(screen.openTag, false);
  }

  reset(tag, value) {
    this.tm.write(tag, value).catch((e) => this.emit('warning', `Não foi possível zerar ${tag}: ${e.message}`));
  }

  // Um painel informou qual tela está mostrando: escreve o número no tag de "tela atual".
  reportScreen(screenId) {
    const tag = this.project.navigation?.currentTag;
    const screen = this.project.screens.find((s) => s.id === screenId);
    if (!tag || !screen || screen.number == null) return;
    const n = Number(screen.number);
    if (n === this.lastReported) return;
    this.lastReported = n;
    this.tm.write(tag, n).catch((e) => {
      this.lastReported = null;
      this.emit('warning', `Não foi possível escrever a tela atual em ${tag}: ${e.message}`);
    });
  }
}

module.exports = { Navigator };
