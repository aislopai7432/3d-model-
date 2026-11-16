// 808D-style HMI: operating areas, pages and context softkeys (8 horizontal, 8 vertical).
import { MACHINE, MATERIALS, ACCURACY, VISE } from '../config.js';
import { CYCLES } from '../gcode/sinucycles.js';
import { SIE_G, SIE_M, SIE_WORDS } from '../gcode/siemens.js';
import { G_CODES, M_CODES, WORDS, UNSUPPORTED_G, UNSUPPORTED_M, gName, mName } from '../gcode/codes.js';
import { EXPR_FUNCTIONS } from '../gcode/expr.js';
import { EXAMPLES_808 } from '../gcode/examples808.js';
import { buildForm, readForm, findCall, formatCall } from './cycleforms.js';
import { defaultContour, renderContourDesigner, contourCycleCode, contourPathCode } from './contour.js';
import { normName, validName } from './programs.js';
import { surfaceSpeed, chipLoad, holderFor } from '../sim/tooling.js';
import { fmtTime } from '../sim/controller.js';
import { stockPlacement } from '../scene/workholding.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r3 = (v) => Math.round(v * 1000) / 1000;

export const SIE_TYPES = [
  [120, 'flat', 'End mill'], [110, 'ball', 'Ball end mill'], [121, 'bull', 'End mill, corner radius'], [140, 'face', 'Face mill'],
  [200, 'drill', 'Twist drill'], [220, 'spot', 'Centre / spot drill'], [230, 'chamfer', 'Countersink / chamfer'],
];
const typeCode = (t) => (SIE_TYPES.find((x) => x[1] === t) || SIE_TYPES[0])[0];
const typeName = (t) => (SIE_TYPES.find((x) => x[1] === t) || SIE_TYPES[0])[2];

const AREA_TITLE = { machine: 'Machine', offset: 'Offset', program: 'Program', pm: 'Program manager', system: 'System / Alarm' };
const PAGES = ['pos', 'tools', 'wear', 'wo', 'rvar', 'sd', 'blank', 'prog', 'form', 'contour', 'pm', 'alarms', 'msgs', 'settings', 'service', 'ref', 'version'];

export class HMI {
  constructor(app, ui) {
    this.app = app;
    this.ui = ui;
    this.area = 'machine';
    this.pages = { machine: 'pos', offset: 'tools', program: 'prog', pm: 'pm', system: 'alarms' };
    this.sub = { machine: null, program: 'edit' };
    this.cs = 'WCS';
    this.pmFolder = 'nc';
    this.pmSel = null;
    this.toolSel = null;
    this.rPage = 0;
    this.form = null;
    this.contour = defaultContour();
    this.alarms = [];
    this.main = $('#hmiMain');
    this.vskEl = $('#vsk');
    this.hskEl = $('#hsk');
    this.el = {};
    for (const p of PAGES) {
      const d = document.createElement('div');
      d.className = 'hpage';
      d.dataset.page = p;
      d.hidden = true;
      this.main.appendChild(d);
      this.el[p] = d;
    }
    // static program page (the editor element must persist)
    this.el.prog.innerHTML = `<div class="prog-page">
      <div class="findbar" id="findBar" hidden><span>Find</span><input id="findInput" placeholder="text or N number" spellcheck="false"><button class="sk" id="findGo" style="min-height:26px;width:70px">Next</button><button class="sk" id="findClose" style="min-height:26px;width:60px">Close</button></div>
      <div class="editor" id="editor"></div>
      <div class="prog-status"><span id="psName">—</span><span id="psLines">0 lines</span><span id="psErrors" class="ok">No errors</span><span id="psDialect">Siemens</span><span class="r" id="psTime">est. --:--</span></div>
      <div class="diag" id="diagList"></div></div>`;
    this.el.prog.style.height = '100%';
    $$('#areaKeys button').forEach((b) => b.addEventListener('click', () => this.showArea(b.dataset.area)));
  }

  get c() {
    return this.app.controller;
  }

