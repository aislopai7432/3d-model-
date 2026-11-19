// Cutter geometry used by material removal and collision checks. Pure data, no rendering.
//
// profile(d) = height of the cutter's lower envelope above the tip at radial distance d. It is
// precomputed into a lookup table indexed by d^2 so the inner removal loop needs no sqrt.

import { HOLDERS } from '../config.js';

const PN = 1024;

export function holderFor(tool) {
  return tool.type === 'face' ? HOLDERS.shell : HOLDERS.er32;
}

export function profileHeight(tool, d) {
  const r = tool.diameter / 2;
  switch (tool.type) {
    case 'ball': return r - Math.sqrt(Math.max(0, r * r - d * d));
    case 'bull':
    case 'face': {
      const rc = Math.min(tool.cornerRadius || 0, r);
      if (d <= r - rc) return 0;
      const e = d - (r - rc);
      return rc - Math.sqrt(Math.max(0, rc * rc - e * e));
    }
    case 'drill':
    case 'spot':
    case 'chamfer': {
      const half = ((tool.tipAngle || 118) * Math.PI) / 360;
      return d / Math.tan(half);
    }
    default: return 0;
  }
}

// Builds the cutter description consumed by ZMap.sweep and the collision checks.
export function makeCutter(tool) {
  const r = tool.diameter / 2;
  const prof = new Float32Array(PN + 1);
  for (let k = 0; k <= PN; k++) prof[k] = profileHeight(tool, Math.sqrt(k / PN) * r);
  const holder = holderFor(tool);
  const stickout = Math.max(tool.fluteLength + 1, tool.length - holder.length);
  // Face mills have a body slightly smaller than the insert circle above the inserts.
  const bodyR = tool.type === 'face' ? r * 0.86 : r;
  return {
    number: tool.number,
    type: tool.type,
    r,
    r2: r * r,
    prof,
    pn: PN,
    flat: tool.type === 'flat' || (tool.type === 'face' && !(tool.cornerRadius > 0)),
    tipHeight: profileHeight(tool, r),
    flute: tool.fluteLength,
    stickout,
    bodyR,
    holderR: holder.radius,
    length: tool.length,
    flutes: tool.flutes,
  };
}

// Cutting data helpers for the status panel.
export function surfaceSpeed(diameter, rpm) {
  return (Math.PI * diameter * rpm) / 1000; // m/min
}

export function chipLoad(feed, rpm, flutes) {
  return rpm > 0 && flutes > 0 ? feed / (rpm * flutes) : 0; // mm/tooth
}
