// Example part programs in Haas (NGC) mill dialect. Each one sets up its own blank and G54 (top centre
// of the stock) when loaded, like the other example lists. Tools are the default tool library
// (T1 face mill D50, T2 end mill D10, T3 end mill D6, T4 spot drill D10, T5 drill D6.8);
// H and D registers are the tool numbers.
//
// Haas syntax reminders used below: "%" lines start and end the file, O number + (NAME) on the first
// line, one M code per block, X1. = 1 mm but X1 = 0.001 mm (decimal point rule), local subprograms
// (M97 / G150 outlines / G65 macros) follow the M30.

const FACE = `%
O40010 (FACE MILL 120 X 80 PLATE)
(BLANK 120 X 80 X 30 ALUMINIUM, G54 X0 Y0 = TOP CENTRE, Z0 = TOP)
(T1 - 50 MM FACE MILL)
T1 M06
G00 G90 G17 G40 G49 G80 G54 G21
S3200 M03
X-90. Y-25.
G43 H01 Z25. M08
Z2.
(PASS 1 - Z-0.5)
G01 Z-0.5 F800.
X90. F1300.
Y0.
X-90.
Y25.
X90.
G00 Z2.
X-90. Y-25.
(PASS 2 - Z-1.0)
G01 Z-1. F800.
X90. F1300.
Y0.
X-90.
Y25.
X90.
G00 Z25. M09
G53 G49 Z0 M05
G53 Y0
M30
%
`;

const POCKETS = `%
O40020 (POCKETS WITH G13 AND G150)
(BLANK 120 X 80 X 30 ALUMINIUM, G54 = TOP CENTRE)
(T2 - 10 MM END MILL, CENTRE CUTTING; D02 / H02)
T2 M06
G00 G90 G17 G40 G49 G80 G54 G21
S9500 M03
X-30. Y0.
G43 H02 Z25. M08
Z2.
(CIRCULAR POCKET DIA 30 X 6 DEEP, TWO 3 MM PASSES WITH G91 AND L2)
G01 Z0. F300.
G13 G91 Z-3. I6. K15. Q4. D02 L2 F1000.
G90 G00 Z2.
(RECTANGULAR POCKET 40 X 30 X 5 DEEP WITH G150, OUTLINE IN N41)
X25. Y0.
G01 Z0. F300.
G150 P41 J4. K0.2 G41 D02 Z-5. Q2.5 R1. F1000.
G40 G01 X25. Y0.
G00 Z25. M09
G53 G49 Z0 M05
G53 Y0
M30
N41 (G150 OUTLINE: START HOLE X25 Y0 TO THE EDGE, CCW, BACK TO THE EDGE POINT)
G01 Y-15.
X45.
Y15.
X5.
Y-15.
X25.
M99
%
`;

const DRILL = `%
O40030 (DRILL PATTERNS G81 G83 G73 G70 G72)
(BLANK 120 X 80 X 30 ALUMINIUM, G54 = TOP CENTRE)
(T4 - 10 MM SPOT DRILL, T5 - 6.8 MM DRILL)
T4 M06
G00 G90 G17 G40 G49 G80 G54 G21
S6000 M03
X0. Y0.
G43 H04 Z25. M08
(SPOT 6 HOLES ON A 50 MM BOLT CIRCLE, FIRST AT 30 DEG; L0 = NO HOLE AT THE CENTRE)
G81 G99 Z-2. R2. F500. L0
G70 I25. J30. L6
(SPOT A ROW OF 4 HOLES 20 MM APART ALONG Y-30)
G80 G00 X-30. Y-30.
G81 G99 Z-2. R2. F500. L0
G72 I20. J0. L4
G80 G00 Z25. M09
G53 G49 Z0 M05
T5 M06
G00 G90 G54 X0. Y0.
S4500 M03
G43 H05 Z25. M08
(PECK DRILL THE BOLT CIRCLE 15 DEEP, 3 MM PECKS, FULL RETRACT)
G83 G99 Z-15. R2. Q3. F600. L0
G70 I25. J30. L6
(HIGH SPEED PECK THE ROW, CHIP BREAK BY SETTING 22)
G80 G00 X-30. Y-30.
G73 G98 Z-12. R2. Q2.5 F600. L0
G72 I20. J0. L4
G80 G00 Z25. M09
G53 G49 Z0 M05
G53 Y0
M30
%
`;

const PART = `%
O40040 (COMPLETE PART - FACE, PROFILE, POCKET, HOLES)
(BLANK 120 X 80 X 30 ALUMINIUM, G54 = TOP CENTRE)
(T1 FACE MILL D50, T2 END MILL D10, T4 SPOT DRILL, T5 DRILL D6.8)
(OP 1 - FACE 1 MM)
T1 M06
G00 G90 G17 G40 G49 G80 G54 G21
S3200 M03
X-90. Y-25.
G43 H01 Z25. M08
Z2.
G01 Z-1. F800.
X90. F1300.
Y0.
X-90.
Y25.
X90.
G00 Z25. M09
G53 G49 Z0 M05
(OP 2 - 100 X 60 BOSS 4 MM HIGH, CLIMB MILLED WITH G41)
T2 M06
G00 G90 G54 X-75. Y-45.
S9500 M03
G43 H02 Z25. M08
Z2.
G01 Z-5. F400.
G41 D02 X-50. F1200.
Y30.
X50.
Y-30.
X-60.
G40 G01 X-75. Y-45.
G00 Z2.
(SECOND LAP 4 MM FURTHER OUT CLEANS THE STOCK CORNERS)
G41 D02 G01 X-54. F1200.
Y34.
X54.
Y-34.
X-60.
G40 G01 X-75. Y-45.
G00 Z2.
(OP 3 - CIRCULAR POCKET DIA 24 X 5 DEEP IN THE BOSS)
X0. Y0.
G01 Z-1. F400.
G12 G91 Z-2.5 I6. K12. Q4. D02 L2 F1000.
G90 G00 Z25. M09
G53 G49 Z0 M05
(OP 4 - SPOT AND DRILL 4 HOLES)
T4 M06
G00 G90 G54 X-40. Y-20.
S6000 M03
G43 H04 Z25. M08
G81 G98 Z-3. R-0.5 F500.
X40.
Y20.
X-40.
G80 G00 Z25. M09
G53 G49 Z0 M05
T5 M06
G00 G90 G54 X-40. Y-20.
S4500 M03
G43 H05 Z25. M08
G83 G98 Z-14. R-0.5 Q3. F600.
X40.
Y20.
X-40.
G80 G00 Z25. M09
G53 G49 Z0 M05
G53 Y0
M30
%
`;

