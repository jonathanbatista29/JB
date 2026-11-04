'use strict';

// Converte um valor recebido (da tela ou do PLC) para o tipo do tag.
function coerce(value, type) {
  if (type === 'bool') {
    if (typeof value === 'string') return ['1', 'true', 'on', 'ligado'].includes(value.trim().toLowerCase());
    return Boolean(value);
  }
  if (type === 'string') return value == null ? '' : String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${value}`);
  switch (type) {
    case 'int16': return clampInt(n, -32768, 32767);
    case 'uint16': return clampInt(n, 0, 65535);
    case 'int32': return clampInt(n, -2147483648, 2147483647);
    case 'uint32': return clampInt(n, 0, 4294967295);
    default: return n; // float32 / real
  }
}

function clampInt(n, min, max) {
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Fila simples: garante que leituras e escritas da mesma conexão não se sobreponham.
function createQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { coerce, createQueue, sleep };
