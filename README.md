# MillLab: 3-axis CNC milling simulator with an 808D-style control

MillLab is a browser simulator of a vertical machining centre, operated through a control modelled on the **SINUMERIK 808D**. You can:

- write part programs in Siemens mode with R parameters, cutter compensation and the standard drilling and milling cycles, or in ISO dialect;
- design cycles and contours in programGUIDE-style input screens;
- set up tools, wear, work offsets and the blank;
- run the program in JOG, MDA or AUTO and watch a real Z-map model of the stock being machined.

**Run it:** https://aislopcnc.github.io/3d-model-/ (GitHub Pages, served from this branch), or locally as described below.

There is no build step and nothing to install. Three.js 0.160 loads from jsDelivr through an import map. Textures, tools, sounds and example programs are generated at runtime.

> MillLab is an independent training simulator. Its operating concept follows the SINUMERIK 808D for learning purposes, but it is not Siemens software and is not affiliated with or endorsed by Siemens AG. SINUMERIK is a trademark of Siemens AG. Always check programs against the official documentation before running them on a real machine.

## Two modes: the workshop game and the simulator

The top bar switches between two modes. The app remembers the last one; `?mode=workshop` or `?mode=sim` in the URL picks one.

- **Workshop** (the default) is a first-person game in a machine shop around the VMC. You read engineering drawings, take a block of metal from the stock rack, clamp it in the vise, program and run the part at the machine's control panel, then inspect and measure what you made.
- **Simulator** is the full desktop simulator: orbit camera, the control docked on the right and the machine control panel along the bottom. The workshop stays around the machine as the background; walls and roof are cut away when the camera is outside the building.

Both modes drive the same machine, control, programs and blank. A part half-made in one mode is still in the vise in the other.

### Workshop controls

| Input | Action |
|---|---|
| Click the view | Capture the mouse to look around (Esc releases it) |
| W A S D or arrows | Walk; Shift runs, C or Ctrl crouches, Space hops |
| E or left click | Use what the crosshair points at (the prompt says what) |
| Q (or Tab) | Open the current drawing; in the operator view, show or hide the pinned drawing |
| J | Job list |
| H | Controls card |
| Esc | Close the top-most window, leave the measuring station, or step back from the control panel |

On a touch screen the left thumb walks (virtual joystick), the right thumb looks around, and tapping the prompt uses the object.

### Tutorial

The interactive tutorial walks you through a whole job, the tutorial part **T01 First part**: an 80 × 50 × 16 aluminium blank faced to 15 mm, with one rectangular pocket and two drilled holes. It teaches by doing. Each step explains one thing in a card and moves on by itself once the game or the control shows that you have done it. Only the pure explanations have a *Next* button.

- **Starting it.** The welcome card on the first visit offers *Start tutorial*. Later, use the **Tutorial** button in the top-right HUD, the help card, or the **T** key. Your progress is saved, so it resumes at the same step after a reload or after *Exit*. The ↺ button restarts it. *Back* and *Skip step* are always available.
- **What it covers.**
  - Looking around and walking (mouse or WASD; on touch screens, the thumbs).
  - Opening the job board and accepting T01.
  - A guided tour of the drawing sheet. The viewer zooms to each region and highlights it: views and sections, datums and ordinate dimensions, a toleranced dimension, the hole callout with its depth symbol, and the title block with material and blank.
  - Taking the right blank from the rack, and why the near-miss blanks are wrong.
  - Opening the doors and clamping the blank.
  - At the control panel:
    - the operating areas, softkeys and machine control panel;
    - referencing the machine;
    - setting G54 through OFFSET › Work offset › *Set from blank*;
    - programming CYCLE71, POCKET3 and MCALL CYCLE81 through the real programGUIDE forms, with each field highlighted and checked against the drawing;
    - running the program safely with AUTO, feed override and CYCLE START.
  - Unloading the part, the inspection report, and measuring the pocket with the caliper and the length with the micrometer, compared with the drawing tolerances.
- **Guidance.**
  - A yellow 3D waypoint (arrow, light pillar and floor ring) marks the next place to walk to. An arrow at the screen edge points to it when it is off-screen.
  - A pulsing ring and a pointer bubble mark the exact key, softkey or form field to use, and follow the layout as it changes.
  - *Fill for me* enters the cycle values if you get stuck. *Reference program* loads the worked solution.
- **Out of order.** If you are ahead of the tutorial (job already accepted, blank already clamped, part already machined), it skips the steps that are already done.

### The job flow

