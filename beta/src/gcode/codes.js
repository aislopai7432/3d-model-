// The single source of truth for which codes the interpreter accepts. The Reference tab is generated
// from this table, so the help shown to the user always matches what the interpreter really does.

export const G_CODES = {
  0: { group: 'motion', name: 'Rapid positioning', desc: 'Moves at the machine rapid rate in a straight line. Must never touch material.' },
  1: { group: 'motion', name: 'Linear interpolation', desc: 'Straight cutting move at the programmed feed rate F.' },
  2: { group: 'motion', name: 'Circular interpolation CW', desc: 'Clockwise arc in the active plane, using I/J/K centre offsets or R radius. A Z (out-of-plane) word makes it a helix.' },
  3: { group: 'motion', name: 'Circular interpolation CCW', desc: 'Counter-clockwise arc. Same words as G02.' },
  4: { group: 'nonmodal', name: 'Dwell', desc: 'Pause motion. P with a decimal point is seconds (P1.5), without one it is milliseconds (P1500). X is seconds.' },
  10: { group: 'nonmodal', name: 'Set work offset', desc: 'G10 L2 P1..6 X Y Z writes G54..G59 (machine coordinates of the part zero / gauge line).' },
  17: { group: 'plane', name: 'XY plane', desc: 'Arcs in the XY plane (I, J). Default.' },
  18: { group: 'plane', name: 'ZX plane', desc: 'Arcs in the ZX plane (K, I).' },
  19: { group: 'plane', name: 'YZ plane', desc: 'Arcs in the YZ plane (J, K).' },
  20: { group: 'units', name: 'Inch units', desc: 'Coordinates in inches and feed in inch/min. Converted internally to millimetres.' },
  21: { group: 'units', name: 'Metric units', desc: 'Coordinates in millimetres and feed in mm/min.' },
  28: { group: 'nonmodal', name: 'Return to reference', desc: 'Rapid through the given intermediate point, then to machine zero for the named axes. G91 G28 Z0 sends Z straight home.' },
  40: { group: 'cutter', name: 'Cutter compensation cancel', desc: 'Cutter radius compensation is off. The simulator always follows the programmed tool-centre path.' },
  43: { group: 'tlo', name: 'Tool length offset +', desc: 'Applies the length of tool H_ so Z positions refer to the tool tip.' },
  49: { group: 'tlo', name: 'Tool length offset cancel', desc: 'Z positions refer to the spindle gauge line again.' },
  53: { group: 'nonmodal', name: 'Machine coordinates', desc: 'One-shot G00/G01 move in machine coordinates, ignoring work and tool offsets (e.g. G53 G0 Z0).' },
  54: { group: 'wcs', name: 'Work offset 1', desc: 'Selects work coordinate system G54.' },
  55: { group: 'wcs', name: 'Work offset 2', desc: 'Selects G55.' },
  56: { group: 'wcs', name: 'Work offset 3', desc: 'Selects G56.' },
  57: { group: 'wcs', name: 'Work offset 4', desc: 'Selects G57.' },
  58: { group: 'wcs', name: 'Work offset 5', desc: 'Selects G58.' },
  59: { group: 'wcs', name: 'Work offset 6', desc: 'Selects G59.' },
  61: { group: 'path', name: 'Exact stop mode', desc: 'Accepted. The simulator always reaches every programmed point exactly, so this has no visible effect.' },
  64: { group: 'path', name: 'Continuous path mode', desc: 'Accepted. Corner blending is not simulated; the path is followed exactly.' },
  73: { group: 'cycle', name: 'High-speed peck drilling', desc: 'Pecks by Q, retracting 0.5 mm between pecks to break the chip.' },
  80: { group: 'cycle', name: 'Cancel canned cycle', desc: 'Ends G73/G81/G82/G83 mode.' },
  81: { group: 'cycle', name: 'Drilling cycle', desc: 'Rapid to XY, rapid to R, feed to Z, rapid out. Repeats on every later XY block until G80.' },
  82: { group: 'cycle', name: 'Spot / counterbore cycle', desc: 'Like G81 with a dwell P at the bottom.' },
  83: { group: 'cycle', name: 'Deep peck drilling', desc: 'Pecks by Q and retracts fully to R after each peck to clear chips.' },
  90: { group: 'distance', name: 'Absolute positioning', desc: 'X/Y/Z are positions in the active work coordinate system.' },
  91: { group: 'distance', name: 'Incremental positioning', desc: 'X/Y/Z are distances from the current position.' },
  90.1: { group: 'arcdist', name: 'Absolute arc centres', desc: 'I/J/K are absolute work coordinates of the arc centre.' },
  91.1: { group: 'arcdist', name: 'Incremental arc centres', desc: 'I/J/K are measured from the arc start point. Default.' },
  94: { group: 'feedmode', name: 'Feed per minute', desc: 'F is in mm/min (or inch/min with G20). The only feed mode supported.' },
  291: { group: 'dialect', name: 'ISO dialect mode', desc: 'On the 808D-style control G291 in the first line switches the program to ISO (Fanuc) dialect. Accepted only there.' },
  98: { group: 'retract', name: 'Canned cycle initial-level return', desc: 'Drilling cycles retract to the Z they started from.' },
  99: { group: 'retract', name: 'Canned cycle R-level return', desc: 'Drilling cycles retract to the R plane.' },
};

