# MillLab: 3-axis CNC milling simulator

A browser-based simulator of a vertical machining centre, built with Three.js. You load or write G-code, the control interprets it block by block, the machine moves, and the cutter removes material from a real stock model. It is meant for learning CNC machining, trying out G-code and seeing what a program actually cuts.

**Run it:** https://aislopai7432.github.io/3d-model-/ (GitHub Pages, served from this branch), or locally as described below.

There is no build step and nothing to install. Three.js 0.160 loads from jsDelivr through an import map. Textures, tool geometry and sound are all generated at runtime, so the project has no asset files.

## Running locally

Any static file server works. ES modules don't load from `file://`, so you need one:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

`npx serve .` also works. The page needs internet access once to fetch Three.js and the fonts.

## What it does

### The machine
A VMC-560 style vertical machining centre built from separate components:

- **Base, column, saddle (Y), table (X) and spindle head (Z).** Each axis is its own moving assembly.
- **Linear rails and ball screws.** The screws turn in step with axis motion, at a 10 mm lead.
- **Telescopic way covers** that collapse and extend as the saddle moves.
- **T-slot table** with a machine vise, parallels and the stock.
- **Spindle head** with motor, coolant ring and three Loc-Line coolant hoses aimed at the cutter.
- **Umbrella tool changer** with 16 pockets holding procedurally modelled tools and BT40 holders.
- **Enclosure** with glass windows and two sliding doors, an internal LED light bar, a stack light and the operator pendant.

The pendant has a live screen. Its E-stop, Cycle Start and Feed Hold buttons, and the door handles, can all be clicked in the 3D view.

Machine travel is X 560, Y 410, Z 410 mm. Following Fanuc/Haas convention, home is X0 Y0 Z0 and all travel is negative. Rapids run at 24 m/min (Z at 18 m/min) on a trapezoidal acceleration profile. The spindle maxes out at 12,000 rpm and ramps up and down at a finite rate.

### G-code interpreter
`src/gcode/interpreter.js` compiles a program into timed operations, the way a control's graphics/verify mode does, and the controller then executes them block by block in simulated time. Supported:

| Group | Codes |
|---|---|
| Motion | G00, G01, G02, G03 (I/J/K or R; helical when the third axis changes) |
| Planes, units, distance | G17, G18, G19, G20, G21, G90, G91, G90.1, G91.1 |
| Offsets | G54–G59, G10 L2 (set work offset), G43 H_ / G49 tool length, G40, G53 machine-coordinate moves |
| Return / dwell | G28 (via an intermediate point), G04 (P in seconds or ms, or X) |
| Drilling cycles | G81, G82, G83, G73, G80, G98, G99, repeat count L |
| Other modal codes | G94 feed per minute. G61/G64 are accepted, but the path is always followed exactly |
| M-codes | M00, M01, M02, M03, M04, M05, M06, M07, M08, M09, M30 |
| Words | N, O, comments in `( )` or after `;`, `%`, block delete `/` |

Anything else is rejected with an explanation, never silently ignored. That includes G41/G42 cutter compensation, G92, G95, M98 subprograms, tapping and boring cycles, and A/B/C axes. The Reference tab is generated from the interpreter's own code table, so it always matches what is really supported.

The interpreter reports:

- Syntax errors, with column positions that are underlined in the editor.
- Modal group conflicts.
- Missing feed rate, spindle speed or tool.
- Arcs whose end point is not on the circle, or whose R value is too small.
- Unknown tools and offsets.
- Over-travel, checked for every point of every move, arcs included.
- Warnings, for example a G43 H number that doesn't match the tool in the spindle, or blocks after M30.

Execution supports Cycle Start, Feed Hold, Stop, Reset, single block, Step, M00/M01 with the Optional Stop switch, feed/rapid/spindle overrides and a simulation speed from 0.25× to 100×, plus MAX. MAX runs as fast as the CPU allows while the page stays responsive. The editor highlights the executing line, and the progress bar and remaining time come from the compiled cycle-time estimate. The test runs below show that estimate matches the simulated machine time.

### Material removal
`src/sim/zmap.js` models the stock as a **Z-map**: a dense grid of material heights over the stock footprint. On a 3-axis machine with vertical cutters an undercut is impossible, so a heightfield represents the machined part exactly, up to the grid resolution. For every motion segment the cutter is swept along its path:

