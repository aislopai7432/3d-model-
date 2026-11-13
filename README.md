# Aeris Strata GT — procedural car configurator

A mid-engine sports car modelled entirely in code with Three.js, shown in a dark
photography-studio scene with a configurator UI. No 3D model files or images are
loaded: every surface, texture and light is generated at runtime.

## Live page

https://aislopai7432.github.io/3d-model-/ (served by GitHub Pages from this branch)

## Run it

Any static file server works, for example:

```sh
npx serve .
# or
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Three.js 0.160 is loaded from jsDelivr through an import map.

## Project layout

| File | What it does |
|---|---|
| `index.html` | Page, configurator UI and styles, import map |
| `src/main.js` | Renderer, post-processing, camera views and transitions, showcase mode, UI wiring, adaptive quality |
| `src/body.js` | The body surface: section curves, longitudinal profiles, end caps, panel layout and wheel-arch trimming |
| `src/car.js` | Builds the car from the body: panels, doors, glass, lamps, aero, mirrors, wipers, badges, interior |
| `src/wheels.js` | Tyres with tread and sidewall lettering, three rim designs, drilled discs, callipers |
| `src/materials.js` | Procedural textures (metal flake, carbon twill, honeycomb, tread, leather) and PBR materials |
| `src/studio.js` | Softbox HDR environment, reflective floor, blurred contact shadow |

## How the body is built

The shell is one lofted surface. Each cross-section is a closed centripetal
Catmull-Rom curve through 12 control points (sill, rocker, widest point,
shoulder, roof edge, roof centre). Those points follow smooth monotone
profile curves along the car's length. The nose and tail are closed by
super-elliptic caps that blend the section into a smooth outline as they
shrink, so section corners don't run into the face.

Panel edges (door shut lines, glass, lamp housings, intakes) are inserted into
the surface grid as exact grid lines. Each panel is cut out cleanly and becomes
its own mesh:

- the doors are solid, hinged panels with door cards and painted jambs;
- the intakes and lamps are recessed with real depth;
- the glass has a black frit border.

Wheel arches are trimmed out of the shell and lined. A sculpted scallop runs
along the lower doors into the side intakes.

## Controls

- Drag to orbit. Scroll or pinch to zoom. Right-drag or two-finger drag to pan.
- **Paint:** 8 colours, plus calliper colour.
- **Wheels:** 3 designs and 4 finishes.
- **Lights:** headlights, brake lights, hazards, ambient cabin lighting.
- **Cabin:** upholstery colour, opening doors, cockpit view.
- **Camera:** 7 preset views with smooth transitions, a 360° showcase mode, reset and full screen.
- **Quality:** High (floor reflections and bloom) or Balanced. The page also steps down on its own if the frame rate drops.
