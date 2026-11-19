// Marquee: single-line labels that are clipped (ellipsis / overflow hidden + nowrap) slowly scroll
// sideways so the whole text can be read. Self-contained: finds candidates itself, re-checks on
// resize / DOM changes (throttled), animates an inner span with a CSS transform via the Web Animations
// API, pauses on hover, honours prefers-reduced-motion and never touches inputs or editors.
const SPEED = 35; // px / second
const PAUSE = 1400; // ms rest at both ends
const SELECTORS = [
  '.marquee', '#progName', '.hud-line', '.hd-prog', '.hmi-msg .al', '.hmi-msg .ms', '.job-chip .jt', '.g-obj-h b',
  '.g-carry', '.g-dp-h b', '.g-modal .modal-h b', '.g-modal .modal-h .g-sub', '.t-ph', '.toast', '.ht td',
  '.hs-ptitle span', '.hs-sys', '.lp-search', '.ed-clip', '.ms-top span', '.ms-tool span', '.softkeys button', '.softkey',
].join(',');
const SKIP = 'input,textarea,select,canvas,[contenteditable],.ed-main,.ed-gutter,.ed-ta,.ed-hl,.pl,.el,.marquee-off';
const INLINE = /^(SPAN|B|I|EM|STRONG|CODE|SMALL|U|KBD|A|MARK)$/;

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const wrapped = new Map(); // element -> { span, anim }
let observer = null;
const dirty = new Set();
let full = true, timer = 0;

function injectCss() {
  const st = document.createElement('style');
  st.textContent = '.mq-inner{display:inline-block;white-space:inherit;will-change:transform;vertical-align:top;max-width:none}.mq-on{text-overflow:clip!important}';
  document.head.appendChild(st);
}

function simpleContent(el) {
  // only text, or inline formatting wrappers around text: anything richer is left alone
  for (const n of el.childNodes) {
    if (n.nodeType === 3) continue;
    if (n.nodeType !== 1 || !INLINE.test(n.tagName) || n.childElementCount) return false;
  }
  return true;
}

function clipsText(el) {
  const cs = getComputedStyle(el);
  if (cs.overflowX === 'visible') return false;
  if (!/^(nowrap|pre)$/.test(cs.whiteSpace)) return false;
  if (/(flex|grid)/.test(cs.display) && el.childElementCount) return false;
  return true;
}

function unwrap(el) {
  const w = wrapped.get(el);
  if (!w) return;
  w.anim?.cancel();
  if (w.span.parentNode === el) {
    while (w.span.firstChild) el.insertBefore(w.span.firstChild, w.span);
    w.span.remove();
  }
  el.classList.remove('mq-on');
  el.removeEventListener('mouseenter', w.enter);
  el.removeEventListener('mouseleave', w.leave);
  wrapped.delete(el);
}

function wrap(el) {
  const span = document.createElement('span');
  span.className = 'mq-inner';
  while (el.firstChild) span.appendChild(el.firstChild);
  el.appendChild(span);
  const w = { span, anim: null };
  w.enter = () => w.anim?.pause();
  w.leave = () => w.anim?.play();
  el.addEventListener('mouseenter', w.enter);
  el.addEventListener('mouseleave', w.leave);
  wrapped.set(el, w);
  return w;
}

function contentWidth(el) {
  const cs = getComputedStyle(el);
  return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

function check(el) {
  if (!el.isConnected || el.closest(SKIP) || reduce.matches) return void unwrap(el);
  let w = wrapped.get(el);
  if (w && w.span.parentNode !== el) { unwrap(el); w = null; } // the app replaced the content
  if (!w) {
    if (!el.textContent.trim() || el.scrollWidth <= el.clientWidth + 1) return;
    if (!simpleContent(el) || !clipsText(el)) return;
    w = wrap(el);
  } else if (el.childNodes.length > 1) {
    unwrap(el); // content was appended next to our wrapper: start over
    return check(el);
  }
  const room = contentWidth(el);
  const dist = Math.ceil(w.span.offsetWidth - room);
  const key = dist + ':' + w.span.textContent;
  if (dist <= 1) return void unwrap(el);
  if (w.key === key && w.anim) return;
  w.key = key;
  w.anim?.cancel();
  el.classList.add('mq-on');
  const run = (dist / SPEED) * 1000;
  const total = run * 2 + PAUSE * 2;
  w.anim = w.span.animate(
    [
      { transform: 'translateX(0)', offset: 0 },
      { transform: 'translateX(0)', offset: PAUSE / total },
      { transform: `translateX(${-dist}px)`, offset: (PAUSE + run) / total },
      { transform: `translateX(${-dist}px)`, offset: (PAUSE * 2 + run) / total },
      { transform: 'translateX(0)', offset: 1 },
    ],
    { duration: total, iterations: Infinity, easing: 'linear' }
  );
  if (el.matches(':hover')) w.anim.pause();
}

function scan() {
  timer = 0;
  if (observer) observer.takeRecords();
  const roots = full ? [document.body] : [...dirty];
  const doFull = full;
  dirty.clear();
  full = false;
  const seen = new Set();
  const consider = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    check(el);
  };
  for (const r of roots) {
    if (!r.isConnected) continue;
    for (const el of [r, ...r.querySelectorAll('*')]) {
      if (el.nodeType !== 1 || el.classList.contains('mq-inner')) continue;
      if (wrapped.has(el) || el.matches(SELECTORS)) consider(el);
      else if (!el.childElementCount && el.textContent.length > 6 && el.scrollWidth > el.clientWidth + 1) consider(el);
    }
  }
  if (doFull) for (const el of [...wrapped.keys()]) if (!seen.has(el)) check(el);
  if (observer) observer.takeRecords();
}

function schedule(root) {
  if (root) {
    const el = root.nodeType === 1 ? root : root.parentElement;
    if (el && !el.closest?.('.mq-inner')) dirty.add(el.closest('.mq-inner')?.parentElement || el);
  } else full = true;
  if (!timer) timer = setTimeout(scan, 350);
}

function start() {
  injectCss();
  observer = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.target.classList?.contains('mq-inner') || r.target.parentElement?.classList?.contains('mq-inner')) {
        // our own wrapper changed content (text updated inside it)
        const host = r.target.closest('.mq-inner')?.parentElement;
        if (host) dirty.add(host);
        continue;
      }
      if (r.type === 'attributes' && r.attributeName === 'class' && r.target.classList.contains('mq-on')) continue;
      schedule(r.target);
    }
    if (dirty.size && !timer) timer = setTimeout(scan, 350);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  addEventListener('resize', () => schedule());
  reduce.addEventListener?.('change', () => { for (const el of [...wrapped.keys()]) unwrap(el); schedule(); });
  setTimeout(() => schedule(), 800);
  window.__marquee = { rescan: () => { full = true; scan(); }, get active() { return wrapped.size; } };
}

if (document.body) start();
else addEventListener('DOMContentLoaded', start);
