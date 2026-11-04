// Gera docs/manual/Manual_JB_IHM.pdf a partir de docs/manual/MANUAL.md.
// Uso: npm install --no-save marked playwright && npx playwright install chromium && node scripts/manual-pdf.js

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { chromium } = require('playwright');

const DIR = path.join(__dirname, '..', 'docs', 'manual');
const md = fs.readFileSync(path.join(DIR, 'MANUAL.md'), 'utf8');
// Âncoras dos títulos iguais às do GitHub (para o sumário funcionar no PDF).
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
const renderer = new marked.Renderer();
renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  return `<h${depth} id="${slug(text)}">${text}</h${depth}>\n`;
};
// Imagens embutidas no HTML (o navegador não lê arquivos locais a partir de uma página gerada).
const body = marked.parse(md, { renderer }).replace(/src="(img\/[^"]+\.png)"/g, (m, f) =>
  `src="data:image/png;base64,${fs.readFileSync(path.join(DIR, f)).toString('base64')}"`);

const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><base href="file://${DIR}/">
<style>
  @page { size: A4; margin: 16mm 14mm 18mm; }
  body { font-family: "Segoe UI", Roboto, Arial, sans-serif; color: #1d2733; font-size: 10.5pt; line-height: 1.5; }
  h1 { font-size: 26pt; color: #14324f; margin: 0 0 4px; }
  h1 + p { font-size: 13pt; color: #2d6cdf; margin-top: 0; }
  h2 { font-size: 16pt; color: #fff; background: #14324f; padding: 6px 10px; border-radius: 4px; margin-top: 28px; break-before: page; }
  h2#sumário { break-before: auto; }
  h3 { font-size: 12.5pt; color: #14324f; border-bottom: 2px solid #2d8cff; padding-bottom: 2px; margin-top: 18px; }
  img { display: block; max-width: 100%; max-height: 100mm; margin: 8px auto 14px; border: 1px solid #c7d0db; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,.15); break-inside: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 14px; font-size: 9.5pt; break-inside: avoid; }
  th, td { border: 1px solid #c7d0db; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #e8eef6; }
  code { background: #eef2f7; padding: 1px 4px; border-radius: 3px; font-size: 9.5pt; }
  blockquote { margin: 10px 0; padding: 6px 12px; background: #fff7e6; border-left: 4px solid #f39c12; }
  ol li, ul li { margin: 3px 0; }
  a { color: #1f5f99; text-decoration: none; }
  hr { border: none; border-top: 1px solid #c7d0db; margin: 16px 0; }
</style></head><body>${body}</body></html>`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(html, { waitUntil: 'load' });
  await p.pdf({ path: path.join(DIR, 'Manual_JB_IHM.pdf'), format: 'A4', printBackground: true, displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="font-size:8pt;color:#8796aa;width:100%;text-align:center">Manual da JB IHM — página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
    margin: { top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' } });
  await b.close();
  console.log('PDF gerado:', (fs.statSync(path.join(DIR, 'Manual_JB_IHM.pdf')).size / 1048576).toFixed(1), 'MB');
})();