const MACRO = `%
O40050 (MACRO BOLT CIRCLE AND M97 SLOTS)
(BLANK 120 X 80 X 30 ALUMINIUM, G54 = TOP CENTRE)
(G65 CALLS THE BOLT CIRCLE MACRO O09010 THAT FOLLOWS THE M30)
T4 M06
G00 G90 G17 G40 G49 G80 G54 G21
S6000 M03
X0. Y0.
G43 H04 Z25. M08
G65 P9010 X0. Y0. R25. H8. Z-2.5 F500.
G00 Z25. M09
G53 G49 Z0 M05
(THREE SLOTS WITH A LOCAL SUBPROGRAM, Y POSITION IN #100)
T2 M06
G00 G90 G54 X35. Y-20.
S9500 M03
G43 H02 Z25. M08
#100=-20.
M97 P200 L3
G00 Z25. M09
G53 G49 Z0 M05
G53 Y0
M30
N200 (SLOT 15 LONG X 3 DEEP AT Y#100)
G00 X35. Y#100
Z2.
G01 Z-3. F300.
X50. F900.
G00 Z2.
#100=#100+20.
M99
O09010 (BOLT CIRCLE MACRO: X Y CENTRE, R RADIUS, H HOLES, Z DEPTH, F FEED)
IF [#11 LT 1.] THEN #3000=1 (H MUST BE AT LEAST 1)
IF [#26 EQ #0] THEN #3000=2 (Z DEPTH MISSING)
#10=0
WHILE [#10 LT #11] DO1
#12=#24+#18*COS[#10*360./#11]
#13=#25+#18*SIN[#10*360./#11]
G81 G98 X#12 Y#13 Z#26 R2. F#9
#10=#10+1.
END1
G80
M99
%
`;

const INCH = `%
O40060 (INCH PLATE - FACE AND G13 POCKET)
(BLANK 4.0 X 3.0 X 1.0 INCH ALUMINIUM, G54 = TOP CENTRE)
(NOTE THE DECIMAL POINT RULE: Z-200 = -0.0200 IN, P500 = 500 MS)
T1 M06
G00 G90 G17 G40 G49 G80 G54 G20
S3200 M03
X-3.1 Y-0.9
G43 H01 Z1. M08
Z0.1
G01 Z-200 F30.
X3.1 F50.
Y0.
X-3.1
Y0.9
X3.1
G00 Z1. M09
G53 G49 Z0 M05
T2 M06
G00 G90 G54 X0. Y0.
S9500 M03
G43 H02 Z1. M08
Z0.1
G01 Z0. F12.
G04 P500
G13 G91 Z-0.1 I0.25 K0.6 Q0.2 D02 L2 F40.
G90 G00 Z1. M09
G53 G49 Z0 M05
G53 Y0
M30
%
`;

const ALU = (x, y, z, protrusion = 14) => ({ x, y, z, material: 'aluminium', protrusion });

export const EXAMPLES_HAAS = [
  { id: 'haas-face', name: 'Haas: face milling', file: 'O40010.NC', desc: 'Two zig-zag facing passes with a 50 mm face mill (G00/G01, G43 H, G53 G49 Z0 tool-change position).', code: FACE, stock: ALU(120, 80, 30) },
  { id: 'haas-pockets', name: 'Haas: G13 + G150 pockets', file: 'O40020.NC', desc: 'Circular pocket with G13 (G91 Z step, L2 passes) and a rectangular G150 pocket whose outline is the local subprogram N41.', code: POCKETS, stock: ALU(120, 80, 30) },
  { id: 'haas-drill', name: 'Haas: G81/G83/G73 with G70/G72', file: 'O40030.NC', desc: 'Spot and peck drill a G70 bolt circle and a G72 row of holes (L0 on the cycle line).', code: DRILL, stock: ALU(120, 80, 30) },
  { id: 'haas-part', name: 'Haas: complete part (4 tools)', file: 'O40040.NC', desc: 'Face, G41 boss profile, G12 circular pocket, spot and G83 peck drilling with tool changes.', code: PART, stock: ALU(120, 80, 30) },
  { id: 'haas-macro', name: 'Haas: G65 macro + M97 subprogram', file: 'O40050.NC', desc: 'Bolt circle macro O09010 (WHILE/DO, #variables, #3000 checks) called with G65, and three slots from a local M97 subprogram with L3.', code: MACRO, stock: ALU(120, 80, 30) },
  { id: 'haas-inch', name: 'Haas: inch plate (G20)', file: 'O40060.NC', desc: 'Inch program showing the decimal point rule (Z-200 = -0.02 in, G04 P500 = 0.5 s), facing and a G13 pocket.', code: INCH, stock: ALU(101.6, 76.2, 25.4) },
];

export function getExampleHaas(id) {
  return EXAMPLES_HAAS.find((x) => x.id === id) || null;
}
