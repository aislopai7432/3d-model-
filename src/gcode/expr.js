// SINUMERIK arithmetic expressions: R parameters, + - * / DIV MOD, comparisons (== <> < > <= >=),
// AND OR XOR NOT, parentheses and the standard functions. Angles are in degrees, as on the control.

export class ExprError extends Error {}

const FUNCS = {
  SIN: [1, (a) => Math.sin((a * Math.PI) / 180)],
  COS: [1, (a) => Math.cos((a * Math.PI) / 180)],
  TAN: [1, (a) => Math.tan((a * Math.PI) / 180)],
  ASIN: [1, (a) => (Math.asin(a) * 180) / Math.PI],
  ACOS: [1, (a) => (Math.acos(a) * 180) / Math.PI],
  ATAN2: [2, (a, b) => (Math.atan2(a, b) * 180) / Math.PI],
  SQRT: [1, (a) => {
    if (a < 0) throw new ExprError('SQRT of a negative number');
    return Math.sqrt(a);
  }],
  ABS: [1, Math.abs],
  POT: [1, (a) => a * a],
  TRUNC: [1, Math.trunc],
  ROUND: [1, (a) => Math.sign(a) * Math.round(Math.abs(a))],
  ROUNDUP: [1, Math.ceil],
  EXP: [1, Math.exp],
  LN: [1, (a) => {
    if (a <= 0) throw new ExprError('LN of a value <= 0');
    return Math.log(a);
  }],
  MINVAL: [2, Math.min],
  MAXVAL: [2, Math.max],
};
const WORD_OPS = new Set(['AND', 'OR', 'XOR', 'NOT', 'DIV', 'MOD', 'B_AND', 'B_OR']);
export const EXPR_FUNCTIONS = Object.keys(FUNCS);

export function tokenize(src) {
  const t = [];
  let i = 0;
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(EX[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) throw new ExprError(`Bad number near "${s.slice(i, i + 6)}"`);
      let v = parseFloat(m[1]);
      if (m[2]) v *= Math.pow(10, parseInt(m[2].slice(2), 10));
      t.push({ k: 'num', v });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_]*/.exec(s.slice(i));
      const w = m[0].toUpperCase();
      t.push(WORD_OPS.has(w) ? { k: 'op', v: w } : { k: 'id', v: w });
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['==', '<>', '<=', '>='].includes(two)) { t.push({ k: 'op', v: two }); i += 2; continue; }
    if ('+-*/<>(),'.includes(c)) { t.push({ k: c === '(' || c === ')' || c === ',' ? c : 'op', v: c }); i++; continue; }
    throw new ExprError(`Unexpected "${c}" in expression`);
  }
  return t;
}

// ctx: { R: Float64Array, lookup?(name) -> number|undefined }
export function evaluate(src, ctx) {
  const toks = tokenize(String(src));
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].k === 'op' && toks[p].v === v;
  const expect = (k) => {
    if (!toks[p] || toks[p].k !== k) throw new ExprError(`Expected "${k}" in "${src}"`);
    p++;
  };
  const primary = () => {
    const tk = toks[p];
    if (!tk) throw new ExprError(`Incomplete expression "${src}"`);
    if (tk.k === 'num') { p++; return tk.v; }
    if (tk.k === '(') {
      p++;
      const v = orExpr();
      expect(')');
      return v;
    }
    if (tk.k === 'op' && (tk.v === '-' || tk.v === '+')) {
      p++;
      const v = unary();
      return tk.v === '-' ? -v : v;
    }
    if (tk.k === 'id') {
      p++;
      const m = /^R(\d+)$/.exec(tk.v);
      if (m) {
        const n = +m[1];
        if (n > 299) throw new ExprError(`R${n} does not exist (R0..R299)`);
        return ctx.R[n];
      }
      if (FUNCS[tk.v]) {
        const [n, fn] = FUNCS[tk.v];
        expect('(');
        const args = [orExpr()];
        while (peek() && peek().k === ',') { p++; args.push(orExpr()); }
        expect(')');
        if (args.length !== n) throw new ExprError(`${tk.v} needs ${n} argument${n > 1 ? 's' : ''}`);
        return fn(...args);
      }
      if (tk.v === 'TRUE') return 1;
      if (tk.v === 'FALSE') return 0;
      if (tk.v === 'PI' || tk.v === '$PI') return Math.PI;
      const v = ctx.lookup ? ctx.lookup(tk.v) : undefined;
      if (v !== undefined) return v;
      throw new ExprError(`Name "${tk.v}" not defined`);
    }
    throw new ExprError(`Unexpected "${tk.v}" in "${src}"`);
  };
  const unary = () => {
    if (isOp('NOT')) { p++; return unary() ? 0 : 1; }
    return primary();
  };
  const mul = () => {
    let v = unary();
    for (;;) {
      if (isOp('*')) { p++; v *= unary(); }
      else if (isOp('/')) {
        p++;
        const d = unary();
        if (d === 0) throw new ExprError('Division by zero');
        v /= d;
      } else if (isOp('DIV')) { p++; v = Math.trunc(v / unary()); }
      else if (isOp('MOD')) { p++; v %= unary(); }
      else return v;
    }
  };
  const add = () => {
    let v = mul();
    for (;;) {
      if (isOp('+')) { p++; v += mul(); }
      else if (isOp('-')) { p++; v -= mul(); }
      else return v;
    }
  };
  const cmp = () => {
    const a = add();
    const ops = { '==': (x, y) => Math.abs(x - y) < 1e-9, '<>': (x, y) => Math.abs(x - y) >= 1e-9, '<': (x, y) => x < y, '>': (x, y) => x > y, '<=': (x, y) => x <= y + 1e-12, '>=': (x, y) => x >= y - 1e-12 };
    const tk = peek();
    if (tk && tk.k === 'op' && ops[tk.v]) {
      p++;
      return ops[tk.v](a, add()) ? 1 : 0;
    }
    return a;
  };
  const andExpr = () => {
    let v = cmp();
    while (isOp('AND')) { p++; const b = cmp(); v = v && b ? 1 : 0; }
    return v;
  };
  const xorExpr = () => {
    let v = andExpr();
    while (isOp('XOR')) { p++; const b = andExpr(); v = !!v !== !!b ? 1 : 0; }
    return v;
  };
  const orExpr = () => {
    let v = xorExpr();
    while (isOp('OR')) { p++; const b = xorExpr(); v = v || b ? 1 : 0; }
    return v;
  };
  const v = orExpr();
  if (p < toks.length) throw new ExprError(`Unexpected "${toks[p].v}" in "${src}"`);
  if (!isFinite(v)) throw new ExprError(`Expression "${src}" is not a finite number`);
  return v;
}