export const M_CODES = {
  0: { group: 'stop', name: 'Program stop', desc: 'Stops at the end of the block. Press Cycle Start to continue.' },
  1: { group: 'stop', name: 'Optional stop', desc: 'Stops only when the Optional Stop switch is on.' },
  2: { group: 'stop', name: 'Program end', desc: 'Ends the program, stops spindle and coolant.' },
  3: { group: 'spindle', name: 'Spindle CW', desc: 'Starts the spindle clockwise at S rpm. The control waits for the spindle to reach speed.' },
  4: { group: 'spindle', name: 'Spindle CCW', desc: 'Starts the spindle counter-clockwise at S rpm.' },
  5: { group: 'spindle', name: 'Spindle stop', desc: 'Stops the spindle.' },
  6: { group: 'toolchange', name: 'Tool change', desc: 'Retracts Z to home and swaps the spindle tool for the one selected with T using the umbrella tool changer.' },
  7: { group: 'coolant', name: 'Mist coolant on', desc: 'Turns on mist/air-blast coolant.' },
  8: { group: 'coolant', name: 'Flood coolant on', desc: 'Turns on the flood coolant nozzles.' },
  9: { group: 'coolant', name: 'Coolant off', desc: 'Turns all coolant off.' },
  30: { group: 'stop', name: 'Program end and rewind', desc: 'Ends the program, stops spindle and coolant, and rewinds.' },
};

export const WORDS = {
  N: 'Sequence (line) number. Ignored by the motion logic.',
  O: 'Program number. Ignored.',
  X: 'X axis position or distance.', Y: 'Y axis position or distance.', Z: 'Z axis position or distance.',
  I: 'Arc centre offset along X.', J: 'Arc centre offset along Y.', K: 'Arc centre offset along Z.',
  R: 'Arc radius (negative for arcs over 180°), or the R plane in drilling cycles.',
  F: 'Feed rate (mm/min or inch/min).', S: 'Spindle speed (rpm).',
  T: 'Tool select for the next M06.', H: 'Tool length offset number for G43.',
  P: 'Dwell time, G10 offset number.', Q: 'Peck depth for G73/G83.', L: 'Repeat count for canned cycles; L2 for G10.',
  D: 'Cutter radius offset number. Only meaningful with G41/G42, which are not supported.',
};

// Codes we recognise but deliberately refuse, with the reason shown to the user.
export const UNSUPPORTED_G = {
  41: 'Cutter radius compensation (G41/G42) is not simulated. Post the program with compensation "in computer" so the code is the tool-centre path.',
  42: 'Cutter radius compensation (G41/G42) is not simulated. Post the program with compensation "in computer" so the code is the tool-centre path.',
  92: 'G92 coordinate shifts are not supported. Use G54..G59 work offsets (or G10 L2) instead.',
  93: 'Inverse-time feed (G93) is not supported. Use G94 feed per minute.',
  95: 'Feed per revolution (G95) is not supported. Use G94 feed per minute.',
  68: 'Coordinate rotation (G68) is not supported.',
  51: 'Scaling (G51) is not supported.',
  84: 'Tapping cycles are not supported; there are no taps in the tool library.',
  85: 'Boring cycles are not supported.', 86: 'Boring cycles are not supported.', 87: 'Boring cycles are not supported.',
  88: 'Boring cycles are not supported.', 89: 'Boring cycles are not supported.',
  43.4: 'Tool centre point control (G43.4) needs a 5-axis machine.',
  290: 'G290 (back to Siemens mode) cannot be used inside an ISO program; the dialect is chosen per program by its first line.',
};

export const UNSUPPORTED_M = {
  97: 'Local subprogram calls (M97) are not supported. Expand the subprogram in the file.',
  98: 'Subprogram calls (M98) are not supported. Expand the subprogram in the file.',
  99: 'Subprogram return (M99) is not supported.',
  19: 'Spindle orientation (M19) is handled automatically by the tool changer.',
};

export const ALLOWED_LETTERS = new Set(['G', 'M', 'N', 'O', 'X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'F', 'S', 'T', 'H', 'P', 'Q', 'L', 'D']);

export function gKey(v) {
  return Math.round(v * 10) / 10;
}

export function gName(v) {
  const k = gKey(v);
  const whole = Math.trunc(k);
  const s = String(Math.abs(whole)).padStart(2, '0');
  return 'G' + (k % 1 ? `${s}.${Math.round((k % 1) * 10)}` : s);
}

export function mName(v) {
  return 'M' + String(Math.trunc(v)).padStart(2, '0');
}
