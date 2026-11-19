// programGUIDE-style cycle input screens: parameter forms generated from the cycle metadata, help
// pictures, call generation and "recompile" (parsing an existing call back into the form).
import { CYCLES } from '../gcode/sinucycles.js';
import { splitArgs } from '../gcode/siemens.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- help pictures (simple, schematic)
const S = (body) => `<svg viewBox="0 0 230 190" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans Condensed, Arial" font-size="10">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#1d6bd0"/></marker></defs>${body}</svg>`;
const dim = (x1, y1, x2, y2, label, lx, ly) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1d6bd0" stroke-width="1" marker-start="url(#ar)" marker-end="url(#ar)"/><text x="${lx}" y="${ly}" fill="#1d6bd0" font-weight="700">${label}</text>`;
const hline = (y, label, x1 = 20, x2 = 210) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#7a8794" stroke-dasharray="4 3"/><text x="${x2 - 2}" y="${y - 3}" text-anchor="end" fill="#3b4a58">${label}</text>`;
const tool = (x, ytip, w = 14, h = 70) => `<rect x="${x - w / 2}" y="${ytip - h}" width="${w}" height="${h}" fill="#c3ccd4" stroke="#55626f"/><path d="M${x - w / 2} ${ytip - 6} L${x} ${ytip} L${x + w / 2} ${ytip - 6}" fill="#c3ccd4" stroke="#55626f"/>`;
const block = (y, h = 60) => `<rect x="20" y="${y}" width="190" height="${h}" fill="#e7ecf1" stroke="#7a8794"/>`;

function drillPic(extra = '') {
  return S(`${block(100, 70)}<rect x="104" y="100" width="22" height="48" fill="#fff" stroke="#7a8794"/>
  ${hline(30, 'RTP')}${hline(100, 'RFP')}${hline(82, 'RFP+SDIS')}${hline(148, 'DP')}
  ${tool(115, 82)}${dim(60, 100, 60, 148, 'DPR', 64, 128)}${extra}
  <path d="M115 40 V20" stroke="#c21d1d" stroke-width="1.5" marker-end="url(#ar)"/>`);
}

const PICS = {
  CYCLE81: () => drillPic(),
  CYCLE82: () => drillPic('<text x="132" y="160" fill="#c21d1d" font-weight="700">DTB</text>'),
  CYCLE83: () => drillPic(`${hline(116, 'FDEP / FDPR', 140)}<text x="30" y="178" fill="#3b4a58">pecks: FDEP, then −DAM per stroke</text>`),
  HOLES1: () => S(`<rect x="10" y="10" width="210" height="170" fill="#f7f9fb" stroke="#d0d7de"/>
    <line x1="30" y1="150" x2="210" y2="60" stroke="#7a8794" stroke-dasharray="4 3"/>
    ${[0, 1, 2, 3].map((k) => `<circle cx="${70 + k * 40}" cy="${130 - k * 20}" r="7" fill="#fff" stroke="#22405b" stroke-width="1.5"/>`).join('')}
    <circle cx="30" cy="150" r="3" fill="#c21d1d"/><text x="22" y="168" fill="#c21d1d" font-weight="700">SPCA, SPCO</text>
    ${dim(30, 150, 70, 130, 'FDIS', 34, 128)}${dim(70, 130, 110, 110, 'DBH', 92, 108)}
    <path d="M60 150 A30 30 0 0 0 57 137" fill="none" stroke="#1d6bd0"/><text x="64" y="146" fill="#1d6bd0" font-weight="700">STA1</text><text x="150" y="40" fill="#3b4a58">NUM holes</text>`),
  HOLES2: () => S(`<rect x="10" y="10" width="210" height="170" fill="#f7f9fb" stroke="#d0d7de"/>
    <circle cx="115" cy="95" r="60" fill="none" stroke="#7a8794" stroke-dasharray="4 3"/>
    ${[0, 1, 2, 3, 4, 5].map((k) => { const a = (k * Math.PI) / 3; return `<circle cx="${115 + 60 * Math.cos(a)}" cy="${95 - 60 * Math.sin(a)}" r="7" fill="#fff" stroke="#22405b" stroke-width="1.5"/>`; }).join('')}
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="88" y="112" fill="#c21d1d" font-weight="700">CPA, CPO</text>
    ${dim(115, 95, 175, 95, 'RAD', 136, 90)}<text x="178" y="60" fill="#1d6bd0" font-weight="700">INDA</text><text x="180" y="110" fill="#1d6bd0" font-weight="700">STA1</text>`),
  CYCLE71: () => S(`<rect x="40" y="40" width="150" height="110" fill="#e7ecf1" stroke="#7a8794"/>
    <path d="M25 55 H205 V80 H25 V105 H205 V130 H25" fill="none" stroke="#1d6bd0" stroke-width="1.5"/>
    <circle cx="40" cy="150" r="3" fill="#c21d1d"/><text x="14" y="168" fill="#c21d1d" font-weight="700">PA, PO</text>
    ${dim(40, 160, 190, 160, 'LENG', 105, 175)}${dim(200, 40, 200, 150, 'WID', 204, 100)}${dim(110, 80, 110, 105, 'MIDA', 114, 96)}<text x="60" y="30" fill="#3b4a58">VARI 31: zig-zag along X</text>`),
  POCKET3: () => S(`<rect x="10" y="10" width="210" height="170" fill="#e7ecf1" stroke="#7a8794"/>
    <rect x="45" y="50" width="140" height="90" rx="18" fill="#fff" stroke="#22405b" stroke-width="1.5"/>
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="90" y="112" fill="#c21d1d" font-weight="700">PA, PO</text>
    ${dim(45, 155, 185, 155, 'LENG', 103, 170)}${dim(197, 50, 197, 140, 'WID', 200, 100)}<text x="150" y="44" fill="#1d6bd0" font-weight="700">CRAD</text>
    <path d="M115 95 m20 0 a20 20 0 1 1 -40 0 a20 20 0 1 1 40 0" fill="none" stroke="#1d6bd0" stroke-dasharray="3 3"/><text x="20" y="30" fill="#3b4a58">roughing from the centre outwards, STA rotates</text>`),
  POCKET4: () => S(`<rect x="10" y="10" width="210" height="170" fill="#e7ecf1" stroke="#7a8794"/>
    <circle cx="115" cy="95" r="62" fill="#fff" stroke="#22405b" stroke-width="1.5"/>
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="88" y="112" fill="#c21d1d" font-weight="700">PA, PO</text>
    ${dim(115, 95, 177, 95, 'PRAD', 136, 90)}<path d="M115 95 m12 0 a12 12 0 1 1 -24 0 a12 12 0 1 1 24 0" fill="none" stroke="#1d6bd0" stroke-dasharray="3 3"/><text x="20" y="30" fill="#3b4a58">helical insertion RAD1 / DP1</text>`),
  CYCLE76: () => S(`<rect x="15" y="15" width="200" height="160" fill="#fff" stroke="#7a8794" stroke-dasharray="4 3"/><text x="20" y="30" fill="#3b4a58">blank AP1 x AP2</text>
    <rect x="60" y="60" width="110" height="70" rx="12" fill="#e7ecf1" stroke="#22405b" stroke-width="1.5"/>
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="90" y="112" fill="#c21d1d" font-weight="700">PA, PO</text>
    ${dim(60, 145, 170, 145, 'LENG', 100, 160)}${dim(182, 60, 182, 130, 'WID', 186, 100)}`),
  CYCLE77: () => S(`<circle cx="115" cy="95" r="78" fill="#fff" stroke="#7a8794" stroke-dasharray="4 3"/><text x="20" y="20" fill="#3b4a58">blank AP1 (diameter)</text>
    <circle cx="115" cy="95" r="42" fill="#e7ecf1" stroke="#22405b" stroke-width="1.5"/>
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="88" y="112" fill="#c21d1d" font-weight="700">PA, PO</text>${dim(73, 95, 157, 95, 'PRAD (Ø)', 92, 88)}`),
  LONGHOLE: () => S(`<rect x="10" y="10" width="210" height="170" fill="#e7ecf1" stroke="#7a8794"/>
    ${[45, 135, 225, 315].map((a) => { const r = (a * Math.PI) / 180; const x1 = 115 + 30 * Math.cos(r), y1 = 95 - 30 * Math.sin(r), x2 = 115 + 70 * Math.cos(r), y2 = 95 - 70 * Math.sin(r); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="14" stroke-linecap="round"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#22405b" stroke-width="1"/>`; }).join('')}
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="90" y="112" fill="#c21d1d" font-weight="700">CPA, CPO</text>${dim(115, 95, 136, 74, 'RAD', 120, 76)}<text x="150" y="40" fill="#1d6bd0" font-weight="700">LENG</text>`),
  SLOT1: () => S(`<rect x="10" y="10" width="210" height="170" fill="#e7ecf1" stroke="#7a8794"/>
    ${[0, 90, 180, 270].map((a) => { const r = (a * Math.PI) / 180; const x1 = 115 + 28 * Math.cos(r), y1 = 95 - 28 * Math.sin(r), x2 = 115 + 68 * Math.cos(r), y2 = 95 - 68 * Math.sin(r); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="20" stroke-linecap="round"/>`; }).join('')}
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="122" y="112" fill="#c21d1d" font-weight="700">CPA, CPO</text><text x="160" y="85" fill="#1d6bd0" font-weight="700">LENG, WID</text><text x="30" y="30" fill="#3b4a58">NUM slots, STA1, INDA</text>`),
  SLOT2: () => S(`<rect x="10" y="10" width="210" height="170" fill="#e7ecf1" stroke="#7a8794"/>
    <path d="M175 95 A60 60 0 0 0 145 43" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round"/>
    <path d="M85 43 A60 60 0 0 0 55 95" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round"/>
    <path d="M85 147 A60 60 0 0 0 145 147" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round"/>
    <circle cx="115" cy="95" r="3" fill="#c21d1d"/><text x="90" y="112" fill="#c21d1d" font-weight="700">CPA, CPO</text>${dim(115, 95, 175, 95, 'RAD', 140, 90)}<text x="170" y="40" fill="#1d6bd0" font-weight="700">AFSL</text>`),
  CYCLE72: () => S(`<rect x="10" y="10" width="210" height="170" fill="#fff" stroke="#d0d7de"/>
    <path d="M60 50 H150 A20 20 0 0 1 170 70 V120 A20 20 0 0 1 150 140 H60 A45 45 0 0 1 60 50" fill="#e7ecf1" stroke="#22405b" stroke-width="1.5"/>
    <path d="M60 38 H150 A32 32 0 0 1 182 70 V120 A32 32 0 0 1 150 152 H60 A57 57 0 0 1 60 38" fill="none" stroke="#1d6bd0" stroke-dasharray="4 3"/>
    <path d="M40 18 A20 20 0 0 0 60 38" fill="none" stroke="#c21d1d" stroke-width="1.5" marker-end="url(#ar)"/><text x="16" y="16" fill="#c21d1d" font-weight="700">AS1 / LP1</text>
    <text x="80" y="100" fill="#22405b" font-weight="700">"START:END"</text><text x="150" y="168" fill="#1d6bd0" font-weight="700">RL=41 + FAL</text>`),
};

export function cyclePicture(name) {
  return (PICS[name] || (() => S('<text x="20" y="40">No picture</text>')))();
}

// ---------------------------------------------------------------- call parsing / formatting
export function findCall(line) {
  const names = Object.keys(CYCLES).join('|');
  const m = new RegExp(`\\b(${names})\\s*\\(`, 'i').exec(line);
  if (!m) return null;
  const start = m.index + m[0].length;
  let d = 1, q = false, i = start;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    if (q) continue;
    if (c === '(') d++;
    if (c === ')' && --d === 0) break;
  }
  if (d !== 0) return null;
  const inner = line.slice(start, i);
  return { name: m[1].toUpperCase(), args: inner.trim() === '' ? [] : splitArgs(inner), start: m.index, end: i + 1, modal: /\bMCALL\b/i.test(line.slice(0, m.index)) };
}

