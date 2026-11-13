# Gold Rush

A 3D treasure-hunting game for the browser. You dig through huge procedurally generated rubbish piles for buried gold, sell your finds at the refinery, and buy better equipment to reach rarer treasure in harder areas.

**Play:** https://aislopai7432.github.io/3d-model-/ (GitHub Pages, served from this branch)

Everything is generated at runtime: rubbish geometry, textures, treasure models and sound. There are no asset files. Three.js 0.160 loads from jsDelivr through an import map, and progress is saved in the browser's `localStorage`.

## How to play

1. **Search.** The rubbish piles are made of thousands of individual items in layered stacks. The metal detector follows your cursor and beeps faster and louder as it nears metal. Each metal has its own pitch: iron grunts low, gold sits in the middle and silver rings high. Junk metal (cans, iron scrap) also sets it off, so better detectors filter it out.
2. **Dig.** Click to clear the top piece of rubbish, or hold to keep digging. Once a spot is bare, you can dig into the soil, where some treasure is buried deeper.
3. **Collect.** Anything that glints can be clicked and collected. Finds range from 20 mg gold flakes to kilo bars and ancient artefacts.
4. **Sell.** At the Aurum Refinery, your finds drop onto a digital scale that weighs them and counts up the payout. Scrap metal is paid at 92% of melt value (weight × purity × today's price). Coins, gems and antiques sell at their appraised value.
5. **Upgrade.** Prospector Supply sells detectors, digging tools, bags and gear. Every upgrade changes how the game plays.
6. **Progress.** You earn XP, levels and achievements, and unlock five search areas, from the Local Dump to the Forgotten Treasure Site.

### Controls

| Action | Mouse / keyboard | Touch |
|---|---|---|
| Look around | Drag | One-finger drag |
| Zoom | Scroll | Pinch |
| Move | Right-drag, WASD or arrow keys | Two-finger drag |
| Rotate | Q / E | |
| Dig or collect | Click; hold to keep digging; Space | Tap; hold |
| Detector on/off, light, scanner | T, L, F | Tool belt |
| Bag, refinery, shop, map, menu | I, R, B, M, Esc | Dock |

On touch screens, the detector reads at the centre of the view.

## What upgrades change

| Equipment | Effect in game |
|---|---|
| Detectors (5 tiers) | Detection range, depth, smallest detectable mass, metal identification (tone only → ferrous/non-ferrous → full metal ID and depth), iron/aluminium rejection, and a pinpoint compass on the Elite |
| Digging tools (5 tiers) | Area cleared per stroke, stroke time, layers per stroke, soil per stroke; the Sorting Rig also auto-sifts small finds |
| Bags (5 tiers) | How many finds you can carry before you need to sell |
| Loupe | Wider pick-up reach for tiny flakes; shows weight and value on hover |
| Gloves / hazmat suit | Faster digging; the suit is required for the Old Landfill |
| Search light | Light that follows the detector head and makes gold glint more often; required for the dark Electronics Facility |
| Riddle sieve | Automatically collects flakes and fragments as you dig through them |
| Gold pulse scanner | Marks gold and gems within 4 m for a few seconds (20 s recharge) |

## Code layout

| File | Purpose |
|---|---|
| `index.html` | Page shell, HUD, panels and styles |
| `src/main.js` | Game loop, input, camera, digging, collecting, refinery and shop actions, objectives, saving |
| `src/config.js` | All tunable data: economy, treasure catalogue, equipment, areas, XP curve, achievements |
| `src/pile.js` | Pile generation, instanced rendering of the drawn layers, heightfield picking, digging, soil craters, exposure, save state |
| `src/junk.js` | Procedural rubbish geometry (cans, bottles, boxes, bags, clothes, tyres, electronics, machinery, rubble, pottery and more) |
| `src/textures.js` | Texture atlas (colour, normal, roughness/metalness), ground, signs, studio environment |
| `src/treasure.js` | Rolling finds, valuation, and real-scale treasure models |
| `src/detector.js` | Signal model, discrimination, metal ID, coil and pinpoint visuals |
| `src/world.js` | Sky, lighting, ground and set dressing for each area; huts, fences, cranes, ruins, gulls |
| `src/buyer.js` | The refinery interior and its digital weighing scale |
| `src/ui.js` | HUD, bag, shop, map, menu, refinery list, toasts and inspect modal |
| `src/thumbs.js` | Offscreen renderer for inventory thumbnails and the 3D inspect preview |
| `src/fx.js`, `src/audio.js` | Particles and synthesised sound |
| `src/state.js` | Player state, saving, levels and achievements |

### Performance notes

- **Rendering:** rubbish is drawn with one shared material and one `InstancedMesh` per geometry variant. Only the top four layers of each stack are drawn, packed densely into the instance buffers, and deeper items are swapped in as you dig. A "compacted rubbish" surface fills any gaps underneath.
- **Picking:** hover and dig targets come from ray-marching the cell heightfield, not from raycasting thousands of instances.
- **Detector:** the detector only checks the cells within its range.
- **Quality:** High adds ambient occlusion (GTAO), 2048 px shadows and full resolution. Phones default to Balanced, and resolution drops automatically if the frame rate falls.

## Run locally

Serve the folder with any static server, for example `python3 -m http.server`, then open `http://localhost:8000`.