1. **Job board** (cork board on the left wall). Ten drawings are pinned there, P01 to P10, with difficulty one to five stars in aluminium, acetal, brass and steel. Choose one to open the **drawing viewer**: a full ISO-style A3 sheet you can zoom with the wheel or a pinch and pan by dragging. The side panel shows the customer brief, material, blank and finished sizes, tolerances and the **setup note** (G54 on the top front-left corner of the raw blank, Z0 = top of the blank). *Accept job* creates `JOB_Pxx.MPF` with a header template and selects it. *Load reference program* writes a worked solution to `JOB_Pxx_REF.MPF` (after a confirmation).
2. **Stock rack** (right wall). Pick the blank the drawing's title block calls for. Near misses (wrong height, wrong material) are on the shelf too. Taking a wrong blank is allowed, but the inspection fails it. The blank is shown in your hand and in the *Carrying* chip.
3. **Vise.** Open the doors with a door handle, then use the vise to clamp the blank. The spindle must be stopped and no program running. Loading and unloading only work with the doors open.
4. **Control panel** (the pendant). Using it opens the **operator view**: the real 808D-style screen with its softkeys docked on the right, the machine control panel along the bottom and the drawing pinned on the left. The panel can be resized or hidden. Everything the simulator can do works here: JOG, MDA, AUTO, work offsets, cycle forms, the contour designer, the editor and CYCLE START. The machine stays visible in the middle. Esc or *Step back* returns to walking.
5. **CAM computer** (left wall). This opens the same control straight in the PROGRAM area for offline programming, without the machine control panel. Its monitor shows the current program and a sketch of the toolpath.
6. **Tool crib.** Lists the tools in the magazine (T numbers, diameters, lengths), with a shortcut to OFFSET › Tool list.
7. **Unload** the finished part (doors open), carry it to the **inspection bench** and use the granite surface plate. The part is set on the plate and inspected against the drawing. The **inspection report** shows a grade (A to D or FAIL), a score, each characteristic (nominal, measured, tolerance, OK or NOT OK), notes, and a deviation map: green is within tolerance, blue is material left, red is too deep. The best grade, score and time per job are saved.

The **objectives card** (top left) ticks itself from the real machine state. Its steps are: read the drawing, take the right blank, load it, set G54 (within 0.05 mm of the expected corner), select a program that compiles, machine the part in AUTO, unload it and inspect it. Progress is stored in the browser under `milllab.game`. Machined parts survive a reload, including their Z-map, the inspection report and your measurements. This covers a part in the vise (fully or partly machined, for example after a feed hold), a part in your hands and a part on the inspection plate. They are kept in IndexedDB (`milllab-game`). Where IndexedDB is unavailable, as in some private windows, the game still works but forgets machined parts on reload.

In the workshop the blank in the vise is a real one that you clamped by hand. The control's own blank features are refused with a message on the control: *Load blank*, *New blank*, the setup wizard, and changing the accuracy while a machined part is clamped. Example programs open as programs only, without changing the blank or G54. Running a program again keeps cutting the same blank: "Fresh blank at each AUTO start" applies only in the simulator. The simulator keeps the old behaviour.

### Measuring instruments

The foam tray on the inspection bench holds a **digital caliper** (outside jaws, inside jaws and depth rod; 0.01 mm), an **outside micrometer** (0–25 to 100–125 mm frames, 0.001 mm), a **dial bore gauge** (18–35, 35–60 and 50–160 mm heads), a **depth micrometer**, a **dial indicator** for flatness sweeps, and a **height gauge** standing on the plate. Use *Measure the part* in the report, or an instrument on the tray, to open the measuring station. Pick an instrument and click the faces to measure. The readings come from the actual machined Z-map, not from the drawing, with each instrument's resolution, range and a little noise. They go on your measurement sheet, which is also shown in the inspection report.

## Running locally

ES modules do not load from `file://`, so serve the folder:

```sh
python3 -m http.server 8000      # then open http://localhost:8000
```

`npx serve .` also works. The page needs internet access once to fetch Three.js and the fonts.

Headless tests cover the interpreters, cycles, cutter compensation, Z-map accuracy and controller execution of every example. They need only Node 18 or later:

```sh
node tests/run.mjs
```

## The NGC-style control (default)

Two controls drive the same machine. The default is an NGC-style control modelled on the Haas Mini Mill pendant: the screen sits on top, the keyboard below, and power, E-STOP, the jog handle, CYCLE START and FEED HOLD run down the left side. The 808D-style control described in the next section is still available. Switch between them with SETTING › Simulator › Control Style on the NGC-style control, or SYSTEM › Settings › Control style on the 808D-style control. MillLab is not affiliated with Haas Automation, and the control carries no Haas logos or artwork.