export function formatCall(name, values) {
  const v = [...values].map((x) => String(x ?? '').trim());
  while (v.length && v[v.length - 1] === '') v.pop();
  return `${name}(${v.join(',')})`;
}

// ---------------------------------------------------------------- form
export function buildForm(name, args) {
  const cy = CYCLES[name];
  const vals = cy.params.map((p, i) => (args && args[i] !== undefined ? args[i] : String(p.def ?? '')));
  const rows = cy.params.map((p, i) => `<span class="pk">${esc(p.k)}</span><label for="cf_${i}" title="${esc(p.hint || p.label)}">${esc(p.label)}</label><span class="cf-in"><input id="cf_${i}" data-i="${i}" value="${esc(vals[i])}" spellcheck="false" autocomplete="off" title="${esc(p.hint || '')}"><em class="unit">${esc(p.unit || '')}</em></span>`);
  const html = `<div class="hp"><div class="hbox"><div class="hbox-h">${esc(name)} · ${esc(cy.title)}<span class="r">${cy.modal ? 'MCALL possible' : ''}</span></div>
    <div class="hbox-b hform"><div class="fields">${rows.join('')}</div>
    <div class="pic">${cyclePicture(name)}<p>${esc(cy.desc)}</p><p class="cf-help" id="cfHelp"></p><div class="preview" id="cfPreview"></div></div></div></div></div>`;
  return { html, units: cy.params.map((p) => p.unit) };
}

export function readForm(root, name) {
  const cy = CYCLES[name];
  return cy.params.map((_, i) => root.querySelector(`#cf_${i}`)?.value ?? '');
}