- **Flat end mills, face mills, bull nose, ball nose, drills, spot drills and chamfer mills** all have their exact profile. A ball cuts a cusp and a drill leaves a 118° cone.
- **Ramps and helices** are handled exactly. For each grid node the solver finds the part of the segment where that node is under the cutter, then the lowest point of the cutter envelope over that interval.
- **Only changed areas are re-meshed.** The stock is drawn as tiles, and only the tiles the cut touched are rebuilt. Machined surfaces get feed marks, and through-holes are cut out.

Accuracy presets in Setup set the grid (from about 0.6 mm to 0.15 mm, up to 800,000 nodes) and the arc chord tolerance.

Facing, pockets, slots, drilling, contours, multiple depth passes and 3D ball-nose surfaces all leave real geometry. You can measure that geometry with the Measure tool.

### Collisions and limits
The following raise an alarm and stop the machine:

- A rapid move into material.
- Feeding into the part with the spindle stopped.
- Cutting deeper than the flute length, so the shank rubs the part.
- The tool holder or spindle nose hitting the part.
- The cutter, holder or spindle hitting the vise.
- Hitting the table.

The alarm message names the block and, where it helps, the likely cause. For example, a missing G43 means Z positions refer to the gauge line. Programmed over-travel is caught before the program starts, and jogging respects soft limits.

### Cutting physics (simplified models)
- **Spindle load** comes from the actual material removal rate times the specific cutting force of the material, against an 11 kW spindle.
- **Cutting data.** Surface speed and chip load are shown live while cutting.
- **Spindle temperature** follows speed and load, and coolant pulls it down.
- **Tool wear** builds up with the volume removed. It is weighted by how abrasive the material is, whether you cut dry, and whether you exceed the recommended cutting speed. Replace a tool in the Tools tab to reset it. Wear is informational and does not change the cut geometry.
- **Materials.** Aluminium 6061, steel 1045, brass C360 and acetal (POM). The material changes the colour, mass, cutting force, chips, wear rate and sound, and sparks appear only for fast dry cutting of steel.

### Interface
- **Left panel:** the DRO (work, machine and distance-to-go coordinates), spindle, feed, tool, coolant, temperature, active modal codes and workpiece statistics. The Manual tab has jog controls (incremental or continuous, also from the keyboard), manual spindle and coolant, overrides, tool change, homing, "go to work zero", touch-off for X0/Y0/Z0 and MDI.
- **Centre:** the 3D view. It has view presets (iso, front, side, top, work close-up, whole machine) and toggles for the enclosure, doors, lights, way covers, toolpath preview and measuring. You can orbit, pan and zoom.
- **Right panel:**
  - Program: a syntax-highlighted editor with line numbers, error markers and the current line. You can import `.nc`/`.tap`/`.gcode` files by picking them or dragging them onto the viewport, and export the program.
  - Tools: an editable tool library with a profile preview and suggested speeds and feeds.
  - Setup: stock size, material, work offsets, accuracy and options.
  - Log and Reference.
- **Bottom bar:** run controls, simulation speed, progress and a big E-stop.
- **Setup wizard:** walks through material, stock and clamping height, part zero (touch-off into any of G54–G59) and the tool list.

Panels can be resized by dragging the dividers; double-click a divider to reset it. On narrow screens the layout switches to a stacked view with tabs. Settings, tools, offsets and the program are stored in `localStorage`.

### Example programs
The examples are generated by small CAM routines (`src/gcode/examples.js`) and written out the way a Fanuc/Haas post-processor would write them. Each one sets up its own stock and G54:

1. **Simple facing:** a 50 mm face mill, two 0.5 mm passes.
2. **Rectangular pocket:** ramp entry, roughing rings in three depth steps, then a finish pass with corner arcs.
3. **Circular pocket:** G03 helical entry, spiral-out rings and a tangent-arc finish pass, in brass.
4. **Drilling pattern:** a spot drill and a peck drill in steel using G81, G82, G83 and G73 with G98/G99.
5. **Slot milling:** straight slots, an R50 arc slot and an incremental (G91) keyway, in acetal.
6. **Complex contour:** a bracket outside profile with tangent arcs and a concave notch, roughed and finished.
7. **Complete part:** face, pocket, spot, drill and chamfer, with five automatic tool changes.
8. **3D surface:** a flat end mill roughing raster, then a ball-nose finishing raster over a sculpted dome (about 8,700 lines).