- **Keyboard.** All eight key groups are laid out as in the operator's manual figure: FUNCTION, DISPLAY, CURSOR, MODES, JOG, OVERRIDES, ALPHA and NUMERIC. The side panel has the MEMORY LOCK and SETUP MODE key switches, SECOND HOME and the work light. The beacon sits on top of the pendant. Option keys that this machine lacks (P-Cool, TSC, auto door, the A, B and C axes) show the control's "not installed" message.
- **Screen.** The screen has these parts:
  - a status bar showing the mode (for example *Setup: JOG*, *Operation: MEM* or *Edit: MDI*) and the time;
  - the active program or MDI pane;
  - the tabbed main display;
  - spindle, positions (with load bars) and timers panes;
  - the icon bar;
  - the green INPUT bar, the system status and the alarm status.
- **Modes and procedures.**
  - Start up with RESET (clears 102 SERVOS OFF), then POWER UP (Z first).
  - HANDLE JOG: drag or scroll the handle. Increments are .0001 to .1 in, or .001 to 1 mm.
  - OFFSET: TOOL OFFSET MEASURE and PART ZERO SET, with F1 to set a value and ENTER to add to it. F3 runs the simulated probing actions.
  - MDI: type a block, then INSERT, then CYCLE START.
  - LIST PROGRAM: the Memory and USB devices, with SELECT PROGRAM, INSERT (new), ALTER (edit) and ERASE PROGRAM.
  - MEMORY: single block, option stop and block delete.
  - EDIT: INSERT, ALTER, DELETE and UNDO through the input line, F2 block select and the F1 menu.
  - GRAPHICS: a simulation run without machine motion.
  - Alarms: E-STOP raises 107. Release the button, then press RESET twice.
- **Door rules.** RUN mode (key switch locked) needs the door closed to run, and the door stays locked while the machine runs. SETUP mode allows jogging with the door open, limits rapids to 25 % and the spindle to Setting 292, and runs only while CYCLE START is held.
- **VPS templates.** EDIT › VPS offers Face Milling, Rectangular Pocket, Circular Pocket (G13) and Drilling (single hole, G70 bolt circle or grid). Each template has a variables table and an illustration. F4 writes the generated Haas G-code into the active program, the MDI program or a new O-number program. CYCLE START runs it in MDI.
- **Physical keyboard.** Letters and numbers type on the input line. Enter = ENTER, Backspace = CANCEL, the arrows, PgUp, PgDn, Home and End = cursor, Insert and Delete = INSERT and DELETE, Ctrl+Z = UNDO, F1–F4 = F1–F4, Ctrl+Enter = CYCLE START, Pause = FEED HOLD.

Programs in Haas format (`%` and an `Onnnnn` line) run in the Haas dialect. The Siemens-mode and ISO programs from the 808D-style control still run on the NGC-style control.

## The 808D-style control

The right-hand side is the control unit: five operating-area keys above an HMI screen, with eight horizontal and eight vertical softkeys. The machine control panel runs along the bottom.

