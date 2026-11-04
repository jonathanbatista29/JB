// Imagens do projeto: biblioteca, envio e seletor usado no editor.
import { h, api, toast, confirmBox, openModal, closeModal, canEdit } from './state.js';

export let imageList = [];
const MAX = 5 * 1024 * 1024;

export const imgUrl = (file) => (file ? 'imagens/' + encodeURIComponent(file) : '');

export async function loadImages() {
  try { imageList = await api('api/images'); } catch { imageList = []; }
  return imageList;
}

// Fundo da tela: cor + imagem opcional.
export function screenBackground(s) {
  const st = { background: s.bg || '#1e2530' };
  if (s.bgImage) {
    st.backgroundImage = `url("${imgUrl(s.bgImage)}")`;
    st.backgroundRepeat = 'no-repeat';
    st.backgroundPosition = 'center';
    st.backgroundSize = s.bgFit === 'contain' ? 'contain' : s.bgFit === 'stretch' ? '100% 100%' : 'cover';
  }
  return st;
}

// Envia um arquivo de imagem do computador/celular. Devolve o nome salvo.
export function uploadFile(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) return reject(new Error('Use PNG, JPG, GIF, WEBP ou SVG'));
    if (file.size > MAX) return reject(new Error('Imagem maior que 5 MB'));
    const r = new FileReader();
    r.onload = async () => {
      try {
        const { file: saved } = await api('api/images', { method: 'POST', body: { name: file.name, data: r.result } });
        await loadImages();
        resolve(saved);
      } catch (e) { reject(e); }
    };
    r.onerror = () => reject(new Error('Não foi possível ler o arquivo'));
    r.readAsDataURL(file);
  });
}

export function pickAndUpload() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const f = input.files[0];
      input.remove();
      if (!f) return resolve(null);
      try { const saved = await uploadFile(f); toast('Imagem enviada', 'ok'); resolve(saved); } catch (e) { toast(e.message, 'err'); resolve(null); }
    });
    document.body.append(input);
    input.click();
  });
}

// Seletor de imagem para o painel de propriedades: lista + miniatura + enviar.
export function imagePicker(value, onChange) {
  const thumb = h('div', { class: 'img-thumb' }, value ? h('img', { src: imgUrl(value), alt: '' }) : h('span', { class: 'hint' }, 'sem imagem'));
  const sel = h('select', { onchange: (e) => onChange(e.target.value) },
    h('option', { value: '' }, '— nenhuma —'),
    imageList.map((i) => h('option', { value: i.file, selected: i.file === value }, i.file)));
  if (value && !imageList.some((i) => i.file === value)) sel.append(h('option', { value, selected: true }, `${value} (não encontrada!)`));
  return h('div', { class: 'img-picker' }, thumb,
    h('div', { class: 'img-picker-ctl' }, sel,
      h('div', { style: { display: 'flex', gap: '4px' } },
        h('button', { class: 'btn small', type: 'button', onclick: async () => { const f = await pickAndUpload(); if (f) onChange(f); } }, '⬆ Enviar imagem'),
        h('button', { class: 'btn small', type: 'button', onclick: () => manageImages(onChange) }, 'Biblioteca'))));
}

// Biblioteca: ver, escolher e excluir imagens do projeto.
export async function manageImages(onPick) {
  await loadImages();
  const grid = h('div', { class: 'img-lib' }, imageList.length ? imageList.map((i) => h('div', { class: 'img-lib-item' },
    h('img', { src: imgUrl(i.file), alt: i.file, onclick: () => { if (onPick) { onPick(i.file); closeModal(); } } }),
    h('small', {}, i.file), h('small', { class: 'hint' }, `${Math.max(1, Math.round(i.size / 1024))} KB${i.used ? ' · em uso' : ''}`),
    canEdit() ? h('button', { class: 'btn small danger', onclick: async () => {
      if (!(await confirmBox(`Excluir a imagem "${i.file}"?`))) return manageImages(onPick);
      try { await api(`api/images/${encodeURIComponent(i.file)}`, { method: 'DELETE' }); toast('Imagem excluída', 'ok'); } catch (e) { toast(e.message, 'err'); }
      manageImages(onPick);
    } }, 'Excluir') : '')) : h('p', { class: 'hint' }, 'Nenhuma imagem enviada ainda.'));
  openModal(h('div', { style: { width: '640px', maxWidth: '100%' } },
    h('h3', {}, 'Imagens do projeto'),
    h('p', { class: 'hint' }, onPick ? 'Clique numa imagem para usar. ' : '', 'PNG, JPG, GIF, WEBP ou SVG, até 5 MB. As imagens vão junto no backup do projeto.'),
    grid,
    h('div', { class: 'confirm-actions' },
      canEdit() ? h('button', { class: 'btn', onclick: async () => { const f = await pickAndUpload(); if (f && onPick) { onPick(f); closeModal(); } else manageImages(onPick); } }, '⬆ Enviar imagem') : '',
      h('button', { class: 'btn primary', onclick: closeModal }, 'Fechar'))));
}