## Controls

| Action | Input |
|---|---|
| Cycle start / feed hold | Space, or the buttons (also on the 3D pendant) |
| Step one block | S |
| Stop / leave measure mode | Esc |
| Jog X / Y | Arrow keys (step from the Manual tab; "Cont." jogs while held) |
| Jog Z | Page Up / Page Down |
| Views | 1 iso · 2 front · 3 side · 4 top · 5 work · 6 machine |
| Orbit / pan / zoom | Drag · right-drag or Shift-drag · wheel (touch: drag, two-finger drag, pinch) |

## Conventions you need to know

- **Work offsets** (G54–G59) store the machine coordinates of the part zero. For Z, that is the machine Z of the spindle gauge line when the tool tip touches the zero, minus the tool length. Loading an example, "Set from stock" and the wizard all compute this for you.
- **Tool length.** With **Require G43** on (the default, as on a Fanuc or Haas control), Z positions refer to the gauge line until `G43 H_` is active. A program that forgets G43 will crash into the part, and the alarm says why. Turn the option off and the active tool's length is applied automatically.
- **Units.** Numbers without a decimal point are whole units: `X10` is 10 mm, not 10 µm.
- **Reset after a program.** Cycle Start never resets the stock. Press **Reset** to rewind and load a fresh blank.

## Limitations

- **No cutter radius compensation (G41/G42).** Programs must be posted as tool-centre paths, which is the CAM default "in computer" setting. G41/G42 are rejected, not silently ignored.
- **No subprograms, macros, tapping or boring cycles, G92 or feed-per-rev.**
- **Corners are not blended.** Feed moves run at constant speed with no corner blending (G64) or look-ahead deceleration. Rapids use trapezoidal acceleration.
- **Grid resolution.** The Z-map resolves to the selected grid. Very small features (under about 2 cells) are approximated, and volumes carry roughly 1% sampling error at the walls.
- **Collision checks.** The cutter, holder and spindle are checked against the stock, the vise and the table. The rest of the head and the chips are not.
- **Spindle load, temperature and tool wear are simplified models** meant to teach the trends. They are not calibrated predictions.
- **Rendering.** Chips, coolant and sparks are visual particles. The spindle's on-screen rotation is slowed down above a few revolutions per second to avoid strobing, and a blur sleeve shows the real speed.

## Code layout

| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Layout and the dark graphite theme |
| `src/main.js` | App wiring: material removal and collision checks per motion segment, cutting physics, measuring, frame loop, persistence |
| `src/config.js` | Machine geometry and limits, materials, default tools, accuracy presets, tool changer timing |
| `src/gcode/parser.js` | Tokenizer with column-accurate errors, plus the syntax highlighter |
| `src/gcode/interpreter.js` | Modal state machine that compiles programs to timed ops: arcs, cycles, offsets, limits |
| `src/gcode/codes.js` | Supported and unsupported code table (also feeds the Reference tab) |
| `src/gcode/examples.js` | CAM-style generators for the example programs |
| `src/sim/controller.js` | Runtime: run/hold/step/single block, trapezoidal rapids, tool change sequence, homing, jog, MDI, interlocks, alarms |
| `src/sim/zmap.js` | Z-map material removal and height queries |
| `src/sim/tooling.js` | Cutter profiles and holder dimensions |
| `src/scene/machine.js` | The machine model and its animation |
| `src/scene/toolmodels.js` | Fluted cutters, face mills and BT40 holders |
| `src/scene/stockmesh.js` | Tiled, incrementally updated stock mesh |
| `src/scene/workholding.js` | Vise, parallels, stock placement, work-zero marker |
| `src/scene/toolpath.js` | Toolpath preview shader (rapids dashed, executed segments dimmed, x-ray pass) |
| `src/scene/effects.js` | Chips, coolant, sparks, spindle blur |
| `src/scene/viewer.js` | Renderer, lighting, camera presets, picking, axis gizmo |
| `src/audio/sound.js` | Synthesised spindle, cutting, servo, coolant and tool changer sounds |
| `src/ui/ui.js`, `src/ui/editor.js` | Panels, tool library, setup, wizard and the G-code editor |