| Area | What it holds |
|---|---|
| **Machine** | Actual values in WCS or MCS, with distance-to-go and a referenced marker per axis; T/F/S with load, Vc and chip load; the active G functions and program-control flags. The mode panel shows the current program blocks in AUTO, the MDA buffer in MDA, and reference status in REF POINT. Softkeys: Prog. ctrl (SBL, M01, SKP, DRY, ROV), G funct., Set WO (X=0, Y=0, Z=0 at the tool), T, S, M (tool change, spindle, coolant), JOG data, Ref. all, New blank |
| **Offset** | Tool list (Siemens type codes 120, 110, 121, 140, 200, 220 and 230; length, radius, flutes, angle), Wear (ΔL and ΔR, plus the simulator's tool-life estimate), Work offsets G54 to G59, R variables R0 to R299, Setting data (JOG feed and spindle speed, dry-run feed, speed limit, working area limitation), Blank (material, size, clamping height) |
| **Program** | Editor with syntax highlighting, error markers and the current block. Drilling, Milling and Contour softkeys open cycle input screens with help pictures; OK inserts the call, and Recompile on a call line edits it again. Also here: a contour designer that produces a CYCLE72 label contour or a G41/G42 path, a Simulation group, Find, Renumber, comment toggle, Execute and Save as |
| **Program manager** | NC memory (programs stored in the browser) with Execute, Open, New, Copy, Rename, Delete, Save to PC and Load from PC. Examples is a read-only folder |
| **System / Alarm** | Alarm list, Messages, Settings (default dialect, ISO G43 behaviour, door interlock, fresh blank per run, accuracy, visual options, volume), Service display, Reference (generated from the interpreters' own tables) and Version |

The **machine control panel** has these keys and controls:

- Mode keys: **JOG**, **REF POINT**, **MDA** and **AUTO**.
- **INC** keys: 1, 10, 100 and 1000 µm. With no INC key selected, jogging is continuous.
- Axis keys with **RAPID**.
- Spindle keys: CCW, stop and CW, using the JOG spindle speed.
- Feed override knob (0–120 %, which also scales rapids with ROV) and spindle override knob (50–120 %).
- Program control keys: **SBL**, **M01**, **SKP** and **DRY**.
- **RESET**, **CYCLE STOP** and **CYCLE START**, plus **E-STOP**.

CYCLE START runs the selected program in AUTO and the MDA buffer in MDA. In JOG and REF POINT it has no function.

The 3D pendant on the machine mirrors the screen, and its E-STOP, CYCLE START and CYCLE STOP buttons and the door handles can be clicked.

## Programming

### Siemens mode (default, G290)

| Group | Supported |
|---|---|
| Motion | G0, G1, and G2/G3 with I/J/K (incremental, or `I=AC(..)`), `CR=` (negative for arcs over 180°) and `TURN=` helices; G4 F (seconds) or G4 S (revolutions) |
| Planes, dimensions | G17/G18/G19, G90/G91 plus `X=AC(..)` and `X=IC(..)` per word, G70/G71/G700/G710, G94/G95 |
| Offsets | G54–G59 and G500, G53 or SUPA (offsets suppressed for one block), G74 reference point approach (`G74 Z1=0`), programmable frames TRANS, ATRANS, ROT and AROT (`RPL=`) |
| Tools | `T.. M6` and `D1`/`D0`. D1 activates length and radius (geometry plus wear) and becomes active automatically after M6 |
| Cutter compensation | G41/G42/G40 with transition circles at outside corners, intersections at inside corners and gouge detection. RND= and CHR= work between straight lines |
| Parameters | R0–R299, `+ - * / DIV MOD`, comparisons, AND/OR/XOR/NOT, SIN COS TAN ASIN ACOS ATAN2 SQRT ABS POT TRUNC ROUND ROUNDUP EXP LN MINVAL MAXVAL |
| Flow | Labels, GOTOF/GOTOB/GOTO/GOTOC, `IF <cond> GOTOF <label>`, MSG("…"), block skip `/` (SKP) |
| M functions | M0 M1 M2 M3 M4 M5 M6 M7 M8 M9 M17 M30 (M40–M42 accepted) |
| Cycles | CYCLE81, CYCLE82, CYCLE83 (chip breaking and chip removal), MCALL with HOLES1 and HOLES2, CYCLE71 face milling, POCKET3 and POCKET4 (vertical, helical and oscillating insertion; roughing and finishing), CYCLE76 and CYCLE77 spigots, LONGHOLE, SLOT1, SLOT2, and CYCLE72 contour milling of a `"START:END"` label contour with RL=40/41/42 and quarter-circle, semicircle or straight approach and retract |

Errors are reported in the editor and as alarms. Where an equivalent exists the alarm uses the control's number, for example:

- 12080 syntax error
- 12550 name not defined
- 14040 error in end point of circle
- 14080 jump destination not found
- 61101 reference plane defined incorrectly
- 61102 no spindle direction programmed
- 61000 no tool offset active
- over-travel against the travel or the working area limitation, checked for every point before the program starts

Anything that is not implemented is rejected with an explanation rather than silently ignored. That includes SCALE/MIRROR, subprogram calls (`L..`), polar coordinates, CIP/AR=, turning functions and tapping cycles.

### ISO dialect (G291 in the first line)

This is the Fanuc-style language:

- G0–G3 (I/J/K or R), G4, G10 L2, G17–G19, G20/G21, G28, G40, G43/G49 H, G53, G54–G59, G61/G64 and G90/G91 (also G90.1/G91.1), G94;
- drilling cycles G73, G81, G82 and G83 with G80, G98/G99 and L repeats;
- M0–M9 and M30.

G41/G42, G92, G95, M98 and similar codes are rejected with explanations. Using "Require G43" (Settings) Z refers to the gauge line until G43 H_ is active, as on a Fanuc or Haas control.

## Simulation

**Material removal.** The blank is a Z-map, a dense grid of material heights. For 3-axis machining with vertical cutters this is exact up to the grid resolution, because such a machine cannot cut undercuts. Every motion segment sweeps the exact cutter profile: flat, ball, bull nose, face mill, 118° drill, spot drill or chamfer mill. Ramps and helices are solved per grid node. Only changed tiles are re-meshed. Machined surfaces show feed marks, and through-cuts are cut away. The accuracy preset (Settings) chooses the grid, from 0.6 to 0.15 mm, and the arc chord tolerance.

**Collisions and limits.** The following raise an alarm and stop the machine:

- a rapid traverse into material;
- cutting with the spindle stopped;
- cutting deeper than the flute length (the shank rubs);
- the holder or spindle nose touching the part;
- the cutter, holder or spindle hitting the vise;
- the tool reaching the table.

Programmed over-travel is caught before the program starts, and jogging stops at the soft limits or the working area limitation.

**Machining physics.** These are simplified models meant to teach the trends:

- Spindle load is material removal rate × the specific cutting force of the material, against an 11 kW spindle.
- Spindle temperature follows speed and load, and coolant pulls it down.
- Tool life is consumed by the volume cut, weighted by how abrasive the material is, by dry cutting and by excess cutting speed.
- Materials are aluminium 6061, steel 1045, brass C360 and acetal.

**Machine.** A VMC with 560 × 410 × 410 mm travel and home at X0 Y0 Z0 with negative travel, as is usual. It has:

- linear rails and ball screws that turn with the axes, at a 10 mm lead;
- telescopic way covers;
- a 12,000 rpm spindle;
- a 16-pocket umbrella tool changer with a full change sequence: Z home, orient, carousel in, unclamp, lift, index, lower, clamp, carousel out;
- sliding doors with an interlock;
- coolant hoses, LED lighting, a stack light and the pendant.

Chips land on the actual machined surface and ride with the table. Coolant streams aim at the cutter. Sparks appear only when cutting steel dry at speed, or on a crash. All sound is synthesised: the spindle pitch follows rpm, the cutting noise is modulated at tooth-passing frequency, and the servos and tool changer have their own sounds.

## Example programs

Open them from **Prog. Mgr › Examples**. *Execute* loads the blank, sets G54 to the top centre of the blank and selects the program for AUTO.

| File | Shows |
|---|---|
| FACE_MILL.MPF | CYCLE71, two 0.5 mm cuts, zig-zag |
| POCKET_RECT.MPF | POCKET3 roughing with helical insertion, then finishing |
| POCKET_CIRC.MPF | POCKET4 plus LONGHOLE in brass |
| HOLE_PATTERN.MPF | MCALL CYCLE82/CYCLE83 on HOLES2 and HOLES1 in steel, chip removal vs chip breaking |
| SLOTS.MPF | SLOT1, SLOT2 and an R-parameter loop keyway with RND |
| CONTOUR.MPF | CYCLE72 on a label contour with arcs and a concave notch, RL=41, quarter-circle approach |
| COMPLETE_PART.MPF | Five tools: face, pocket, G41 outside step with RND corners, drilling, chamfer |
| DOME_R_PARAM.MPF | A dome machined entirely from R-parameter maths and IF/GOTOB loops |
| ISO_*.MPF | The same kinds of parts in ISO dialect (G291) |

## Keyboard

| Key | Function |
|---|---|
| Space | CYCLE START / CYCLE STOP |
| Esc | RESET (or leave measure mode) |
| S | Single block step |
| Arrows, PgUp/PgDn | Jog X/Y/Z in JOG (Shift for rapid) |
| F1–F5 | Machine, Offset, Program, Program manager, System |
| 1–6 | Iso, front, side, top, work and machine views |

In the 3D view, drag to orbit, right-drag or Shift-drag to pan, and scroll to zoom. On touch screens use one finger, two fingers and pinch. Measure (on the view toolbar) gives point-to-point distances in work coordinates.

## Conventions

- **Work offsets** store the machine position of the part zero. For Z, that is the machine Z of the spindle gauge line when the tool tip touches the zero, minus the tool length. *Set WO*, *Set from blank* and the setup wizard compute this for you.
- **Tool length in Siemens mode** comes from D1, the active cutting edge. After `D0`, Z refers to the gauge line, and the crash alarm says so if you forget.
- **Fresh blank per run.** By default AUTO loads a fresh blank at every program start. Turn this off in Settings to run a second operation on the same part.
- **Numbers without a decimal point are whole units** (X10 is 10 mm).

## Limitations

- Each tool has one cutting edge (D1). Edges D2–D9 and tool names are not supported.
- Cutter compensation works in G17 only, with transition circles (G451 is accepted, but it also uses transition circles). Approach and retract are straight-line, NORM-style moves.
- Not supported: subprograms (`L`, `RET`, `M98`), SCALE/MIRROR, polar coordinates, CIP/AR=, G96 and tapping or boring cycles.
- The cycles follow the documented standard-cycle signatures, but details may differ from the real control. Examples: the default stepovers, the exact approach of CYCLE76/77, and the reference point of LONGHOLE and SLOT1 (the inner end of the slot). The blank parameters of POCKET3/4 are ignored.
- Feed moves run at constant speed. There is no corner blending or look-ahead; rapids use trapezoidal acceleration.
- The Z-map resolves to its grid, so features smaller than about two cells are approximated. Volumes carry about 1 % sampling error at the walls.
- Collision checks cover the cutter, holder and spindle nose against the part, the vise and the table. The rest of the head is not checked.
- Load, temperature and tool life are teaching models, not calibrated predictions.
- Spindle rotation on screen is slowed above a few revolutions per second to avoid strobing; a blur sleeve shows the real speed.

## Code layout

| Path | Purpose |
|---|---|
| `index.html`, `styles.css` | Layout, HMI and MCP styling |
| `src/main.js` | App wiring: compile, MDA, mode-dependent cycle start, material removal and collision checks per segment, cutting physics, measuring, frame loop, persistence |
| `src/config.js` | Machine geometry and limits, materials, default tools, accuracy presets, tool changer timing, default settings |
| `src/gcode/siemens.js` | Siemens-mode parser and interpreter: R parameters, frames, jumps, D offsets, CRC buffering, RND/CHR, MCALL; also the syntax highlighter |
| `src/gcode/sinucycles.js` | Drilling and milling cycles, plus the parameter metadata used by the input screens |
| `src/gcode/crc.js` | Tool radius compensation and corner rounding geometry |
| `src/gcode/expr.js` | Arithmetic expression evaluator |
| `src/gcode/interpreter.js`, `parser.js`, `codes.js` | ISO dialect interpreter and its code table |
| `src/gcode/compile.js` | Dialect detection (G290/G291) and compile entry point |
| `src/gcode/examples808.js`, `examples.js` | Example programs (Siemens mode and generated ISO) |
| `src/sim/controller.js` | Channel: modes, AUTO/MDA/JOG execution, single block, program control, tool change sequence, referencing, interlocks, alarms |
| `src/sim/zmap.js`, `tooling.js` | Z-map material removal and cutter profiles |
| `src/scene/*` | Machine model, tools, stock mesh, vise, toolpath, effects, renderer; `workshop.js` builds the machine shop |
| `src/game/game.js`, `ui-game.js`, `drawview.js` | Workshop game: modes, first-person interactions, job flow, objectives, persistence, HUD and overlays, drawing pan/zoom |
| `src/game/tutorial.js`, `tutorial-template.js` | Interactive tutorial: steps, state-driven advancement, spotlight / bubble / 3D waypoint guidance, drawing tour, form value checks; the player's T01 program template |
| `src/game/tutorial-part.js` | The tutorial job T01: part definition, reference program and the cycle values for each programming step |
| `src/game/fps.js` | First-person controller (pointer lock, WASD, collisions, touch joystick, interaction prompt) |
| `src/game/parts.js`, `inspect.js`, `drawing.js` | Job drawings (part definitions and reference programs), inspection against the drawing, ISO drawing sheets |
| `src/game/measuring.js`, `gauges.js` | Measuring instruments: 3D models, readouts, the measuring station and the measurement maths |
| `src/ui/haas/` | NGC-style control: pendant keyboard and handle (`haas-keys.js`), modes, keys and procedures (`haas.js`), screen panes (`haas-screen.js`), VPS templates (`haas-vps.js`), styles (`haas.css`) |
| `src/ui/hmi.js` | Operating areas, pages and softkeys |
| `src/ui/ui.js` | MCP, keyboard, program manager operations, tool editing, wizard |
| `src/ui/cycleforms.js`, `contour.js`, `programs.js`, `editor.js` | Cycle input screens, contour designer, NC program memory and the editor |
| `tests/` | Headless Node tests (`node tests/run.mjs`) |