  init() {
    $('#findGo').addEventListener('click', () => this.findNext());
    $('#findInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.findNext(); if (e.key === 'Escape') $('#findBar').hidden = true; });
    $('#findClose').addEventListener('click', () => { $('#findBar').hidden = true; });
    this.showArea('machine');
  }

  // ------------------------------------------------------------------ navigation
  showArea(a) {
    this.area = a;
    $$('#areaKeys button').forEach((b) => b.classList.toggle('on', b.dataset.area === a));
    if (a !== 'program' && this.pages.program === 'form') this.pages.program = 'prog';
    this.showPage(this.pages[a]);
  }

  showPage(p) {
    this.pages[this.area] = p;
    for (const k of PAGES) this.el[k].hidden = k !== p;
    this.renderPage(p);
    this.renderSoftkeys();
    this.renderHeader();
    if (p === 'prog') this.ui.editor.schedule();
  }

  rerender() {
    this.renderPage(this.pages[this.area]);
    this.renderSoftkeys();
  }

  renderHeader() {
    const c = this.c;
    $('#hmiArea').textContent = AREA_TITLE[this.area];
    $('#hmiMode').textContent = c.mode === 'REF' ? 'REF POINT' : c.mode;
    const ch = $('#chanState'), pr = $('#progState');
    const st = c.state;
    ch.className = st === 'running' ? 'act' : st === 'hold' ? 'int' : st === 'alarm' || st === 'estop' ? 'err' : '';
    ch.textContent = st === 'running' ? 'Channel active' : st === 'hold' ? 'Channel interrupted' : 'Channel reset';
    pr.className = ch.className;
    pr.textContent = st === 'running' ? (c.kind === 'program' ? 'Program running' : c.kind === 'mdi' ? 'MDA running' : c.kind === 'homing' ? 'Referencing' : 'Traversing')
      : st === 'hold' ? `Program stopped${c.holdReason ? ': ' + c.holdReason : ''}` : st === 'complete' ? 'Program completed' : st === 'alarm' ? 'Program aborted (alarm)' : st === 'estop' ? 'EMERGENCY STOP' : 'Program aborted';
    $('#hmiProg').textContent = this.app.programName || '—';
  }

  // ------------------------------------------------------------------ softkeys
  renderSoftkeys() {
    const { h, v } = this.softkeys();
    const mk = (list, el) => {
      el.innerHTML = '';
      for (let i = 0; i < 8; i++) {
        const s = list[i];
        const b = document.createElement('button');
        b.className = 'sk' + (!s ? ' empty' : '') + (s?.on ? ' on' : '');
        b.type = 'button';
        if (s) {
          b.innerHTML = esc(s.label).replace(/\n/g, '<br>');
          if (s.title) b.title = s.title;
          if (s.disabled) b.disabled = true;
          b.addEventListener('click', () => {
            this.app.sound.init();
            this.app.sound.click();
            s.act();
          });
        } else b.tabIndex = -1;
        el.appendChild(b);
      }
    };
    mk(h, this.hskEl);
    mk(v, this.vskEl);
  }

  softkeys() {
    const a = this.area, p = this.pages[a];
    const c = this.c;
    const go = (page) => () => this.showPage(page);
    const sk = (label, act, extra = {}) => ({ label, act, ...extra });
    if (a === 'machine') {
      const sub = this.sub.machine;
      const setSub = (s) => () => { this.sub.machine = this.sub.machine === s ? null : s; this.rerender(); };
      const h = [
        sk(this.cs === 'WCS' ? 'Act. val.\nWCS' : 'Act. val.\nMCS', () => { this.cs = this.cs === 'WCS' ? 'MCS' : 'WCS'; this.rerender(); }, { on: this.cs === 'MCS', title: 'Toggle work / machine coordinates' }),
        sk('Prog.\nctrl', setSub('pc'), { on: sub === 'pc' }),
        sk('G funct.', setSub('g'), { on: sub === 'g' }),
        sk('Set WO', setSub('wo'), { on: sub === 'wo', disabled: c.mode !== 'JOG' }),
        sk('T, S, M', setSub('tc'), { on: sub === 'tc' }),
        sk('JOG\ndata', setSub('jog'), { on: sub === 'jog' }),
        sk('Ref. all', () => this.ui.act('home')),
        sk('New\nblank', () => this.ui.act('newBlank'), { title: 'Load a fresh blank (stock)' }),
      ];
      let v = [];
      const back = sk('Back', setSub(sub));
      if (sub === 'pc') {
        const t = (k, l, on) => sk(l, () => this.ui.progCtrl(k), { on });
        v = [t('sbl', 'SBL\nsingle block', c.singleBlock), t('m01', 'M01\ncond. stop', c.optionalStop), t('skp', 'SKP\nskip blocks', this.app.settings.blockDelete), t('dry', 'DRY\ndry run', c.dryRun), t('rov', 'ROV\nrapid ovr', c.rov), null, null, back];
      } else if (sub === 'wo') {
        v = [sk('X=0', () => this.ui.touchOff('x')), sk('Y=0', () => this.ui.touchOff('y')), sk('Z=0', () => this.ui.touchOff('z')), sk('All axes\n=0', () => { this.ui.touchOff('x'); this.ui.touchOff('y'); this.ui.touchOff('z'); }), null, null, null, back];
      } else if (sub === 'tc') {
        v = [sk('Change\ntool', () => this.ui.act('toolChange')), sk('Spindle\nCW', () => this.ui.manualSpindle(1)), sk('Spindle\nstop', () => this.ui.manualSpindle(0)), sk('Spindle\nCCW', () => this.ui.manualSpindle(-1)), sk('Coolant\non', () => this.ui.act('coolantFlood')), sk('Coolant\noff', () => this.ui.act('coolantOff')), null, back];
      } else if (sub === 'g' || sub === 'jog') v = [null, null, null, null, null, null, null, back];
      else if (c.mode === 'MDA') {
        v = [sk('Run\n(START)', () => this.ui.act('cycleStart')), sk('Delete\nMDA', () => { this.ui.setMda(''); }), sk('Go to\nWO zero', () => this.ui.act('gotoZero')), sk('Tool\nchange', setSub('tc')), null, null, null, null];
      } else if (c.mode === 'AUTO') {
        v = [sk('Prog.\nselect', () => { this.showArea('pm'); }), sk('Prog.\nctrl', setSub('pc')), sk('Program\nedit', () => this.showArea('program')), sk('New\nblank', () => this.ui.act('newBlank')), sk('Sim\nMAX', () => this.ui.setSimSpeed(9)), sk('Sim\n1×', () => this.ui.setSimSpeed(2)), null, null];
      } else if (c.mode === 'REF') {
        v = [sk('Ref. Z', () => this.c.refAxis('z')), sk('Ref. X', () => this.c.refAxis('x')), sk('Ref. Y', () => this.c.refAxis('y')), sk('Ref. all', () => this.ui.act('home')), null, null, null, null];
      } else {
        v = [sk('Spindle\nCW', () => this.ui.manualSpindle(1)), sk('Spindle\nstop', () => this.ui.manualSpindle(0)), sk('Spindle\nCCW', () => this.ui.manualSpindle(-1)), sk('Coolant\non/off', () => this.ui.act(c.coolant.flood ? 'coolantOff' : 'coolantFlood')), sk('Doors', () => this.ui.act('door')), sk('Go to\nWO zero', () => this.ui.act('gotoZero')), sk('Set WO', setSub('wo')), sk('Measure\npart', () => this.ui.toggleMeasure())];
      }
      return { h, v };
    }
    if (a === 'offset') {
      const h = [sk('Tool\nlist', go('tools'), { on: p === 'tools' }), sk('Wear', go('wear'), { on: p === 'wear' }), sk('Work\noffset', go('wo'), { on: p === 'wo' }), sk('R\nvariable', go('rvar'), { on: p === 'rvar' }), sk('Setting\ndata', go('sd'), { on: p === 'sd' }), sk('Blank\n(stock)', go('blank'), { on: p === 'blank' }), null, null];
      let v = [];
      if (p === 'tools') v = [sk('New\ntool', () => this.ui.addTool()), sk('Delete\ntool', () => this.ui.deleteTool(this.toolSel)), sk('Load to\nspindle', () => this.ui.loadTool(this.toolSel)), sk('Unload\nspindle', () => this.ui.loadTool(0)), null, null, null, null];
      else if (p === 'wear') v = [sk('New\ncutter', () => this.ui.resetWear(this.toolSel)), sk('Clear\nΔL ΔR', () => this.ui.clearDeltas(this.toolSel)), null, null, null, null, null, null];
      else if (p === 'wo') v = [sk('Set from\nblank', () => this.ui.zeroFromBlank()), sk('Clear\nG54..G59', () => this.ui.clearOffsets()), null, null, null, null, null, null];
      else if (p === 'rvar') v = [sk('R0..R99', () => { this.rPage = 0; this.rerender(); }, { on: this.rPage === 0 }), sk('R100..\nR199', () => { this.rPage = 1; this.rerender(); }, { on: this.rPage === 1 }), sk('R200..\nR299', () => { this.rPage = 2; this.rerender(); }, { on: this.rPage === 2 }), sk('Delete\nall R', () => this.ui.clearR()), null, null, null, null];
      else if (p === 'blank') v = [sk('Load\nblank', () => this.ui.applyStockForm()), sk('Set WO\nfrom blank', () => this.ui.zeroFromBlank()), sk('Setup\nwizard', () => this.ui.act('wizard')), null, null, null, null, null];
      else v = [null, null, null, null, null, null, null, null];
      return { h, v };
    }
    if (a === 'program') {
      if (p === 'form') {
        return { h: [null, null, null, null, null, null, null, null], v: [sk('OK', () => this.formOk()), sk('Default\nvalues', () => this.openForm(this.form.name, null, this.form.line, this.form.replace, this.form.modal)), null, null, null, null, null, sk('Cancel', () => { this.form = null; this.showPage('prog'); })] };
      }
      if (p === 'contour') {
        const cd = this.contour;
        return {
          h: [null, null, null, null, null, null, null, null],
          v: [sk('Add\nline', () => this.contourAdd('L')), sk('Add arc\nG2', () => this.contourAdd('CW')), sk('Add arc\nG3', () => this.contourAdd('CCW')), sk('Delete\nlast', () => { cd.els.pop(); this.rerender(); }),
            sk('Insert\nCYCLE72', () => this.contourInsert('cycle')), sk('Insert\npath', () => this.contourInsert('path')), sk('Reset', () => { this.contour = defaultContour(); this.rerender(); }), sk('Back', () => this.showPage('prog'))],
        };
      }
      const g = this.sub.program;
      const setG = (x) => () => { this.sub.program = x; this.renderSoftkeys(); };
      const h = [sk('Edit', setG('edit'), { on: g === 'edit' }), sk('Drilling', setG('drill'), { on: g === 'drill' }), sk('Milling', setG('mill'), { on: g === 'mill' }), sk('Contour', setG('contour'), { on: g === 'contour' }),
        sk('Simul-\nation', setG('sim'), { on: g === 'sim' }), sk('Re-\ncompile', () => this.recompile()), sk('Execute\n(AUTO)', () => this.ui.executeCurrent()), sk('Save\nas…', () => this.ui.saveAs())];
      const cyc = (n) => sk(`${n}\n${CYCLES[n].title}`, () => this.openForm(n), { title: CYCLES[n].desc });
      let v = [];
      if (g === 'drill') v = [cyc('CYCLE81'), cyc('CYCLE82'), cyc('CYCLE83'), cyc('HOLES1'), cyc('HOLES2'), sk('MCALL\non', () => this.insertLine('MCALL CYCLE81(25,0,2,-5)'), { title: 'Insert a modal call; edit it with Recompile' }), sk('MCALL\noff', () => this.insertLine('MCALL')), null];
      else if (g === 'mill') v = [cyc('CYCLE71'), cyc('POCKET3'), cyc('POCKET4'), cyc('CYCLE76'), cyc('CYCLE77'), cyc('LONGHOLE'), cyc('SLOT1'), cyc('SLOT2')];
      else if (g === 'contour') v = [cyc('CYCLE72'), sk('Contour\ndesigner', () => this.showPage('contour')), sk('G41\nleft', () => this.insertLine('G41 G1 X0 Y0 F1000 ; APPROACH'), { title: 'Insert a G41 approach block' }), sk('G42\nright', () => this.insertLine('G42 G1 X0 Y0 F1000 ; APPROACH')), sk('G40\noff', () => this.insertLine('G40 G1 X0 Y0 ; RETRACT')), sk('RND=', () => this.appendToLine(' RND=2')), sk('CHR=', () => this.appendToLine(' CHR=1')), null];
      else if (g === 'sim') v = [sk('Run sim\nMAX', () => this.ui.simRun()), sk('New\nblank', () => this.ui.act('newBlank')), sk('Toolpath\non/off', () => this.ui.toggleView('toolpath')), sk('View\ntop', () => this.ui.setView('top')), sk('View\niso', () => this.ui.setView('iso')), sk('View\nwork', () => this.ui.setView('work')), sk('Measure', () => this.ui.toggleMeasure()), null];
      else v = [sk('Find', () => { $('#findBar').hidden = false; $('#findInput').focus(); }), sk('Find\nnext', () => this.findNext()), sk('Renumber\nN10..', () => this.renumber()), sk('Comment\n; on/off', () => this.toggleComment()), sk('Delete\nN nos.', () => this.stripN()), sk('Go to\nstart', () => this.ui.editor.gotoLine(0)), sk('Go to\nend', () => this.ui.editor.gotoLine(this.ui.editor.lines.length - 1)), sk('Copy\nline', () => this.copyLine())];
      return { h, v };
    }
    if (a === 'pm') {
      const f = this.pmFolder;
      const h = [sk('NC\nmemory', () => { this.pmFolder = 'nc'; this.pmSel = null; this.rerender(); }, { on: f === 'nc' }), sk('Examples\n(USB)', () => { this.pmFolder = 'ex'; this.pmSel = null; this.rerender(); }, { on: f === 'ex' }), sk('Local\ndrive', () => this.ui.act('openFile'), { title: 'Load a program file from this computer' }), null, null, null, null, null];
      const sel = this.pmSel;
      const v = f === 'nc'
        ? [sk('Execute', () => this.ui.pmExecute('nc', sel), { disabled: !sel }), sk('Open', () => this.ui.pmOpen('nc', sel), { disabled: !sel }), sk('New', () => this.ui.pmNew()), sk('Copy', () => this.ui.pmCopy(sel), { disabled: !sel }), sk('Rename', () => this.ui.pmRename(sel), { disabled: !sel }), sk('Delete', () => this.ui.pmDelete(sel), { disabled: !sel }), sk('Save to\nPC', () => this.ui.pmExport(sel), { disabled: !sel }), sk('Load\nfrom PC', () => this.ui.act('openFile'))]
        : [sk('Execute', () => this.ui.pmExecute('ex', sel), { disabled: !sel }), sk('Copy to\nNC', () => this.ui.pmCopyExample(sel), { disabled: !sel }), null, null, null, null, null, null];
      return { h, v };
    }
    // system
    const h = [sk('Alarm\nlist', go('alarms'), { on: p === 'alarms' }), sk('Messages\n(log)', go('msgs'), { on: p === 'msgs' }), sk('Settings', go('settings'), { on: p === 'settings' }), sk('Service\ndisplay', go('service'), { on: p === 'service' }), sk('Reference\n(codes)', go('ref'), { on: p === 'ref' }), sk('Version', go('version'), { on: p === 'version' }), null, null];
    let v = [null, null, null, null, null, null, null, null];
    if (p === 'alarms') v = [sk('RESET\n(clear)', () => this.ui.act('reset')), sk('Clear\nhistory', () => { this.alarms = this.alarms.filter((x) => x.active); this.rerender(); }), null, null, null, null, null, null];
    if (p === 'msgs') v = [sk('Clear\nmessages', () => { this.ui.logItems.length = 0; this.rerender(); }), null, null, null, null, null, null, null];
    if (p === 'settings') v = [sk('Setup\nwizard', () => this.ui.act('wizard')), sk('Reset all\nsettings', () => this.ui.act('resetAll')), null, null, null, null, null, null];
    return { h, v };
  }

  // ------------------------------------------------------------------ page rendering
  renderPage(p) {
    const fn = this['page_' + p];
    if (fn) fn.call(this, this.el[p]);
  }

  page_pos(el) {
    const c = this.c;
    const sub = this.sub.machine;
    let subHtml = '';
    const s = this.app.settings;
    if (sub === 'pc') subHtml = `<div class="hbox"><div class="hbox-h">Program control</div><div class="hbox-b hnote">SBL stops after every block; M01 enables conditional stops; SKP skips blocks starting with "/"; DRY runs all feed moves at the dry run feed (${s.dryFeed} mm/min, Setting data); ROV lets the feed override knob scale rapid traverse.</div></div>`;
    else if (sub === 'g') subHtml = `<div class="hbox"><div class="hbox-h">Active G functions (${this.app.compiled?.dialect === 'iso' ? 'ISO' : 'Siemens'} mode)</div><div class="hbox-b gfun">${esc(c.modal.codes)}${c.modal.frame && (c.modal.frame.tx || c.modal.frame.ty || c.modal.frame.tz || c.modal.frame.rot) ? `<br>Frame: TRANS X${r3(c.modal.frame.tx)} Y${r3(c.modal.frame.ty)} Z${r3(c.modal.frame.tz)} ROT ${r3(c.modal.frame.rot)}°` : ''}${c.modal.mcall ? `<br>MCALL ${esc(c.modal.mcall)}` : ''}</div></div>`;
    else if (sub === 'wo') subHtml = `<div class="hbox"><div class="hbox-h">Set work offset G${c.modal.wcs === 500 ? '54' : c.modal.wcs} at the tool</div><div class="hbox-b hnote">Jog the tool to the part zero and press X=0 / Y=0 / Z=0. X and Y use the spindle centre line; Z uses the tool tip (geometry length + ΔL of the tool in the spindle).</div></div>`;
    else if (sub === 'tc') subHtml = `<div class="hbox"><div class="hbox-h">T, S, M</div><div class="hbox-b fgrid"><label>Tool<select id="tcTool">${this.app.tools.map((t) => `<option value="${t.number}" ${t.number === c.tool ? 'selected' : ''}>T${t.number} ${esc(t.name)}</option>`).join('')}<option value="0">T0 empty spindle</option></select></label><label>Spindle speed (rpm)<input id="tcRpm" type="number" min="0" max="${MACHINE.maxRpm}" step="100" value="${s.jogRpm}"></label></div></div>`;
    else if (sub === 'jog') subHtml = `<div class="hbox"><div class="hbox-h">JOG data</div><div class="hbox-b fgrid"><label>JOG feed (mm/min)<input id="jdFeed" type="number" min="10" max="6000" step="10" value="${s.jogFeed}"></label><label>JOG spindle speed (rpm)<input id="jdRpm" type="number" min="0" max="${MACHINE.maxRpm}" step="100" value="${s.jogRpm}"></label><label>Increment<select id="jdInc"><option value="0">continuous</option>${[0.001, 0.01, 0.1, 1, 10].map((v) => `<option value="${v}" ${this.ui.inc === v ? 'selected' : ''}>${v} mm</option>`).join('')}</select></label></div></div>`;
    el.innerHTML = `<div class="hp">
      <div class="pos-grid">
        <div class="hbox"><div class="hbox-h">${this.cs === 'WCS' ? 'Workpiece (WCS)' : 'Machine (MCS)'} <span class="r" id="posWcs"></span></div>
          <div class="hbox-b axes"><span></span><span class="hd">POSITION [<span id="posUnit">mm</span>]</span><span class="hd">DIST-TO-GO</span>
          ${['x', 'y', 'z'].map((a) => `<span class="an ${a}">${a.toUpperCase()}<sup id="rf${a}" style="font-size:9px"></sup></span><span class="av" id="pv${a}">0.000</span><span class="ad" id="pd${a}">0.000</span>`).join('')}</div></div>
        <div class="hbox"><div class="hbox-h">T, F, S</div><div class="hbox-b tfs">
          <span class="k">T</span><span class="v" id="tfT">0</span><span class="s" id="tfTn">—</span>
          <span class="k">F</span><span class="v" id="tfF">0</span><span class="s" id="tfFp">0 mm/min</span>
          <span class="k">S</span><span class="v" id="tfS">0</span><span class="s" id="tfSp">0 rpm</span>
          <span class="k" style="font-size:11px">L</span><div class="hbar"><i id="tfLoad"></i></div>
          <span class="s" style="grid-column:1 / -1;text-align:left" id="tfCut">Load 0%</span>
        </div></div>
      </div>
      <div class="hbox" id="modeBox">${this.modePanel()}</div>
      <div class="hbox"><div class="hbox-h">G functions<span class="r flagrow" id="pcFlags"></span></div><div class="hbox-b gfun" id="gLine"></div></div>
      ${subHtml}
    </div>`;
    if (sub === 'tc') {
      $('#tcRpm', el).addEventListener('change', (e) => { s.jogRpm = Math.max(0, Math.min(MACHINE.maxRpm, +e.target.value || 0)); this.app.save(); });
    }
    if (sub === 'jog') {
      $('#jdFeed', el).addEventListener('change', (e) => { s.jogFeed = Math.max(10, Math.min(6000, +e.target.value || 1000)); this.app.save(); });
      $('#jdRpm', el).addEventListener('change', (e) => { s.jogRpm = Math.max(0, Math.min(MACHINE.maxRpm, +e.target.value || 0)); this.app.save(); });
      $('#jdInc', el).addEventListener('change', (e) => this.ui.setInc(+e.target.value || null));
    }
    const mda = $('#mdaText', el);
    if (mda) {
      mda.value = this.ui.mdaText;
      mda.addEventListener('input', () => { this.ui.mdaText = mda.value; });
    }
    this.lastPos = {};
    this.updatePos(true);
  }

  modePanel() {
    const c = this.c;
    const s = this.app.settings;
    if (c.mode === 'MDA') return `<div class="hbox-h">MDA <span class="r">blocks run with CYCLE START</span></div><div class="hbox-b"><textarea class="mda-ta" id="mdaText" spellcheck="false" placeholder="G0 G90 G54 X0 Y0&#10;T2 M6&#10;S8000 M3"></textarea></div>`;
    if (c.mode === 'AUTO') return `<div class="hbox-h">Program <span class="r" id="autoName">${esc(this.app.programName || '—')}</span></div><div class="hbox-b blocks" id="autoBlocks"></div>`;
    if (c.mode === 'REF') return `<div class="hbox-h">Reference point</div><div class="hbox-b kvl"><span>Procedure</span><b>Press +Z, +X, +Y (or Ref. all)</b><span>Referenced</span><b id="refInfo"></b></div>`;
    return `<div class="hbox-h">JOG</div><div class="hbox-b kvl"><span>Increment</span><b id="jogInfo">${this.ui.inc ? `${this.ui.inc} mm per keypress` : 'continuous (hold the axis key)'}</b><span>JOG feed</span><b>${s.jogFeed} mm/min (RAPID: ${MACHINE.rapidXY} mm/min)</b><span>JOG spindle</span><b>${s.jogRpm} rpm (spindle keys)</b><span>Keyboard</span><b>arrows X/Y, PgUp/PgDn Z, Shift = rapid</b></div>`;
  }

  updatePos(force = false) {
    if (this.pages[this.area] !== 'pos' || this.area !== 'machine') return;
    const c = this.c, app = this.app, el = this.el.pos;
    const L = this.lastPos;
    const set = (id, v) => {
      if (!force && L[id] === v) return;
      L[id] = v;
      const e = el.querySelector('#' + id);
      if (e) e.textContent = v;
    };
    const inch = c.modal.units === 20;
    const k = inch ? 1 / 25.4 : 1, dp = inch ? 4 : 3;
    const p = this.cs === 'WCS' ? c.workPos({}) : { x: c.pos.x, y: c.pos.y, z: c.pos.z + (c.atc.lift || 0) };
    for (const a of ['x', 'y', 'z']) {
      set('pv' + a, (p[a] * k).toFixed(dp));
      set('pd' + a, (c.dtg[a] * k).toFixed(dp));
      set('rf' + a, c.ref[a] ? '●' : '○');
    }
    set('posUnit', inch ? 'inch' : 'mm');
    set('posWcs', this.cs === 'WCS' ? (c.modal.wcs === 500 ? 'G500' : `G${c.modal.wcs}`) : 'machine');
    const tool = app.tools.find((t) => t.number === c.tool);
    set('tfT', `${c.tool}  D${c.modal.tloH || 0}`);
    set('tfTn', tool ? `${typeCode(tool.type)} Ø${tool.diameter} L${tool.length}` : 'no tool');
    set('tfF', `${Math.round(c.speed * 60 * k)}`);
    set('tfFp', `F${Math.round(c.modal.feed * k)} ${inch ? 'in' : 'mm'}/min  ${c.overrides.feed}%`);
    set('tfS', `${Math.round(Math.abs(c.spindle.rpm))}`);
    set('tfSp', `S${c.spindle.cmd} ${c.spindle.dir > 0 ? 'M3' : c.spindle.dir < 0 ? 'M4' : 'M5'}  ${c.overrides.spindle}%`);
    const load = app.stats.load || 0;
    const lb = el.querySelector('#tfLoad');
    if (lb) {
      lb.style.width = Math.min(100, load) + '%';
      lb.style.background = load > 100 ? '#c21d1d' : load > 75 ? '#d99400' : '';
    }
    const vc = tool ? surfaceSpeed(tool.diameter, Math.abs(c.spindle.rpm)) : 0;
    const fz = tool && !c.rapidMove && c.speed > 0 ? chipLoad(c.speed * 60, Math.abs(c.spindle.rpm), tool.flutes) : 0;
    set('tfCut', `Load ${load.toFixed(0)}% · Vc ${vc.toFixed(0)} m/min · fz ${fz.toFixed(3)} · ${app.stats.temp.toFixed(1)} °C`);
    set('gLine', c.modal.codes);
    const flags = [['SBL', c.singleBlock], ['M01', c.optionalStop], ['SKP', app.settings.blockDelete], ['DRY', c.dryRun], ['ROV', c.rov], [c.coolant.flood ? 'M8' : 'M9', c.coolant.flood]];
    const fk = flags.map((f) => f[0] + f[1]).join();
    if (force || L.flags !== fk) {
      L.flags = fk;
      const fe = el.querySelector('#pcFlags');
      if (fe) fe.innerHTML = flags.map(([n, on]) => `<span class="flag ${on ? 'on' : ''}">${n}</span>`).join('');
    }
    if (c.mode === 'AUTO') {
      const key = `${c.line}|${app.programName}|${this.ui.editor.lines.length}`;
      if (force || L.blocks !== key) {
        L.blocks = key;
        const lines = this.ui.editor.lines;
        const cur = c.line >= 0 ? c.line : 0;
        const from = Math.max(0, cur - 2);
        const be = el.querySelector('#autoBlocks');
        if (be) be.innerHTML = lines.slice(from, from + 7).map((l, i) => `<div class="${from + i === c.line ? 'cur' : from + i < cur ? 'dim' : ''}">${String(from + i + 1).padStart(4)}  ${esc(l) || ' '}</div>`).join('');
      }
    }
    if (c.mode === 'REF') set('refInfo', ['x', 'y', 'z'].map((a) => `${a.toUpperCase()} ${c.ref[a] ? '●' : '○'}`).join('   '));
  }

  // ---- offset pages
  page_tools(el) {
    const app = this.app;
    const locked = !!this.c.exec;
    const rows = app.tools.map((t) => {
      const angle = ['drill', 'spot', 'chamfer'].includes(t.type);
      const rc = t.type === 'bull' || t.type === 'face';
      return `<tr data-t="${t.number}" class="${t.number === this.toolSel ? 'sel' : ''} ${t.number === this.c.tool ? 'act' : ''}">
        <td class="tn">${t.number}${t.number === this.c.tool ? ' ◀' : ''}</td>
        <td><select data-f="type">${SIE_TYPES.map(([code, k, n]) => `<option value="${k}" ${k === t.type ? 'selected' : ''}>${code} ${n}</option>`).join('')}</select></td>
        <td>1</td>
        <td><input data-f="length" type="number" step="0.001" value="${t.length}"></td>
        <td><input data-f="radius" type="number" step="0.001" value="${r3(t.diameter / 2)}"></td>
        <td><input data-f="fluteLength" type="number" step="0.5" value="${t.fluteLength}"></td>
        <td><input data-f="flutes" type="number" step="1" min="1" max="12" value="${t.flutes}" style="min-width:40px"></td>
        <td>${angle ? `<input data-f="tipAngle" type="number" step="1" value="${t.tipAngle || 118}">` : rc ? `<input data-f="cornerRadius" type="number" step="0.1" value="${t.cornerRadius || 0}">` : '—'}</td></tr>`;
    }).join('');
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Tool list <span class="r">${app.tools.length} tools · magazine 16 pockets · T = pocket</span></div>
      <div class="htable-wrap"><table class="htable ${locked ? 'locked' : ''}"><thead><tr><th>T</th><th>Type</th><th>D</th><th>Length</th><th>Radius</th><th>Flute L</th><th>Teeth</th><th>Angle / R</th></tr></thead><tbody>${rows}</tbody></table></div></div>
      <div class="hbox" id="toolDetail"></div></div>`;
    for (const tr of $$('tbody tr', el)) {
      const n = +tr.dataset.t;
      const t = app.tools.find((x) => x.number === n);
      tr.addEventListener('click', () => { this.toolSel = n; $$('tbody tr', el).forEach((r) => r.classList.toggle('sel', r === tr)); this.renderToolDetail(); this.renderSoftkeys(); });
      for (const inp of $$('[data-f]', tr)) inp.addEventListener('change', () => this.ui.editTool(t, inp.dataset.f, inp.value, inp));
    }
    if (!this.toolSel) this.toolSel = app.tools[0]?.number;
    this.renderToolDetail();
  }

  renderToolDetail() {
    const box = this.el.tools.querySelector('#toolDetail');
    const t = this.app.tools.find((x) => x.number === this.toolSel);
    if (!box) return;
    if (!t) { box.innerHTML = ''; return; }
    const h = holderFor(t);
    box.innerHTML = `<div class="hbox-h">T${t.number} · ${esc(t.name)}</div><div class="hbox-b kvl">
      <span>Siemens type</span><b>${typeCode(t.type)} ${typeName(t.type)}</b>
      <span>Holder</span><b>${esc(h.label)}, stick-out ${Math.max(0, t.length - h.length).toFixed(1)} mm</b>
      <span>Compensation</span><b>L ${r3(t.length + (t.dLength || 0))}  R ${r3(t.diameter / 2 + (t.dRadius || 0))} (geometry + wear)</b>
      <span>Suggested (${MATERIALS[this.app.stock.material].short})</span><b>${esc(this.ui.suggest(t))}</b></div>`;
  }

  page_wear(el) {
    const app = this.app;
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Tool wear <span class="r">ΔL / ΔR are added to the geometry for D1</span></div>
      <div class="htable-wrap"><table class="htable"><thead><tr><th>T</th><th>D</th><th>Δ Length</th><th>Δ Radius</th><th>Tool life used</th></tr></thead><tbody>
      ${app.tools.map((t) => `<tr data-t="${t.number}" class="${t.number === this.toolSel ? 'sel' : ''}"><td class="tn">${t.number}</td><td>1</td>
        <td><input data-f="dLength" type="number" step="0.001" value="${t.dLength || 0}"></td><td><input data-f="dRadius" type="number" step="0.001" value="${t.dRadius || 0}"></td>
        <td><span class="wearbar"><i style="width:${Math.min(100, t.wear || 0)}%;background-position:${-Math.min(100, t.wear || 0) * 0.7}px 0"></i></span><span data-wear>${(t.wear || 0).toFixed(1)}%</span></td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="hbox"><div class="hbox-b hnote">Life used is the simulator's wear estimate (volume cut × material abrasiveness × dry/speed factors). Enter ΔR = +0.05 to leave 0.05 mm more material with G41/G42 or cycles; ΔL shifts Z when D1 is active.</div></div></div>`;
    for (const tr of $$('tbody tr', el)) {
      const t = app.tools.find((x) => x.number === +tr.dataset.t);
      tr.addEventListener('click', () => { this.toolSel = t.number; $$('tbody tr', el).forEach((r) => r.classList.toggle('sel', r === tr)); });
      for (const inp of $$('[data-f]', tr)) inp.addEventListener('change', () => {
        const v = +inp.value;
        if (!isFinite(v) || Math.abs(v) > 5) { this.ui.log('Wear values must be between -5 and 5 mm', 'error'); inp.value = t[inp.dataset.f] || 0; return; }
        t[inp.dataset.f] = v;
        app.toolsChanged(false);
        this.ui.log(`T${t.number} D1 ${inp.dataset.f === 'dLength' ? 'ΔL' : 'ΔR'} = ${v}`);
      });
    }
  }

  page_wo(el) {
    const app = this.app;
    const act = this.c.modal.wcs;
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Work offsets <span class="r">machine coordinates of the part zero (Z: gauge line − tool length)</span></div>
      <div class="htable-wrap"><table class="htable"><thead><tr><th></th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>
      <tr><td class="tn">G500</td><td>0.000</td><td>0.000</td><td>0.000</td></tr>
      ${app.offsets.map((o, i) => `<tr class="${act === 54 + i ? 'act' : ''}"><td class="tn">G${54 + i}${act === 54 + i ? ' ◀' : ''}</td>${['x', 'y', 'z'].map((a) => `<td><input type="number" step="0.001" data-i="${i}" data-a="${a}" value="${o[a]}"></td>`).join('')}</tr>`).join('')}
      </tbody></table></div></div>
      <div class="hbox"><div class="hbox-b fgrid"><label>Zero point on the blank<select id="woPos">${[['top-center', 'Top centre'], ['top-front-left', 'Top front-left'], ['top-back-left', 'Top back-left'], ['top-front-right', 'Top front-right'], ['top-back-right', 'Top back-right']].map(([k, l]) => `<option value="${k}" ${k === this.ui.zeroPos ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>Write into<select id="woIdx">${[0, 1, 2, 3, 4, 5].map((i) => `<option value="${i}" ${i === this.ui.zeroIdx ? 'selected' : ''}>G${54 + i}</option>`).join('')}</select></label></div></div></div>`;
    $('#woPos', el).addEventListener('change', (e) => { this.ui.zeroPos = e.target.value; });
    $('#woIdx', el).addEventListener('change', (e) => { this.ui.zeroIdx = +e.target.value; });
    for (const inp of $$('input[data-i]', el)) inp.addEventListener('change', () => {
      if (this.c.exec) { this.ui.log('Stop the program before editing offsets', 'warn'); this.rerender(); return; }
      const v = +inp.value;
      if (!isFinite(v)) return;
      app.offsets[+inp.dataset.i][inp.dataset.a] = v;
      app.offsetsChanged();
      this.ui.log(`G${54 + +inp.dataset.i} ${inp.dataset.a.toUpperCase()} = ${v}`);
    });
  }

  page_rvar(el) {
    const R = this.app.R;
    const base = this.rPage * 100;
    const cells = [];
    for (let i = base; i < base + 100; i++) cells.push(`<tr><td class="tn">R${i}</td><td><input type="number" step="any" data-r="${i}" value="${r3(R[i])}"></td></tr>`);
    const cols = [0, 1, 2, 3].map((k) => `<div class="htable-wrap"><table class="htable"><tbody>${cells.slice(k * 25, k * 25 + 25).join('')}</tbody></table></div>`).join('');
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">R variables <span class="r">start values for programs; updated when a program or MDA block finishes</span></div>
      <div class="hbox-b" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px">${cols}</div></div></div>`;
    for (const inp of $$('input[data-r]', el)) inp.addEventListener('change', () => {
      const v = +inp.value;
      if (!isFinite(v)) return;
      this.app.R[+inp.dataset.r] = v;
      this.app.saveR();
      this.app.scheduleCompile();
    });
  }

  page_sd(el) {
    const s = this.app.settings;
    const w = s.wal;
    const t = MACHINE.travel;
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Setting data</div><div class="hbox-b fgrid">
      <label>JOG feed (mm/min)<input data-k="jogFeed" type="number" min="10" max="6000" value="${s.jogFeed}"></label>
      <label>JOG spindle speed (rpm)<input data-k="jogRpm" type="number" min="0" max="${MACHINE.maxRpm}" value="${s.jogRpm}"></label>
      <label>Dry run feed DRY (mm/min)<input data-k="dryFeed" type="number" min="10" max="${MACHINE.maxFeed}" value="${s.dryFeed}"></label>
      <label>Spindle speed limit (rpm)<input data-k="spLimit" type="number" min="100" max="${MACHINE.maxRpm}" value="${s.spLimit}"></label>
    </div></div>
    <div class="hbox"><div class="hbox-h">Working area limitation (machine coordinates)</div><div class="hbox-b fgrid">
      <label class="chk"><input type="checkbox" data-w="on" ${w.on ? 'checked' : ''}> Active</label>
      ${['x', 'y', 'z'].map((a) => `<label>${a.toUpperCase()} min (≥ ${t[a][0]})<input data-w="${a}0" type="number" step="1" value="${w[a][0]}"></label><label>${a.toUpperCase()} max (≤ ${t[a][1]})<input data-w="${a}1" type="number" step="1" value="${w[a][1]}"></label>`).join('')}
    </div><div class="hbox-b hnote">With the limitation active, programs are checked against these limits (alarm 10720-style over-travel) and jogging stops at them.</div></div></div>`;
    for (const inp of $$('input[data-k]', el)) inp.addEventListener('change', () => {
      const v = +inp.value;
      if (!isFinite(v)) return;
      s[inp.dataset.k] = v;
      this.app.applyControllerSettings();
      this.app.save();
    });
    for (const inp of $$('input[data-w]', el)) inp.addEventListener('change', () => {
      const k = inp.dataset.w;
      if (k === 'on') w.on = inp.checked;
      else {
        const a = k[0], i = +k[1];
        const v = Math.max(t[a][0], Math.min(t[a][1], +inp.value));
        w[a][i] = v;
        inp.value = v;
      }
      if (w.x[0] > w.x[1] || w.y[0] > w.y[1] || w.z[0] > w.z[1]) this.ui.log('Working area limit: min must be below max', 'error');
      this.app.applyControllerSettings();
      this.app.compile();
      this.app.save();
    });
  }

  page_blank(el) {
    const app = this.app;
    const st = app.stock;
    const z = app.zmap;
    const spec = MATERIALS[st.material];
    const mass = z ? (z.volume / 1000) * spec.density : 0;
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Blank (stock) in the vise</div><div class="hbox-b fgrid">
      <label>Material<select id="bkMat">${Object.entries(MATERIALS).map(([k, m]) => `<option value="${k}" ${k === st.material ? 'selected' : ''}>${m.name}</option>`).join('')}</select></label>
      <label>Length X (mm)<input id="bkX" type="number" min="10" max="300" value="${st.x}"></label>
      <label>Width Y (mm)<input id="bkY" type="number" min="10" max="${VISE.maxOpening}" value="${st.y}"></label>
      <label>Height Z (mm)<input id="bkZ" type="number" min="6" max="120" value="${st.z}"></label>
      <label>Above the jaws (mm)<input id="bkP" type="number" min="2" max="80" value="${st.protrusion}"></label>
    </div><div class="hbox-b hnote">"Load blank" puts a fresh blank of this size in the vise and sets the work offset chosen on the Work offset page (${this.ui.zeroPos.replace(/-/g, ' ')} → G${54 + this.ui.zeroIdx}).</div></div>
    <div class="hbox"><div class="hbox-h">Current blank</div><div class="hbox-b kvl">
      <span>Material</span><b>${esc(spec.name)}</b><span>Size</span><b>${st.x} × ${app.placement?.width ?? st.y} × ${st.z} mm, ${app.placement ? app.placement.protrusion.toFixed(1) : '-'} mm above the jaws</b>
      <span>Removed</span><b>${z ? (z.removedTotal / 1000).toFixed(2) : 0} cm³ (${z ? ((z.removedTotal / z.initialVolume) * 100).toFixed(2) : 0}%)</b><span>Part mass</span><b>${mass.toFixed(1)} g</b>
      <span>Z-map</span><b>${z ? `${z.nx} × ${z.ny} nodes, ${z.dx.toFixed(2)} mm grid (${ACCURACY[app.settings.accuracy].label})` : '-'}</b></div></div></div>`;
  }

  // ---- program pages
  page_prog() {
    this.ui.editor.schedule();
  }

  openForm(name, args = null, line = null, replace = false, modal = false) {
    this.form = { name, line: line ?? this.ui.editor.caretLine(), replace, modal };
    const { html } = buildForm(name, args);
    this.el.form.innerHTML = html;
    const upd = () => {
      const vals = readForm(this.el.form, name);
      $('#cfPreview', this.el.form).textContent = (modal ? 'MCALL ' : '') + formatCall(name, vals);
    };
    $$('input', this.el.form).forEach((i) => {
      i.addEventListener('input', upd);
      i.addEventListener('focus', () => {
        const prm = CYCLES[name].params[+i.dataset.i];
        $('#cfHelp', this.el.form).textContent = `${prm.k}: ${prm.label}${prm.unit ? ` [${prm.unit}]` : ''}${prm.hint ? `. ${prm.hint}` : ''}`;
      });
    });
    upd();
    this.pages.program = 'form';
    this.showPage('form');
    $('input', this.el.form)?.focus();
  }

  formOk() {
    const f = this.form;
    const vals = readForm(this.el.form, f.name);
    const call = (f.modal ? 'MCALL ' : '') + formatCall(f.name, vals);
    const ed = this.ui.editor;
    if (f.replace) {
      const text = ed.lineText(f.line);
      const hit = findCall(text);
      const start = f.modal ? text.search(/\bMCALL\b/i) : hit.start;
      ed.replaceLine(f.line, text.slice(0, start) + call + text.slice(hit.end));
      this.ui.log(`${f.name} updated in line ${f.line + 1}`);
    } else {
      ed.replaceLine(f.line, call, true);
      this.ui.log(`${f.name} inserted after line ${f.line + 1}`);
    }
    this.form = null;
    this.showPage('prog');
  }

  recompile() {
    const ed = this.ui.editor;
    const n = ed.caretLine();
    const hit = findCall(ed.lineText(n));
    if (!hit) {
      this.ui.log('Recompile: put the cursor on a line with a cycle call (CYCLE81, POCKET3, …)', 'warn');
      return;
    }
    this.openForm(hit.name, hit.args, n, true, hit.modal);
  }

  insertLine(text) {
    const ed = this.ui.editor;
    if (this.c.exec?.kind === 'program') return this.ui.log('The program is running: editing is locked', 'warn');
    ed.replaceLine(ed.caretLine(), text, true);
  }

  appendToLine(text) {
    const ed = this.ui.editor;
    const n = ed.caretLine();
    const l = ed.lineText(n);
    const ci = l.indexOf(';');
    ed.replaceLine(n, ci >= 0 ? l.slice(0, ci).trimEnd() + text + ' ' + l.slice(ci) : l + text);
  }

  findNext() {
    const q = $('#findInput').value.trim().toUpperCase();
    if (!q) return;
    const ed = this.ui.editor;
    const lines = ed.lines;
    const start = ed.caretLine() + 1;
    for (let k = 0; k < lines.length; k++) {
      const i = (start + k) % lines.length;
      if (lines[i].toUpperCase().includes(q)) return ed.gotoLine(i);
    }
    this.ui.log(`"${q}" not found`, 'warn');
  }

  renumber() {
    const ed = this.ui.editor;
    if (this.c.exec?.kind === 'program') return;
    let n = 10;
    const out = ed.getValue().split('\n').map((l) => {
      const m = /^(\s*)(N\d+\s*)?(.*)$/.exec(l);
      if (!m[3].trim() || /^[;%]/.test(m[3].trim()) || /^[A-Za-z_][A-Za-z0-9_]*:/.test(m[3].trim())) return l;
      const r = `${m[1]}N${n} ${m[3]}`;
      n += 10;
      return r;
    });
    ed.applyText(out.join('\n'), 0);
    this.ui.log('Program renumbered in steps of 10');
  }

  stripN() {
    const ed = this.ui.editor;
    ed.applyText(ed.getValue().split('\n').map((l) => l.replace(/^(\s*)N\d+\s*/, '$1')).join('\n'), 0);
  }

  toggleComment() {
    const ed = this.ui.editor;
    const n = ed.caretLine();
    const l = ed.lineText(n);
    ed.replaceLine(n, /^\s*;/.test(l) ? l.replace(/^(\s*);\s?/, '$1') : '; ' + l);
  }

  copyLine() {
    const ed = this.ui.editor;
    const n = ed.caretLine();
    ed.replaceLine(n, ed.lineText(n), true);
  }

  page_form() {}

  page_contour(el) {
    const tool = this.app.tools.find((t) => t.number === this.c.tool);
    el.innerHTML = renderContourDesigner(this.contour, tool ? tool.diameter / 2 : 0);
    const cd = this.contour;
    for (const tr of $$('tbody tr', el)) {
      const i = +tr.dataset.i;
      for (const inp of $$('[data-k]', tr)) inp.addEventListener('change', () => {
        const k = inp.dataset.k;
        cd.els[i][k] = k === 't' ? inp.value : inp.value === '' ? '' : +inp.value;
        if (k === 't' && inp.value !== 'L' && !(cd.els[i].r > 0)) cd.els[i].r = 20;
        this.renderPage('contour');
      });
    }
    for (const inp of $$('[data-o]', el)) inp.addEventListener('change', () => {
      const k = inp.dataset.o;
      if (k === 'name') cd.name = inp.value;
      else if (k === 'sx') cd.start.x = +inp.value;
      else if (k === 'sy') cd.start.y = +inp.value;
      else if (k === 'depth') cd.depth = +inp.value;
      else if (k === 'side') cd.side = +inp.value;
      this.renderPage('contour');
    });
  }

  contourAdd(t) {
    const cd = this.contour;
    const last = cd.els[cd.els.length - 1] || cd.start;
    cd.els.push(t === 'L' ? { t, x: +last.x + 10, y: +last.y } : { t, x: +last.x + 10, y: +last.y + 10, r: 10 });
    this.renderPage('contour');
  }

  contourInsert(mode) {
    const ed = this.ui.editor;
    const cd = this.contour;
    if (mode === 'cycle') {
      const { def, call } = contourCycleCode(cd);
      ed.replaceLine(ed.caretLine(), call, true);
      const text = ed.getValue().replace(/\s+$/, '');
      ed.applyText(text + '\n' + def.join('\n') + '\n', ed.caretLine());
      this.ui.log('Contour appended at the end of the program and CYCLE72 inserted at the cursor. The labels must stay after M30.');
    } else {
      ed.replaceLine(ed.caretLine(), contourPathCode(cd).join('\n'), true);
      this.ui.log(`Contour path with G${cd.side} inserted at the cursor`);
    }
    this.showPage('prog');
  }

  // ---- program manager
  page_pm(el) {
    const app = this.app;
    const store = app.programs;
    let rows;
    if (this.pmFolder === 'nc') {
      const names = store.names();
      rows = names.map((n) => {
        const inf = store.info(n);
        return `<tr data-n="${esc(n)}" class="${n === this.pmSel ? 'sel' : ''}"><td class="nm">${esc(n)}${n === app.programName ? '<span class="tag">SELECTED</span>' : ''}</td><td>${(inf.text.length / 1024).toFixed(1)} kB</td><td>${new Date(inf.modified).toLocaleString()}</td></tr>`;
      }).join('') || '<tr><td colspan="3">NC memory is empty. Copy an example or press New.</td></tr>';
    } else {
      rows = EXAMPLES_808.map((e) => `<tr data-n="${esc(e.id)}" class="${e.id === this.pmSel ? 'sel' : ''}"><td class="nm">${esc(e.file)}</td><td>${esc(e.name)}</td><td style="white-space:normal;font-family:var(--f-ui)">${esc(e.desc)}</td></tr>`).join('');
    }
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">${this.pmFolder === 'nc' ? 'NC memory (part programs)' : 'Examples (read only)'}<span class="r">${this.pmFolder === 'nc' ? 'Execute selects for AUTO · Open edits' : 'Execute loads the blank and selects for AUTO'}</span></div>
      <div class="htable-wrap"><table class="htable pm-list"><thead><tr><th>Name</th><th>${this.pmFolder === 'nc' ? 'Size' : 'Title'}</th><th>${this.pmFolder === 'nc' ? 'Modified' : 'Description'}</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>`;
    for (const tr of $$('tbody tr[data-n]', el)) {
      tr.addEventListener('click', () => { this.pmSel = tr.dataset.n; $$('tbody tr', el).forEach((r) => r.classList.toggle('sel', r === tr)); this.renderSoftkeys(); });
      tr.addEventListener('dblclick', () => (this.pmFolder === 'nc' ? this.ui.pmOpen('nc', tr.dataset.n) : this.ui.pmExecute('ex', tr.dataset.n)));
    }
  }

  // ---- system pages
  addAlarm(text) {
    const m = /^(\d{4,5})\s+(.*)$/.exec(text);
    for (const a of this.alarms) a.active = false;
    this.alarms.unshift({ time: new Date(), code: m ? m[1] : 'SIM', text: m ? m[2] : text, active: true });
    this.alarms = this.alarms.slice(0, 50);
    const b = $('#alarmBadge');
    b.hidden = false;
    b.textContent = '1';
    $('#alarmLine').textContent = `${m ? m[1] + ' ' : ''}${m ? m[2] : text}`;
    if (this.area === 'system') this.rerender();
  }

  clearAlarms() {
    for (const a of this.alarms) a.active = false;
    $('#alarmBadge').hidden = true;
    $('#alarmLine').textContent = '';
    if (this.area === 'system' && this.pages.system === 'alarms') this.rerender();
  }

  page_alarms(el) {
    const list = this.alarms.map((a) => `<div class="al-row ${a.active ? '' : 'cleared'}"><b>${esc(a.code)}</b><time>${a.time.toTimeString().slice(0, 8)}</time><span>${esc(a.text)}${a.active ? '' : ' (cleared)'}</span></div>`).join('');
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Alarm list <span class="r">RESET acknowledges</span></div><div class="hbox-b alist" style="padding:0">${list || '<div class="al-row"><span></span><span></span><span>No alarms</span></div>'}</div></div>
      <div class="hbox"><div class="hbox-b hnote">Numbered alarms follow the control's numbering where an equivalent exists (e.g. 14040 circle end point, 14080 jump destination, 61101 reference plane, 61102 no spindle direction, 10720-style over-travel). "SIM" alarms are the simulator's collision checks.</div></div></div>`;
  }

  page_msgs(el) {
    const items = this.ui.logItems.slice(-300);
    el.innerHTML = `<div class="hp"><div class="hbox" style="flex:1"><div class="hbox-h">Messages <span class="r">${items.length}</span></div><ol class="hlog">${items.map((it) => `<li class="${it.level}"><time>${it.time}</time><span>${it.html}</span></li>`).join('')}</ol></div></div>`;
    $$('a[data-line]', el).forEach((a) => a.addEventListener('click', () => { this.showArea('program'); this.ui.editor.gotoLine(+a.dataset.line - 1); }));
    el.scrollTop = 1e9;
    this.main.scrollTop = 1e9;
  }

  page_settings(el) {
    const s = this.app.settings;
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Control</div><div class="hbox-b fgrid">
      <label>Default program dialect<select data-s="dialect"><option value="siemens" ${s.dialect === 'siemens' ? 'selected' : ''}>Siemens mode (G290)</option><option value="iso" ${s.dialect === 'iso' ? 'selected' : ''}>ISO dialect (G291)</option></select></label>
      <label class="chk"><input type="checkbox" data-c="requireG43" ${s.requireG43 ? 'checked' : ''}> ISO: require G43 H_ for tool length</label>
      <label class="chk"><input type="checkbox" data-c="doorInterlock" ${s.doorInterlock ? 'checked' : ''}> Door interlock</label>
      <label class="chk"><input type="checkbox" data-c="freshBlank" ${s.freshBlank ? 'checked' : ''}> Fresh blank at each AUTO start</label>
    </div></div>
    <div class="hbox"><div class="hbox-h">Simulation accuracy</div><div class="hbox-b fgrid">
      <label>Z-map / arc tolerance<select data-s="accuracy">${Object.entries(ACCURACY).map(([k, a]) => `<option value="${k}" ${k === s.accuracy ? 'selected' : ''}>${a.label} · grid ${a.cell} mm · arcs ${a.arcTol} mm</option>`).join('')}</select></label>
    </div></div>
    <div class="hbox"><div class="hbox-h">Visual and sound</div><div class="hbox-b fgrid">
      <label class="chk"><input type="checkbox" data-c="showChips" ${s.showChips ? 'checked' : ''}> Chips</label>
      <label class="chk"><input type="checkbox" data-c="showCoolant" ${s.showCoolant ? 'checked' : ''}> Coolant spray</label>
      <label>Volume<input type="range" min="0" max="1" step="0.05" data-s="volume" value="${s.volume}"></label>
    </div></div></div>`;
    for (const inp of $$('[data-c]', el)) inp.addEventListener('change', () => this.ui.setOption(inp.dataset.c, inp.checked));
    for (const inp of $$('[data-s]', el)) inp.addEventListener(inp.type === 'range' ? 'input' : 'change', () => this.ui.setOption(inp.dataset.s, inp.type === 'range' ? +inp.value : inp.value));
  }

  page_service(el) {
    const app = this.app, c = this.c, st = app.stats, z = app.zmap;
    const r = app.viewer.renderer.info;
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Service display</div><div class="hbox-b kvl">
      <span>Spindle</span><b>${Math.round(c.spindle.rpm)} rpm, load ${st.load.toFixed(1)}%, temperature ${st.temp.toFixed(1)} °C</b>
      <span>Material removal</span><b>${(st.mrr * 0.06).toFixed(2)} cm³/min now, ${z ? (z.removedTotal / 1000).toFixed(2) : 0} cm³ total</b>
      <span>Axes</span><b>X ${c.pos.x.toFixed(3)} Y ${c.pos.y.toFixed(3)} Z ${c.pos.z.toFixed(3)} (machine)</b>
      <span>Referenced</span><b>X ${c.ref.x ? 'yes' : 'no'}, Y ${c.ref.y ? 'yes' : 'no'}, Z ${c.ref.z ? 'yes' : 'no'}</b>
      <span>Tool changer</span><b>pocket ${c.carousel} at the spindle, tool T${c.tool} in the spindle</b>
      <span>Program</span><b>${esc(app.programName)}: ${app.compiled ? `${app.compiled.lineCount} lines, ${app.compiled.ops.length} ops, compiled in ${app.compiled.compileMs?.toFixed(0)} ms (${app.compiled.dialect})` : '-'}</b>
      <span>Z-map</span><b>${z ? `${z.nx} × ${z.ny} = ${(z.nx * z.ny / 1000).toFixed(0)}k nodes` : '-'}</b>
      <span>Rendering</span><b>${esc($('#fps').textContent)} · ${r.memory.geometries} geometries · ${r.memory.textures} textures</b>
      <span>Tool life</span><b>${app.tools.map((t) => `T${t.number} ${(t.wear || 0).toFixed(1)}%`).join('  ')}</b></div></div></div>`;
  }

  page_ref(el) {
    const sg = Object.keys(SIE_G).map(Number).sort((a, b) => a - b).map((k) => `<tr><td>G${k}</td><td><span>${esc(SIE_G[k][1])}</span></td></tr>`).join('');
    const sm = Object.keys(SIE_M).map(Number).sort((a, b) => a - b).map((k) => `<tr><td>M${k}</td><td><span>${esc(SIE_M[k])}</span></td></tr>`).join('');
    const sw = Object.entries(SIE_WORDS).map(([k, v]) => `<tr><td>${esc(k)}</td><td><span>${esc(v)}</span></td></tr>`).join('');
    const cy = Object.entries(CYCLES).map(([k, v]) => `<tr><td>${k}</td><td><b>${esc(v.title)}</b> <span>(${v.params.map((p) => p.k).join(', ')})<br>${esc(v.desc)}</span></td></tr>`).join('');
    const ig = Object.keys(G_CODES).map(Number).sort((a, b) => a - b).map((k) => `<tr><td>${gName(k)}</td><td><b>${esc(G_CODES[k].name)}</b> <span>${esc(G_CODES[k].desc)}</span></td></tr>`).join('');
    const im = Object.keys(M_CODES).map(Number).sort((a, b) => a - b).map((k) => `<tr><td>${mName(k)}</td><td><b>${esc(M_CODES[k].name)}</b> <span>${esc(M_CODES[k].desc)}</span></td></tr>`).join('');
    const un = [...Object.entries(UNSUPPORTED_G).map(([k, v]) => [gName(+k), v]), ...Object.entries(UNSUPPORTED_M).map(([k, v]) => [mName(+k), v])].map(([k, v]) => `<tr><td>${k}</td><td><span>${esc(v)}</span></td></tr>`).join('');
    el.innerHTML = `<div class="hp ref"><p>Generated from the interpreters' own tables. Programs run in Siemens mode unless their first command is G291 (ISO dialect).</p>
      <h3>Siemens mode: G functions</h3><table>${sg}</table><h3>Siemens mode: M functions</h3><table>${sm}</table>
      <h3>Siemens mode: addresses and language</h3><table>${sw}<tr><td>Functions</td><td><span>${EXPR_FUNCTIONS.join(' ')}</span></td></tr></table>
      <h3>Cycles</h3><table>${cy}</table>
      <h3>ISO dialect (G291): G codes</h3><table>${ig}</table><h3>ISO dialect: M codes</h3><table>${im}</table>
      <h3>ISO dialect: words</h3><table>${Object.entries(WORDS).map(([k, v]) => `<tr><td>${k}</td><td><span>${esc(v)}</span></td></tr>`).join('')}</table>
      <h3>Not supported (rejected with an alarm)</h3><table class="no">${un}<tr><td>SCALE/MIRROR</td><td><span>Scaling and mirroring frames</span></td></tr><tr><td>L..., RET</td><td><span>Subprogram calls; use labels and jumps</span></td></tr><tr><td>G110–G112</td><td><span>Polar coordinates</span></td></tr><tr><td>CIP, AR=</td><td><span>Circle via intermediate point, opening angle</span></td></tr><tr><td>G96, DIAMON</td><td><span>Turning functions</span></td></tr></table></div>`;
  }

  page_version(el) {
    el.innerHTML = `<div class="hp"><div class="hbox"><div class="hbox-h">Version</div><div class="hbox-b kvl">
      <span>Simulator</span><b>MillLab VMC-560 with an 808D-style control</b><span>Machine</span><b>3-axis VMC, X 560 / Y 410 / Z 410 mm, 12 000 rpm, 16-pocket umbrella changer</b>
      <span>Languages</span><b>Siemens mode (G290) and ISO dialect (G291)</b><span>Material removal</span><b>Z-map (dexel heightfield), exact for 3-axis vertical cutters</b>
      <span>Rendering</span><b>Three.js 0.160 (WebGL 2)</b></div>
      <div class="hbox-b hnote">MillLab is an independent training simulator. Its operating concept follows the SINUMERIK 808D (operating areas, softkeys, cycles and Siemens-mode programming) for learning purposes; it is not Siemens software and is not affiliated with or endorsed by Siemens AG. SINUMERIK is a trademark of Siemens AG. Cycle parameters follow the documented standard-cycle signatures as closely as possible; check the official manuals before running programs on a real machine.</div></div></div>`;
  }
}
