// Main menu shown at start-up: pick the machine to work on. Each entry sets the machine/control
// combination; more machines (e.g. manual lathes) can be added to MACHINES later.
const MACHINES = [
  {
    id: 'haas', control: 'haas', title: 'Mini Mill · NGC-style control',
    sub: 'Compact VMC with the NGC-style pendant: VPS templates, Haas G-code, PART ZERO SET.',
    tag: 'Recommended',
  },
  {
    id: 'original', control: '808d', title: 'VMC · 808D-style control',
    sub: 'The original setup with the SINUMERIK 808D-style panel, programGUIDE cycle forms and Siemens G-code.',
  },
  { id: 'lathe', title: 'Manual lathe', sub: 'Coming later.', disabled: true },
];

const css = `
.mm-root{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at 50% 30%,rgba(28,34,42,.92),rgba(10,12,15,.97));font-family:inherit;color:#e8edf2}
.mm-box{width:min(920px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:28px}
.mm-box h1{margin:0 0 4px;font-size:30px;letter-spacing:.5px}
.mm-box p.lead{margin:0 0 22px;color:#9aa6b2}
.mm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px}
.mm-card{position:relative;text-align:left;cursor:pointer;border:1px solid #2c3540;border-radius:12px;padding:18px 18px 16px;
  background:linear-gradient(180deg,#1b2129,#151a20);color:inherit;font:inherit;transition:border-color .15s,transform .15s}
.mm-card:hover:not([disabled]){border-color:#2f7de1;transform:translateY(-2px)}
.mm-card[disabled]{opacity:.45;cursor:not-allowed}
.mm-card b{display:block;font-size:17px;margin-bottom:6px}
.mm-card span{display:block;font-size:13px;line-height:1.45;color:#9aa6b2}
.mm-card em{position:absolute;top:12px;right:12px;font-style:normal;font-size:11px;padding:2px 8px;border-radius:10px;background:#2f7de1;color:#fff}
.mm-card.cur{border-color:#e8b21a}
.mm-foot{margin-top:18px;font-size:12px;color:#6f7c88}
`;

function show(app) {
  if (!document.getElementById('mm-style')) {
    const s = document.createElement('style');
    s.id = 'mm-style';
    s.textContent = css;
    document.head.appendChild(s);
  }
  let cur = 'haas';
  try { cur = (app?.settings?.control || JSON.parse(localStorage.getItem('milllab.v1') || '{}').settings?.control) === '808d' ? 'original' : 'haas'; } catch { /* default */ }
  const root = document.createElement('div');
  root.className = 'mm-root';
  root.innerHTML = `<div class="mm-box"><h1>MillLab</h1><p class="lead">Choose the machine you want to work on.</p>
    <div class="mm-grid">${MACHINES.map((m) => `<button class="mm-card${m.id === cur ? ' cur' : ''}" data-id="${m.id}" ${m.disabled ? 'disabled' : ''}>
      ${m.tag ? `<em>${m.tag}</em>` : ''}<b>${m.title}</b><span>${m.sub}</span></button>`).join('')}</div>
    <div class="mm-foot">You can switch machine later from the ☰ Machines button in the top bar.</div></div>`;
  root.addEventListener('click', (e) => {
    const b = e.target.closest('.mm-card');
    if (!b || b.disabled) return;
    const m = MACHINES.find((x) => x.id === b.dataset.id);
    root.remove();
    // the app may still be loading: apply the choice as soon as it is ready
    const apply = () => {
      const a = window.__app;
      if (!a?.haas || !a.settings) return setTimeout(apply, 200);
      if (m.control && a.settings.control !== m.control) a.haas.setControl(m.control);
    };
    apply();
  });
  document.body.appendChild(root);
}

function startMenu(app) {
  // top-bar button to come back to the menu
  const bar = document.querySelector('.top-actions');
  if (bar) {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.title = 'Choose the machine';
    b.innerHTML = '<span>☰ Machines</span>';
    b.addEventListener('click', () => show(app));
    bar.prepend(b);
  }
  window.__mainMenu = { show: () => show(app) };
}

// shown straight away on every normal start (before the 3D scene has loaded); skipped for automated
// runs (?capture) or ?nomenu
const q = new URLSearchParams(location.search);
if (!q.has('capture') && !q.has('nomenu')) show(null);
const wait = () => (window.__app?.haas && window.__app.settings ? startMenu(window.__app) : setTimeout(wait, 200));
wait();
