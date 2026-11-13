// DOM interface: HUD, panels (bag, shop, areas, menu), refinery list, toasts, inspect modal.
import { DETECTORS, DIGGERS, BAGS, GEAR, AREAS, ACHIEVEMENTS, RARITIES, RARITY_ORDER, TREASURES, xpForLevel } from './config.js';
import { valueOf, itemName, purityLabel, massLabel, currentPrices, fineGold } from './treasure.js';
import { detector, digger, bag, capacity, hasGear, areaLocked } from './state.js';
import { Audio } from './audio.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const money = (v, dp = 2) => '£' + Number(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const moneyShort = (v) => (v >= 1e6 ? '£' + (v / 1e6).toFixed(2) + 'm' : v >= 1e4 ? '£' + Math.round(v / 1000).toLocaleString('en-GB') + 'k' : money(v, v < 100 ? 2 : 0));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Player level needed for each equipment tier.
export const TIER_LEVEL = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 12 };
const GEAR_LEVEL = { 1: 1, 2: 4, 3: 8 };

// ---- product art (inline SVG) ---------------------------------------------------------
const TIER_COL = ['#9a958b', '#6fcf7a', '#4ea3ff', '#c070ff', '#ffb52e'];
function art(cat, idx, id) {
  const c = TIER_COL[idx] || '#f2c14e';
  const s = (body) => `<svg viewBox="0 0 64 64" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  if (cat === 'det') {
    return s(`<path d="M40 8 22 40" stroke="#c9ccd0" stroke-width="3"/><path d="M40 8l6-2 2 5" stroke="#c9ccd0" stroke-width="3"/>
      <rect x="32" y="14" width="12" height="8" rx="2" transform="rotate(30 38 18)" fill="#2a2d31" stroke="${c}" stroke-width="2"/>
      <ellipse cx="18" cy="46" rx="${12 + idx * 1.6}" ry="${6 + idx * 0.8}" fill="#1c1d20" stroke="${c}" stroke-width="3"/>
      ${idx >= 3 ? `<ellipse cx="18" cy="46" rx="${6 + idx}" ry="3" stroke="${c}" stroke-width="1.5" opacity=".7"/>` : ''}`);
  }
  if (cat === 'dig') {
    if (idx === 2) return s(`<path d="M44 8 24 40" stroke="#b58a55" stroke-width="4"/><path d="M14 38h24M16 38v12M21 38v13M26 38v13M31 38v13M36 38v12" stroke="${c}" stroke-width="3"/>`);
    if (idx === 4) return s(`<rect x="8" y="34" width="34" height="16" rx="3" fill="#2a2d31" stroke="${c}" stroke-width="2.5"/><circle cx="16" cy="52" r="4" fill="#111" stroke="#888" stroke-width="2"/><circle cx="34" cy="52" r="4" fill="#111" stroke="#888" stroke-width="2"/><path d="M42 38 54 18l4 4-10 18" stroke="${c}" stroke-width="3"/><path d="M12 34V24h18v10" stroke="#888" stroke-width="2"/><path d="M14 28h14M14 31h14" stroke="#666" stroke-width="1.2"/>`);
    if (idx === 3) return s(`<path d="M18 46 46 18" stroke="#c9ccd0" stroke-width="3"/><path d="M42 14l8 8-6 2-4-4 2-6Z" fill="${c}"/><path d="M12 52l10-10" stroke="#b58a55" stroke-width="4"/><path d="M30 50c6-2 10-6 12-12" stroke="${c}" stroke-width="2.5"/><circle cx="46" cy="44" r="5" stroke="#c9ccd0" stroke-width="2.5"/><path d="M50 48l5 5" stroke="#c9ccd0" stroke-width="2.5"/>`);
    const blade = idx === 0 ? 'M14 50c-4-6-2-12 4-16l8 8c-4 6-8 10-12 8Z' : 'M10 54c-4-8 0-16 8-20l12 12c-4 8-12 12-20 8Z';
    return s(`<path d="M50 8 24 38" stroke="#b58a55" stroke-width="${idx ? 4 : 3}"/><path d="${blade}" fill="#8f949a" stroke="${c}" stroke-width="2.5"/>`);
  }
  if (cat === 'bag') {
    const shapes = [
      `<path d="M18 24h28l-3 26H21L18 24Z" fill="#6b4a2c" stroke="${c}" stroke-width="2.5"/><path d="M24 24a8 8 0 0 1 16 0" stroke="${c}" stroke-width="2.5"/>`,
      `<rect x="12" y="22" width="40" height="28" rx="4" fill="#7a6a48" stroke="${c}" stroke-width="2.5"/><path d="M12 30h40M26 30v6h12v-6" stroke="${c}" stroke-width="2"/><path d="M20 22c0-8 24-8 24 0" stroke="${c}" stroke-width="2.5"/>`,
      `<rect x="16" y="14" width="32" height="40" rx="8" fill="#4a5a3a" stroke="${c}" stroke-width="2.5"/><rect x="22" y="34" width="20" height="14" rx="3" stroke="${c}" stroke-width="2"/><path d="M24 14v-4h16v4" stroke="${c}" stroke-width="2.5"/>`,
      `<rect x="10" y="20" width="44" height="30" rx="4" fill="#2c2f33" stroke="${c}" stroke-width="2.5"/><path d="M10 30h44" stroke="${c}" stroke-width="2"/><rect x="28" y="27" width="8" height="7" rx="1.5" fill="${c}"/><path d="M26 20v-5h12v5" stroke="${c}" stroke-width="2.5"/>`,
      `<rect x="12" y="10" width="38" height="38" rx="4" fill="#3a3d42" stroke="${c}" stroke-width="2.5"/><circle cx="31" cy="29" r="8" stroke="${c}" stroke-width="2.5"/><path d="M31 21v-3M31 40v-3M23 29h-3M42 29h-3" stroke="${c}" stroke-width="2"/><circle cx="18" cy="54" r="4" fill="#111" stroke="#888" stroke-width="2"/><circle cx="44" cy="54" r="4" fill="#111" stroke="#888" stroke-width="2"/>`,
    ];
    return s(shapes[idx] || shapes[0]);
  }
  const g = {
    magnifier: `<circle cx="26" cy="26" r="13" fill="rgba(160,210,255,.12)" stroke="${c}" stroke-width="3"/><path d="M36 36l14 14" stroke="#c9ccd0" stroke-width="5"/>`,
    gloves: `<path d="M20 54V30c0-3 5-3 5 0v-12c0-3 5-3 5 0v-4c0-3 5-3 5 0v4c0-3 5-3 5 0v18l4-4c2-2 6 0 4 3l-8 12v7Z" fill="#c76d2a" stroke="${c}" stroke-width="2"/>`,
    light: `<path d="M18 26h20v14H18z" fill="#2a2d31" stroke="${c}" stroke-width="2.5"/><path d="M38 24l12-6v28l-12-6" fill="rgba(255,220,120,.25)" stroke="${c}" stroke-width="2.5"/><path d="M22 26v-6h12v6" stroke="#888" stroke-width="2.5"/>`,
    sieve: `<ellipse cx="32" cy="28" rx="22" ry="8" stroke="${c}" stroke-width="3"/><path d="M10 28v6c0 4 10 8 22 8s22-4 22-8v-6" stroke="${c}" stroke-width="3"/><path d="M18 28h28M22 24h20M22 32h20M26 21v14M32 20v16M38 21v14" stroke="#888" stroke-width="1.2"/><circle cx="30" cy="50" r="2" fill="#f2c14e"/><circle cx="36" cy="54" r="1.5" fill="#f2c14e"/>`,
    suit: `<path d="M22 12h20l6 10-4 4v28H20V26l-4-4 6-10Z" fill="#d3b22a" stroke="${c}" stroke-width="2.5"/><circle cx="32" cy="24" r="6" fill="#1c2a33" stroke="#888" stroke-width="2"/><path d="M20 42h24" stroke="#1c1d20" stroke-width="3"/>`,
    scanner: `<rect x="14" y="16" width="36" height="26" rx="4" fill="#1d2228" stroke="${c}" stroke-width="2.5"/><path d="M18 34c4-8 8-8 12-2s8 4 14-6" stroke="#7dff9a" stroke-width="2"/><path d="M26 42v10h12V42" stroke="${c}" stroke-width="2.5"/>`,
  };
  return s(g[id] || '');
}

function cmpRow(label, from, to, better) {
  const same = String(from) === String(to);
  const cls = same ? '' : better ? 'up' : 'down';
  return `<div class="stat"><span>${label}</span><span class="from">${from}</span><span class="arrow">${same ? '' : '→'}</span><span class="to ${cls}">${same ? '' : to}</span></div>`;
}
const idName = (n) => ['Tone only', 'Ferrous / non-ferrous', 'Full metal ID'][n];
const notchName = (n) => ['None', 'Iron reject', 'Iron + aluminium'][n];

export class UI {
  constructor(game) {
    this.g = game;
    this.sort = 'value';
    this.sel = new Set();
    this.refSel = new Set();
    this.refSort = false;
    this.shopCat = 'det';
    this.menuTab = 'stats';
    this.open = null;
    this.meterBars = [];
    const meter = $('#meter');
    for (let k = 0; k < 14; k++) { const i = document.createElement('i'); i.style.setProperty('--k', k); meter.appendChild(i); this.meterBars.push(i); }
    this.wire();
  }

  wire() {
    const g = this.g;
    $('#open-bag').onclick = () => this.toggle('bag');
    $('#open-shop').onclick = () => this.toggle('shop');
    $('#open-areas').onclick = () => this.toggle('areas');
    $('#open-menu').onclick = () => this.toggle('menu');
    $('#open-refinery').onclick = () => g.openRefinery();
    $('#scrim').onclick = () => this.close();
    $$('[data-close]').forEach((b) => (b.onclick = () => this.close()));
    $$('[data-sort]').forEach((b) => (b.onclick = () => { this.sort = b.dataset.sort; $$('[data-sort]').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); Audio.ui(); this.renderBag(); }));
    $('#bag-keep').onclick = () => { g.toggleKeep([...this.sel]); this.sel.clear(); this.renderBag(); };
    $('#bag-sell').onclick = () => { this.close(); g.openRefinery([...this.sel]); };
    $$('#shop-tabs button').forEach((b) => (b.onclick = () => { this.shopCat = b.dataset.cat; $$('#shop-tabs button').forEach((x) => x.setAttribute('aria-selected', x === b ? 'true' : 'false')); Audio.ui(); this.renderShop(); }));
    $$('#menu-tabs button').forEach((b) => (b.onclick = () => { this.menuTab = b.dataset.tab; $$('#menu-tabs button').forEach((x) => x.setAttribute('aria-selected', x === b ? 'true' : 'false')); Audio.ui(); this.renderMenu(); }));
    $('#tool-det').onclick = () => g.toggle('detector');
    $('#tool-light').onclick = () => g.toggle('light');
    $('#tool-scan').onclick = () => g.scan();
    $('#tool-dig').onclick = () => { this.toggle('shop'); this.shopCat = 'dig'; $$('#shop-tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.cat === 'dig' ? 'true' : 'false')); this.renderShop(); };
    $('#t-iron').onclick = () => g.toggle('ironReject');
    $('#t-alu').onclick = () => g.toggle('alReject');
    // refinery
    $('#ref-back').onclick = () => g.closeRefinery();
    $('#ref-all').onclick = () => { this.refSel = new Set(g.state.inventory.filter((i) => !i.keep).map((i) => i.uid)); this.renderRefinery(); };
    $('#ref-none').onclick = () => { this.refSel.clear(); this.renderRefinery(); };
    $('#ref-gold').onclick = () => { this.refSel = new Set(g.state.inventory.filter((i) => !i.keep && i.metal === 'gold').map((i) => i.uid)); this.renderRefinery(); };
    $('#ref-sort').onclick = () => { this.refSort = !this.refSort; $('#ref-sort').setAttribute('aria-pressed', String(this.refSort)); this.renderRefinery(); };
    $('#ref-keep').onclick = () => { g.toggleKeep([...this.refSel]); this.refSel.clear(); this.renderRefinery(); };
    $('#ref-sell').onclick = () => g.sell([...this.refSel]);
    $('#inspect').onclick = (e) => { if (e.target.id === 'inspect' || e.target.closest('[data-close-inspect]')) this.closeInspect(); };
    $('#confirm-no').onclick = () => { $('#confirm').hidden = true; };
  }

  // ---- panels -------------------------------------------------------------------
  toggle(name) {
    if (this.open === name) return this.close();
    this.close(true);
    this.open = name;
    $('#panel-' + name).classList.add('on');
    $('#scrim').classList.add('on');
    Audio.ui();
    this.renderPanel(name);
    this.g.onPanel(true);
  }
  close(silent) {
    if (!this.open) return;
    $('#panel-' + this.open).classList.remove('on');
    $('#scrim').classList.remove('on');
    this.open = null;
    if (!silent) Audio.ui();
    this.g.onPanel(false);
  }
  renderPanel(name = this.open) {
    if (name === 'bag') this.renderBag();
    if (name === 'shop') this.renderShop();
    if (name === 'areas') this.renderAreas();
    if (name === 'menu') this.renderMenu();
  }
  refresh() { if (this.open) this.renderPanel(); }

  // ---- HUD --------------------------------------------------------------------------
  hud() {
    const s = this.g.state;
    $('#balance').textContent = money(s.balance);
    $('#lvl').textContent = s.level;
    const a = xpForLevel(s.level), b = xpForLevel(s.level + 1);
    $('#xp-bar').style.width = `${Math.min(100, ((s.xp - a) / (b - a)) * 100)}%`;
    $('#xp-text').textContent = `${(s.xp - a).toLocaleString('en-GB')} / ${(b - a).toLocaleString('en-GB')} XP`;
    const cap = capacity(s);
    $('#bag-text').textContent = `${s.inventory.length}/${cap}`;
    $('#bag-chip').classList.toggle('full', s.inventory.length >= cap);
    const badge = $('#bag-badge');
    badge.hidden = !s.inventory.length;
    badge.textContent = s.inventory.length;
    const d = detector(s);
    $('#det-name').textContent = d.name;
    $('#det-spec').textContent = `${d.radius} m · ${d.depth} m deep`;
    $('#t-iron').disabled = d.notch < 1;
    $('#t-alu').disabled = d.notch < 2;
    $('#t-iron').setAttribute('aria-pressed', String(s.toggles.ironReject && d.notch >= 1));
    $('#t-alu').setAttribute('aria-pressed', String(s.toggles.alReject && d.notch >= 2));
    $('#tool-det').setAttribute('aria-pressed', String(s.toggles.detector));
    $('#dig-name').textContent = digger(s).short;
    $('#tool-light').disabled = !hasGear(s, 'light');
    $('#tool-light').setAttribute('aria-pressed', String(hasGear(s, 'light') && s.toggles.light));
    $('#tool-light').title = hasGear(s, 'light') ? 'Search light (L)' : 'Search light: buy it at Prospector Supply';
    $('#tool-scan').disabled = !hasGear(s, 'scanner');
    $('#tool-scan').title = hasGear(s, 'scanner') ? 'Gold pulse scanner (F)' : 'Gold pulse scanner: buy it at Prospector Supply';
    const p = this.g.pileInfo();
    $('#area-name').textContent = this.g.area.name;
    $('#pile-info').textContent = `Load ${p.number} · ${Math.round(p.cleared * 100)}% cleared`;
    $('#found-text').textContent = `${p.found} found`;
    const o = this.g.objective();
    $('#objective').textContent = o.text;
    $('#objective-prog').textContent = o.prog || '';
  }
  bumpMoney() { const m = $('#money'); m.classList.remove('bump'); void m.offsetWidth; m.classList.add('bump'); }

  detector(val, id, depth, metal, enabled) {
    const n = Math.round(val * 14);
    const col = metal === 1 ? '#ff6b57' : metal === 5 ? '#ffd479' : metal === 4 ? '#dfe7ff' : '#f2c14e';
    this.meterBars.forEach((b, i) => { b.style.background = i < n ? col : ''; });
    $('#det-val').textContent = enabled ? String(Math.round(val * 99)).padStart(2, '0') : 'OFF';
    $('#det-id').firstChild.textContent = enabled ? (id || '—') : '—';
    $('#det-depth').textContent = depth || '';
    $('#det-card').style.opacity = enabled ? '1' : '.6';
  }
  digProgress(k) { $('#dig-progress').style.width = `${Math.round(k * 100)}%`; }
  scanCooldown(k) { const el = $('#scan-cd'); el.hidden = k <= 0; el.style.transform = `scaleY(${k})`; }

  tip(x, y, html) {
    const t = $('#tip');
    if (!html) { t.hidden = true; return; }
    t.hidden = false;
    t.innerHTML = html;
    const w = t.offsetWidth, h = t.offsetHeight;
    t.style.left = `${Math.min(x, window.innerWidth - w - 24)}px`;
    t.style.top = `${Math.min(y, window.innerHeight - h - 24)}px`;
  }

  // ---- toasts -------------------------------------------------------------------------
  toast(html, { cls = '', rc = null, ms = 4200 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast ' + cls;
    if (rc) el.style.setProperty('--rc', rc);
    el.innerHTML = html;
    const box = $('#toasts');
    box.prepend(el);
    while (box.children.length > 4) box.lastChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, ms);
  }
  findToast(item, value) {
    const R = RARITIES[item.rarity];
    this.toast(`<img alt="" src="${this.g.thumbs.get(item)}"><div><div class="rar">${R.name} find</div><h4>${esc(itemName(item))}</h4><p>${massLabel(item.mass)} · ${purityLabel(item)} · <b>${money(value)}</b></p></div>`, { rc: R.color, ms: item.rarity === 'legendary' ? 8000 : item.rarity === 'epic' ? 6000 : 3800 });
  }
  info(title, text, icon = 'star') {
    const icons = {
      star: '<path d="m12 3 3 6 6 1-4.5 4 1 6L12 17l-5.5 3 1-6L3 10l6-1 3-6Z"/>',
      up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
      warn: '<path d="M12 4 21 19H3L12 4Z"/><path d="M12 10v4M12 16.5v.5"/>',
      bag: '<path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/>',
      cash: '<rect x="3" y="7" width="18" height="10" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
    };
    this.toast(`<div class="ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${icons[icon] || icons.star}</svg></div><div><h4>${esc(title)}</h4><p>${esc(text)}</p></div>`, { cls: 'plain', ms: 4200 });
  }
  flash() { const f = $('#flash'); f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }
  flyToBag(x, y, img) {
    const target = $('#open-bag').getBoundingClientRect();
    const el = document.createElement('img');
    el.className = 'fly';
    el.src = img;
    el.style.left = `${x - 22}px`;
    el.style.top = `${y - 22}px`;
    document.body.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      el.style.transform = `translate(${target.left + target.width / 2 - x}px, ${target.top + target.height / 2 - y}px) scale(.4)`;
      el.style.opacity = '0.2';
    }));
    setTimeout(() => el.remove(), 900);
  }
  paid(amount) {
    const p = $('#paid');
    p.hidden = false;
    $('#paid-amt').textContent = money(amount);
    p.classList.remove('on');
    void p.offsetWidth;
    p.classList.add('on');
    setTimeout(() => (p.hidden = true), 2500);
    // coins burst towards the balance
    const tgt = $('#balance').getBoundingClientRect();
    const n = Math.min(26, 6 + Math.floor(Math.log10(amount + 1) * 5));
    for (let k = 0; k < n; k++) {
      const c = document.createElement('div');
      c.className = 'coin';
      const sx = window.innerWidth * (0.3 + Math.random() * 0.3), sy = window.innerHeight * (0.4 + Math.random() * 0.2);
      c.style.left = `${sx}px`;
      c.style.top = `${sy}px`;
      c.style.transition = `transform ${0.7 + Math.random() * 0.4}s cubic-bezier(.5,-0.4,.6,1) ${0.3 + k * 0.03}s, opacity .3s ${1.1 + k * 0.03}s`;
      document.body.appendChild(c);
      requestAnimationFrame(() => requestAnimationFrame(() => { c.style.transform = `translate(${tgt.left + tgt.width / 2 - sx}px, ${tgt.top + tgt.height / 2 - sy}px) scale(.6)`; c.style.opacity = '0'; }));
      setTimeout(() => c.remove(), 2000);
    }
  }
  confirm(title, text, yes, onYes) {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    $('#confirm-yes').textContent = yes;
    $('#confirm').hidden = false;
    $('#confirm-yes').onclick = () => { $('#confirm').hidden = true; onYes(); };
  }

  // ---- item rows ------------------------------------------------------------------------
  sorted(list, mode) {
    const prices = currentPrices();
    const l = [...list];
    if (mode === 'value') l.sort((a, b) => valueOf(b, prices) - valueOf(a, prices));
    if (mode === 'rarity') l.sort((a, b) => RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) || valueOf(b, prices) - valueOf(a, prices));
    if (mode === 'weight') l.sort((a, b) => b.mass - a.mass);
    if (mode === 'recent') l.sort((a, b) => (b.found || 0) - (a.found || 0));
    return l;
  }
  row(item, selected, prices, { disabled = false } = {}) {
    const R = RARITIES[item.rarity];
    return `<div class="item ${selected ? 'sel' : ''}" data-uid="${esc(item.uid)}" style="--rc:${R.color};${disabled ? 'opacity:.55' : ''}">
      <span class="check"></span>
      <img alt="Inspect ${esc(itemName(item))}" src="${this.g.thumbs.get(item)}" data-inspect>
      <div class="meta"><span class="r">${R.name}${item.keep ? ' · <span class="keep">KEPT</span>' : ''}</span><b>${esc(itemName(item))}</b><small class="num">${massLabel(item.mass)} · ${purityLabel(item)}</small></div>
      <div class="val num">${money(valueOf(item, prices))}<small>${TREASURES[item.kind].pricing === 'fixed' ? 'APPRAISED' : TREASURES[item.kind].pricing === 'premium' ? 'COLLECTOR' : 'MELT 92%'}</small></div>
    </div>`;
  }
  bindRows(root, sel, after, { blockKept = false } = {}) {
    $$('.item', root).forEach((el) => {
      el.onclick = (e) => {
        const uid = el.dataset.uid;
        if (e.target.closest('[data-inspect]')) { this.inspect(this.g.state.inventory.find((i) => i.uid === uid)); return; }
        const it = this.g.state.inventory.find((i) => i.uid === uid);
        if (blockKept && it.keep) { this.info('Kept item', 'Unkeep it first if you want to sell it.', 'warn'); Audio.error(); return; }
        if (sel.has(uid)) sel.delete(uid); else sel.add(uid);
        Audio.ui();
        after();
      };
    });
  }

  renderBag() {
    const s = this.g.state, prices = currentPrices();
    const list = this.sorted(s.inventory, this.sort);
    for (const uid of [...this.sel]) if (!s.inventory.find((i) => i.uid === uid)) this.sel.delete(uid);
    $('#bag-sub').textContent = `${s.inventory.length} / ${capacity(s)}`;
    $('#bag-items').innerHTML = list.length ? list.map((i) => this.row(i, this.sel.has(i.uid), prices)).join('') :
      `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg><b>Your bag is empty</b><span>Dig through the pile and click anything that glints.</span></div>`;
    this.bindRows($('#bag-items'), this.sel, () => this.renderBag());
    const total = s.inventory.reduce((a, i) => a + valueOf(i, prices), 0);
    $('#bag-total').textContent = money(total);
    $('#bag-gold').textContent = massLabel(s.inventory.reduce((a, i) => a + (i.metal === 'gold' ? i.mass : 0), 0));
    $('#bag-keep').disabled = !this.sel.size;
    $('#bag-keep').textContent = this.sel.size && [...this.sel].every((u) => s.inventory.find((i) => i.uid === u)?.keep) ? 'Unkeep selected' : 'Keep selected';
    $('#bag-sell').disabled = !s.inventory.length;
    $('#bag-sell').textContent = this.sel.size ? `Sell ${this.sel.size} at refinery` : 'Go to refinery';
  }

  renderRefinery() {
    const s = this.g.state, prices = currentPrices();
    for (const uid of [...this.refSel]) { const it = s.inventory.find((i) => i.uid === uid); if (!it || it.keep) this.refSel.delete(uid); }
    const list = this.refSort ? this.sorted(s.inventory, 'value') : this.sorted(s.inventory, 'recent');
    $('#ref-items').innerHTML = list.length ? list.map((i) => this.row(i, this.refSel.has(i.uid), prices, { disabled: i.keep })).join('') :
      `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 20h16"/><path d="M12 4v16"/><path d="M5 9h14"/></svg><b>Nothing to sell yet</b><span>Bring back gold, silver, coins or gems from the pile.</span></div>`;
    this.bindRows($('#ref-items'), this.refSel, () => this.renderRefinery(), { blockKept: true });
    const sel = s.inventory.filter((i) => this.refSel.has(i.uid));
    const pay = sel.reduce((a, i) => a + valueOf(i, prices), 0);
    const w = sel.reduce((a, i) => a + i.mass, 0);
    const fine = sel.reduce((a, i) => a + fineGold(i), 0);
    $('#ref-weight').textContent = massLabel(w);
    $('#ref-fine').textContent = fine > 0 ? `· ${massLabel(fine)} fine gold` : '';
    $('#ref-pay').textContent = money(pay);
    $('#ref-sell').disabled = !sel.length;
    $('#ref-sell').textContent = sel.length ? `Sell ${sel.length} for ${money(pay)}` : 'Sell';
    $('#ref-keep').disabled = !this.refSel.size;
    this.g.refinery.setItems(sel, pay);
    const prev = this.g.lastPrices || prices;
    const d = (a, b) => (a >= b ? `<span class="up">▲ ${((a / b - 1) * 100).toFixed(1)}%</span>` : `<span class="down">▼ ${((1 - a / b) * 100).toFixed(1)}%</span>`);
    $('#rates').innerHTML = `<div class="card rate"><small>Gold 24ct / g</small><b class="num">${money(prices.gold)}</b> ${d(prices.gold, 62.4)}</div>
      <div class="card rate"><small>Silver / g</small><b class="num">${money(prices.silver, 3)}</b> ${d(prices.silver, 0.78)}</div>
      <div class="card rate"><small>In your bag</small><b class="num">${money(s.inventory.reduce((a, i) => a + valueOf(i, prices), 0))}</b></div>`;
    void prev;
  }

  // ---- shop ---------------------------------------------------------------------------
  renderShop() {
    const s = this.g.state;
    $('#shop-bal').textContent = money(s.balance);
    const cat = this.shopCat;
    const list = { det: DETECTORS, dig: DIGGERS, bag: BAGS, gear: GEAR }[cat];
    const eq = cat === 'det' ? detector(s) : cat === 'dig' ? digger(s) : cat === 'bag' ? bag(s) : null;
    const html = list.map((p, idx) => {
      const owned = cat === 'gear' ? hasGear(s, p.id) : s.owned[cat].includes(p.id);
      const equipped = cat !== 'gear' && s.equipped[cat] === p.id;
      const need = cat === 'gear' ? GEAR_LEVEL[p.level] : TIER_LEVEL[p.level];
      const lvlOk = s.level >= need;
      let stats = '';
      if (cat === 'det') {
        stats = cmpRow('Detection range', eq.radius + ' m', p.radius + ' m', p.radius > eq.radius) + cmpRow('Depth', eq.depth + ' m', p.depth + ' m', p.depth > eq.depth) +
          cmpRow('Smallest target', massLabel(eq.minMass), massLabel(p.minMass), p.minMass < eq.minMass) + cmpRow('Metal ID', idName(eq.idLevel), idName(p.idLevel), p.idLevel > eq.idLevel) +
          cmpRow('Discrimination', notchName(eq.notch), notchName(p.notch), p.notch > eq.notch) + cmpRow('Pinpoint compass', eq.pinpoint ? 'Yes' : 'No', p.pinpoint ? 'Yes' : 'No', p.pinpoint && !eq.pinpoint);
      } else if (cat === 'dig') {
        stats = cmpRow('Clearing reach', eq.radius + ' m', p.radius + ' m', p.radius > eq.radius) + cmpRow('Stroke time', eq.time + ' s', p.time + ' s', p.time < eq.time) +
          cmpRow('Layers per stroke', eq.layers, p.layers, p.layers > eq.layers) + cmpRow('Soil per stroke', Math.round(eq.soil * 100) + ' cm', Math.round(p.soil * 100) + ' cm', p.soil > eq.soil) + cmpRow('Auto-sift small finds', eq.sift ? 'Yes' : 'No', p.sift ? 'Yes' : 'No', p.sift && !eq.sift);
      } else if (cat === 'bag') {
        stats = cmpRow('Capacity', eq.capacity + ' finds', p.capacity + ' finds', p.capacity > eq.capacity);
      } else {
        stats = p.stats.map(([l, a, b]) => cmpRow(l, owned ? b : a, b, !owned)).join('');
      }
      const tier = cat === 'gear' ? '' : `<div class="tier">${[1, 2, 3, 4, 5].map((k) => `<i class="${k <= p.level ? 'on' : ''}"></i>`).join('')}</div>`;
      let actions;
      if (equipped) actions = '<span class="owned-tag">Equipped</span>';
      else if (owned && cat === 'gear') actions = '<span class="owned-tag">Owned · always active</span>';
      else if (owned) actions = `<button class="btn small" type="button" data-equip="${p.id}">Equip</button><span class="owned-tag">Owned</span>`;
      else if (!lvlOk) actions = `<span class="lock">Requires level ${need}</span>`;
      else actions = `<button class="btn small ${s.balance >= p.price ? 'primary' : ''}" type="button" data-buy="${p.id}" ${s.balance >= p.price ? '' : 'disabled'}>${s.balance >= p.price ? 'Buy' : 'Need ' + money(p.price - s.balance, 0) + ' more'}</button>`;
      return `<article class="product ${owned ? 'owned' : ''} ${equipped ? 'equipped' : ''}">
        <div class="art">${art(cat, idx, p.id)}${tier}</div>
        <div><h4><span>${esc(p.name)}</span><span class="price num">${p.price ? money(p.price, 0) : 'Starter'}</span></h4>
        <p>${esc(p.desc)}</p><div class="stats">${stats}</div><div class="actions">${actions}</div></div>
      </article>`;
    }).join('');
    $('#products').innerHTML = html;
    $$('[data-buy]').forEach((b) => (b.onclick = () => this.g.buy(cat, b.dataset.buy)));
    $$('[data-equip]').forEach((b) => (b.onclick = () => this.g.equip(cat, b.dataset.equip)));
  }

  // ---- areas --------------------------------------------------------------------------
  renderAreas() {
    const s = this.g.state;
    const grads = {
      dump: 'linear-gradient(135deg,#5d6b4a,#2d2a22)', scrapyard: 'linear-gradient(135deg,#b06a2e,#3a2618)', facility: 'linear-gradient(135deg,#25445a,#0e1418)',
      landfill: 'linear-gradient(135deg,#6e6553,#26221b)', forgotten: 'linear-gradient(135deg,#d0763e,#2b2048)',
    };
    $('#areas').innerHTML = AREAS.map((a, i) => {
      const lock = areaLocked(s, a);
      const cur = s.currentArea === a.id;
      const p = this.g.pileInfoFor(a.id);
      let body;
      if (lock) {
        const reqs = [`<span class="req ${s.level >= a.unlock.level ? 'ok' : 'no'}">Level ${a.unlock.level}</span>`, `<span class="req ${s.balance >= a.unlock.price ? 'ok' : 'no'}">${money(a.unlock.price, 0)}</span>`];
        if (a.unlock.gear) reqs.push(`<span class="req ${hasGear(s, a.unlock.gear) ? 'ok' : 'no'}">${GEAR.find((g) => g.id === a.unlock.gear).name}</span>`);
        if (a.unlock.detector) reqs.push(`<span class="req ${lock.reasons.some((r) => r.includes('Detector')) ? 'no' : 'ok'}">${DETECTORS.find((d) => d.id === a.unlock.detector).name}</span>`);
        body = `<div class="reqs">${reqs.join('')}</div><div class="foot-row"><button class="btn ${lock.canBuy ? 'primary' : ''}" type="button" data-unlock="${a.id}" ${lock.canBuy ? '' : 'disabled'}>Unlock for ${money(a.unlock.price, 0)}</button></div>`;
      } else if (cur) {
        const canNew = p.cleared >= 0.5 || (p.total && p.found / p.total >= 0.6);
        body = `<div class="muted num">Load ${p.number} · ${Math.round(p.cleared * 100)}% cleared · ${p.found} finds so far</div><div class="foot-row"><button class="btn" type="button" data-newpile ${canNew ? '' : 'disabled'} title="${canNew ? '' : 'Clear half of this load first'}">Truck in a fresh load</button></div>`;
      } else {
        body = `<div class="foot-row"><button class="btn primary" type="button" data-travel="${a.id}">Travel here</button></div>`;
      }
      return `<article class="area ${cur ? 'current' : ''} ${lock ? 'locked' : ''}"><div class="hero" style="background:${grads[a.look]}"><h4>${esc(a.name)}</h4><span class="n">AREA ${i + 1}${cur ? ' · YOU ARE HERE' : ''}</span></div>
        <div class="body"><p>${esc(a.blurb)}</p>${body}</div></article>`;
    }).join('');
    $$('[data-unlock]').forEach((b) => (b.onclick = () => this.g.unlockArea(b.dataset.unlock)));
    $$('[data-travel]').forEach((b) => (b.onclick = () => { this.close(); this.g.travel(b.dataset.travel); }));
    $$('[data-newpile]').forEach((b) => (b.onclick = () => this.confirm('Truck in a fresh load?', 'The current pile is hauled away, finds you have not dug up go with it, and a new load is dumped here.', 'New load', () => { this.close(); this.g.newPile(); })));
  }

  // ---- menu --------------------------------------------------------------------------
  renderMenu() {
    const s = this.g.state, st = s.stats, body = $('#menu-body');
    if (this.menuTab === 'stats') {
      const t = Math.floor(st.searchTime);
      const box = (l, v) => `<div class="statbox"><small>${l}</small><b class="num">${v}</b></div>`;
      body.innerHTML = `<h3 class="sec">Prospector</h3><div class="statgrid">
        ${box('Level', s.level)}${box('Experience', s.xp.toLocaleString('en-GB') + ' XP')}
        ${box('Balance', money(s.balance))}${box('Lifetime earnings', money(st.earned))}
        ${box('Gold collected', massLabel(st.goldGrams))}${box('Fine gold content', massLabel(st.fineGoldGrams))}
        ${box('Gold sold', massLabel(st.goldSoldGrams))}${box('Items sold', st.itemsSold)}
        ${box('Treasures found', st.treasures)}${box('Coins found', st.coins)}
        ${box('Rubbish moved', st.rubbish.toLocaleString('en-GB'))}${box('Search time', `${Math.floor(t / 3600)}h ${String(Math.floor(t / 60) % 60).padStart(2, '0')}m`)}
        ${box('Areas unlocked', `${s.areasUnlocked.length} / ${AREAS.length}`)}${box('Best find', st.best ? moneyShort(st.best.value) : '—')}
        </div>
        <h3 class="sec">Finds by rarity</h3><div class="statgrid">${RARITY_ORDER.map((r) => `<div class="statbox" style="border-left:3px solid ${RARITIES[r].color}"><small>${RARITIES[r].name}</small><b class="num">${st.byRarity[r] || 0}</b></div>`).join('')}</div>
        ${st.best ? `<h3 class="sec">Best find</h3><div class="muted">${esc(st.best.name)} · ${money(st.best.value)} · ${esc(st.best.area)}</div>` : ''}`;
    } else if (this.menuTab === 'ach') {
      const got = Object.keys(s.achievements).length;
      body.innerHTML = `<h3 class="sec">${got} of ${ACHIEVEMENTS.length} unlocked</h3><div class="achs">${ACHIEVEMENTS.map((a) => {
        const t = s.achievements[a.id];
        return `<div class="ach ${t ? 'got' : ''}"><span class="medal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 4 2.5 5 5.5.8-4 3.9.9 5.5L12 16.6l-4.9 2.6.9-5.5-4-3.9 5.5-.8L12 4Z"/></svg></span><div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div><small class="muted">${t ? new Date(t).toLocaleDateString('en-GB') : ''}</small></div>`;
      }).join('')}</div>`;
    } else if (this.menuTab === 'equip') {
      const sec = (title, cat, list) => `<h3 class="sec">${title}</h3><div class="achs">${list.filter((p) => s.owned[cat].includes(p.id)).map((p) => `<div class="ach got"><span class="medal" style="background:#2a261e;color:var(--gold)">${p.level}</span><div><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></div>${s.equipped[cat] === p.id ? '<span class="owned-tag">Equipped</span>' : `<button class="btn small" type="button" data-equip-cat="${cat}" data-equip-id="${p.id}">Equip</button>`}</div>`).join('')}</div>`;
      body.innerHTML = sec('Detectors', 'det', DETECTORS) + sec('Digging tools', 'dig', DIGGERS) + sec('Bags', 'bag', BAGS) +
        `<h3 class="sec">Gear</h3><div class="achs">${GEAR.filter((g) => hasGear(s, g.id)).map((g) => `<div class="ach got"><span class="medal" style="background:#2a261e;color:var(--gold)">✓</span><div><b>${esc(g.name)}</b><small>${esc(g.desc)}</small></div></div>`).join('') || '<div class="muted">No extra gear yet. Prospector Supply sells lights, loupes, sieves and more.</div>'}</div>`;
      $$('[data-equip-cat]').forEach((b) => (b.onclick = () => { this.g.equip(b.dataset.equipCat, b.dataset.equipId); this.renderMenu(); }));
    } else {
      const q = s.settings.quality;
      body.innerHTML = `<h3 class="sec">Sound</h3>
        <div class="setting"><div><label for="vol">Master volume</label></div><input id="vol" type="range" min="0" max="1" step="0.05" value="${s.settings.volume}"></div>
        <div class="setting"><div><label for="dvol">Detector volume</label><small>The beeping that guides you to metal.</small></div><input id="dvol" type="range" min="0" max="1" step="0.05" value="${s.settings.detVolume}"></div>
        <h3 class="sec">Graphics</h3>
        <div class="setting"><div><label>Quality</label><small>High adds ambient occlusion, sharper shadows and full resolution.</small></div><div class="seg" id="qseg">${['auto', 'high', 'balanced'].map((k) => `<button type="button" data-q="${k}" aria-pressed="${q === k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div></div>
        <h3 class="sec">Help</h3>
        <div class="setting"><div><label>Controls</label><small>Drag: look around · Scroll / pinch: zoom · Right-drag or two fingers: move · WASD / arrows: move · Q / E: rotate<br>Click: dig or collect · Hold: keep digging · T: detector · L: light · F: scan · I bag · R sell · B shop · M map</small></div><span></span></div>
        <h3 class="sec">Progress</h3>
        <div class="setting"><div><label>Saved automatically</label><small id="saved-at">Progress is stored in this browser.</small></div><button class="btn small" type="button" id="save-now">Save now</button></div>
        <div class="setting"><div><label>Start over</label><small>Erase all progress and begin again with £0.</small></div><button class="btn small" type="button" id="reset" style="color:var(--bad)">Reset progress</button></div>`;
      $('#vol').oninput = (e) => this.g.setSetting('volume', +e.target.value);
      $('#dvol').oninput = (e) => this.g.setSetting('detVolume', +e.target.value);
      $$('#qseg button').forEach((b) => (b.onclick = () => { this.g.setSetting('quality', b.dataset.q); this.renderMenu(); }));
      $('#save-now').onclick = () => { this.g.save(true); $('#saved-at').textContent = 'Saved just now.'; };
      $('#reset').onclick = () => this.confirm('Erase all progress?', 'Your money, finds, equipment and achievements will be deleted. This cannot be undone.', 'Erase everything', () => this.g.resetProgress());
    }
  }

  // ---- inspect ----------------------------------------------------------------------------
  inspect(item) {
    if (!item) return;
    const R = RARITIES[item.rarity], k = TREASURES[item.kind], prices = currentPrices();
    $('#inspect-info').innerHTML = `<span class="rar" style="color:${R.color};font:700 11px var(--f-label);letter-spacing:.22em;text-transform:uppercase">${R.name}${item.keep ? ' · Kept' : ''}</span>
      <h3>${esc(itemName(item))}</h3><p class="desc">${esc(k.desc)}</p>
      <dl><dt>Weight</dt><dd>${massLabel(item.mass)}</dd><dt>Purity</dt><dd>${purityLabel(item)}</dd>
      ${item.metal === 'gold' ? `<dt>Fine gold</dt><dd>${massLabel(fineGold(item))}</dd>` : ''}
      <dt>Value today</dt><dd style="color:var(--gold)">${money(valueOf(item, prices))}</dd>
      <dt>Found</dt><dd style="font-family:var(--f-body);font-size:12.5px">${esc(item.areaName || '')}${item.found ? ' · ' + new Date(item.found).toLocaleDateString('en-GB') : ''}</dd></dl>
      <div class="foot-row"><button class="btn" type="button" id="insp-keep">${item.keep ? 'Unkeep' : 'Keep'}</button><button class="btn" type="button" data-close-inspect>Close</button></div>`;
    $('#inspect').hidden = false;
    $('#insp-keep').onclick = () => { this.g.toggleKeep([item.uid]); this.inspect(item); this.refresh(); if (!$('#refinery').hidden) this.renderRefinery(); };
    this.g.thumbs.startPreview(item, $('#inspect-canvas'));
  }
  closeInspect() { $('#inspect').hidden = true; this.g.thumbs.stopPreview(); }
}
