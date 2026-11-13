// All tunable game data lives here: economy, treasure catalogue, equipment, areas, achievements.

export const ECONOMY = {
  goldSpotPerGram: 62.4, // £ per gram of pure (24ct) gold
  silverSpotPerGram: 0.78, // £ per gram of pure silver
  buyerMeltRate: 0.92, // the refinery pays 92% of melt value for scrap metal
  priceDrift: 0.035, // ±3.5% slow daily wobble in metal prices
  startingBalance: 0,
};

export const RARITIES = {
  common: { name: 'Common', color: '#b9b4a8', xpMul: 1, sound: 0 },
  uncommon: { name: 'Uncommon', color: '#6fcf7a', xpMul: 1.3, sound: 1 },
  rare: { name: 'Rare', color: '#4ea3ff', xpMul: 1.7, sound: 2 },
  epic: { name: 'Epic', color: '#c070ff', xpMul: 2.3, sound: 3 },
  legendary: { name: 'Legendary', color: '#ffb52e', xpMul: 3.2, sound: 4 },
};
export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

// Treasure kinds.
//  mass: grams [min, max] (skewed towards min), purity: [min, max] fraction or list of fixed values
//  metal: detector response class. pricing: 'melt' (weight × purity × spot × buyer rate),
//  'premium' (melt × multiplier), 'fixed' (appraised value range, × size factor)
export const TREASURES = {
  flake: { name: 'Gold flake', rarity: 'common', metal: 'gold', mass: [0.02, 0.18], purity: [0.88, 0.97], pricing: 'melt', model: 'flake', desc: 'A paper-thin sliver of natural gold, easy to miss among the grit.' },
  silverScrap: { name: 'Silver cutlery scrap', rarity: 'common', metal: 'silver', mass: [6, 22], purity: [0.8, 0.925], pricing: 'melt', model: 'spoon', desc: 'A bent sterling silver spoon. Worth more than it looks.' },
  penny: { name: 'Pre-decimal penny', rarity: 'common', metal: 'copper', mass: [9.4, 9.45], purity: [0.95, 0.95], pricing: 'fixed', value: [0.6, 4], model: 'penny', desc: 'A worn bronze penny from before 1971.' },
  fragment: { name: 'Gold fragment', rarity: 'uncommon', metal: 'gold', mass: [0.25, 1.8], purity: [0.85, 0.97], pricing: 'melt', model: 'fragment', desc: 'A small irregular piece of gold, still bright under the dirt.' },
  chain: { name: 'Broken gold chain', rarity: 'uncommon', metal: 'gold', mass: [1.5, 6], purity: [0.375, 0.585, 0.75], pricing: 'melt', model: 'chain', desc: 'A snapped necklace chain. Hallmarked, so the carat is easy to read.' },
  sixpence: { name: 'Silver sixpence', rarity: 'uncommon', metal: 'silver', mass: [2.8, 2.83], purity: [0.5, 0.925], pricing: 'fixed', value: [8, 38], model: 'sixpence', desc: 'A pre-1947 silver sixpence. Collectors pay a premium.' },
  goldPins: { name: 'Gold-plated processor', rarity: 'uncommon', metal: 'gold', mass: [0.08, 0.4], purity: [0.99, 0.999], pricing: 'fixed', value: [14, 85], model: 'chip', desc: 'A ceramic chip with gold-plated pins, wanted by e-waste refiners.' },
  nugget: { name: 'Gold nugget', rarity: 'rare', metal: 'gold', mass: [3, 18], purity: [0.82, 0.95], pricing: 'premium', premium: 1.3, model: 'nugget', desc: 'A heavy natural nugget. Specimen nuggets fetch more than melt value.' },
  ring18: { name: '18ct gold ring', rarity: 'rare', metal: 'gold', mass: [3, 8], purity: [0.75, 0.75], pricing: 'melt', model: 'ring', desc: 'A heavy 18-carat band, lost long ago.' },
  sovereign: { name: 'Gold sovereign', rarity: 'rare', metal: 'gold', mass: [7.98, 7.99], purity: [0.9167, 0.9167], pricing: 'premium', premium: 1.12, model: 'sovereign', desc: 'A full sovereign coin: 22-carat gold, 7.98 grams.' },
  diamond: { name: 'Loose diamond', rarity: 'rare', metal: 'none', mass: [0.05, 0.2], purity: [1, 1], pricing: 'fixed', value: [300, 2500], model: 'diamond', desc: 'A brilliant-cut diamond, prised from a lost setting.' },
  vintageChip: { name: 'Vintage ceramic CPU', rarity: 'rare', metal: 'gold', mass: [0.5, 1.2], purity: [0.999, 0.999], pricing: 'fixed', value: [140, 620], model: 'chipGold', desc: 'A 1970s gold-capped processor. Collectors and refiners compete for these.' },
  silverWatch: { name: 'Victorian silver watch', rarity: 'rare', metal: 'silver', mass: [70, 110], purity: [0.925, 0.925], pricing: 'fixed', value: [240, 880], model: 'watchSilver', desc: 'A hallmarked silver pocket watch. It still ticks when shaken.' },
  chunk: { name: 'Gold chunk', rarity: 'epic', metal: 'gold', mass: [25, 110], purity: [0.8, 0.94], pricing: 'premium', premium: 1.15, model: 'chunk', desc: 'A fist-sized lump of gold in quartz. Rare anywhere, extraordinary here.' },
  bracelet: { name: '22ct gold bracelet', rarity: 'epic', metal: 'gold', mass: [15, 42], purity: [0.916, 0.916], pricing: 'melt', model: 'bracelet', desc: 'A heavy bangle of deep-yellow 22-carat gold.' },
  gemstone: { name: 'Precious gemstone', rarity: 'epic', metal: 'none', mass: [0.3, 1.0], purity: [1, 1], pricing: 'fixed', value: [1500, 9000], model: 'gem', desc: 'A cut ruby, sapphire or emerald of real quality.' },
  goldWatch: { name: 'Antique gold pocket watch', rarity: 'epic', metal: 'gold', mass: [40, 80], purity: [0.75, 0.75], pricing: 'premium', premium: 1.6, model: 'watchGold', desc: 'An 18ct hunter-case pocket watch with an engraved lid.' },
  bullion: { name: '1 oz gold bullion coin', rarity: 'epic', metal: 'gold', mass: [31.1, 31.11], purity: [0.9999, 0.9999], pricing: 'premium', premium: 1.04, model: 'bullion', desc: 'One troy ounce of fine gold.' },
  bar100: { name: '100 g gold bar', rarity: 'legendary', metal: 'gold', mass: [100, 100.02], purity: [0.9999, 0.9999], pricing: 'melt', model: 'bar100', desc: 'A stamped 100-gram bar of fine gold. Somebody is missing this.' },
  bar1k: { name: '1 kg gold bar', rarity: 'legendary', metal: 'gold', mass: [1000, 1000.1], purity: [0.9999, 0.9999], pricing: 'melt', model: 'bar1k', desc: 'A full kilo bar, serial-numbered. A once-in-a-career find.' },
  torc: { name: 'Iron Age gold torc', rarity: 'legendary', metal: 'gold', mass: [300, 900], purity: [0.88, 0.92], pricing: 'premium', premium: 2.6, model: 'torc', desc: 'A twisted neck ring worn by a chieftain two thousand years ago.' },
  brooch: { name: 'Saxon garnet brooch', rarity: 'legendary', metal: 'gold', mass: [40, 120], purity: [0.85, 0.9], pricing: 'fixed', value: [25000, 80000], model: 'brooch', desc: 'Gold cloisonné inlaid with garnets. Museum quality.' },
  bigDiamond: { name: 'Flawless large diamond', rarity: 'legendary', metal: 'none', mass: [1.0, 2.4], purity: [1, 1], pricing: 'fixed', value: [60000, 300000], model: 'bigDiamond', desc: 'A flawless stone of several carats. It throws light everywhere.' },
  mask: { name: 'Golden funerary mask', rarity: 'legendary', metal: 'gold', mass: [1200, 2000], purity: [0.9, 0.95], pricing: 'premium', premium: 3.2, model: 'mask', desc: 'Hammered gold, a calm face, unknown origin. It should not be here.' },
};

// ---- Equipment -----------------------------------------------------------------
// Detector: radius (m) of the search head's reach, depth (m), minMass (g) smallest detectable target,
// id: 0 tone only, 1 ferrous/non-ferrous, 2 full metal ID, notch: can reject iron (1) and also aluminium (2),
// pinpoint: shows an arrow towards the strongest target.
export const DETECTORS = [
  { id: 'det1', name: 'Basic Detector', short: 'Basic', price: 0, level: 1, radius: 0.85, depth: 0.32, minMass: 0.5, idLevel: 0, notch: 0, pinpoint: false, desc: 'A second-hand beginner detector. Loud, simple, short range.' },
  { id: 'det2', name: 'Intermediate Detector', short: 'Intermediate', price: 450, level: 2, radius: 1.1, depth: 0.55, minMass: 0.2, idLevel: 1, notch: 1, pinpoint: false, desc: 'Better coil and an iron-reject switch to ignore rusty junk.' },
  { id: 'det3', name: 'Professional Detector', short: 'Professional', price: 2600, level: 3, radius: 1.35, depth: 0.85, minMass: 0.05, idLevel: 2, notch: 1, pinpoint: false, desc: 'High-frequency gold detector. Picks up small fragments and reads metal type and depth.' },
  { id: 'det4', name: 'Advanced Detector', short: 'Advanced', price: 12500, level: 4, radius: 1.8, depth: 1.35, minMass: 0.03, idLevel: 2, notch: 2, pinpoint: false, desc: 'Large double-D coil. Deep ground penetration and an aluminium notch filter.' },
  { id: 'det5', name: 'Elite Detector', short: 'Elite', price: 62000, level: 5, radius: 2.4, depth: 2.2, minMass: 0.012, idLevel: 2, notch: 2, pinpoint: true, desc: 'Multi-frequency research instrument with a pinpoint compass to the strongest target.' },
];

// Digging tools: radius (m) cleared per dig, time (s) per dig, layers removed per dig, soil (m) dug per stroke, sift: auto-collects small finds
export const DIGGERS = [
  { id: 'dig1', name: 'Hand Trowel', short: 'Trowel', price: 0, level: 1, radius: 0.2, time: 0.85, layers: 1, soil: 0.05, sift: false, desc: 'A bent garden trowel. It does the job, slowly.' },
  { id: 'dig2', name: 'Digging Shovel', short: 'Shovel', price: 320, level: 2, radius: 0.3, time: 0.62, layers: 1, soil: 0.08, sift: false, desc: 'A proper steel shovel. Faster strokes, bigger scoops.' },
  { id: 'dig3', name: 'Hand Rake', short: 'Rake', price: 1150, level: 3, radius: 0.46, time: 0.55, layers: 1, soil: 0.08, sift: false, desc: 'A wide tined rake that drags a broad area clear in one pull.' },
  { id: 'dig4', name: 'Precision Excavation Kit', short: 'Excavation kit', price: 5800, level: 4, radius: 0.46, time: 0.38, layers: 2, soil: 0.12, sift: false, desc: 'Archaeologist-grade tools: two layers per stroke and fast soil work.' },
  { id: 'dig5', name: 'Industrial Sorting Rig', short: 'Sorting rig', price: 42000, level: 5, radius: 0.78, time: 0.42, layers: 2, soil: 0.16, sift: true, desc: 'A motorised grab-and-screen rig. Clears huge areas and sifts out small finds automatically.' },
];

export const BAGS = [
  { id: 'bag1', name: 'Belt Pouch', short: 'Pouch', price: 0, level: 1, capacity: 10, desc: 'A small leather pouch. Ten finds and it is full.' },
  { id: 'bag2', name: 'Canvas Satchel', short: 'Satchel', price: 160, level: 2, capacity: 24, desc: 'A sturdy canvas bag with padded pockets.' },
  { id: 'bag3', name: 'Field Backpack', short: 'Backpack', price: 1300, level: 3, capacity: 50, desc: 'A prospector backpack with sample tubes.' },
  { id: 'bag4', name: 'Secure Sample Case', short: 'Sample case', price: 8200, level: 4, capacity: 120, desc: 'A foam-lined lockable case for serious hauls.' },
  { id: 'bag5', name: 'Armoured Vault Trolley', short: 'Vault trolley', price: 31000, level: 5, capacity: 300, desc: 'A wheeled steel vault. You will not run out of room.' },
];

// Single-purchase gear with direct gameplay effects.
export const GEAR = [
  { id: 'magnifier', name: 'Jeweller’s Loupe', price: 260, level: 1, desc: 'Inspect finds before you pick them up, and pick tiny flakes from a wider area.', stats: [['Pick-up reach', '6 cm', '15 cm'], ['Shows weight and purity on hover', 'No', 'Yes']] },
  { id: 'gloves', name: 'Cut-Proof Work Gloves', price: 420, level: 1, desc: 'Grab sharp scrap without hesitating.', stats: [['Dig speed', '100%', '115%']] },
  { id: 'light', name: 'Portable Search Light', price: 650, level: 1, desc: 'A battery LED flood that follows your search head. Gold glints more often under it. Needed for the dark electronics facility.', stats: [['Light around the search head', 'None', '6 m beam'], ['Gold glint frequency', '×1', '×2.5']] },
  { id: 'sieve', name: 'Riddle Sieve Set', price: 3600, level: 2, desc: 'Every scoop is shaken through a sieve: flakes and fragments in cleared rubbish are collected automatically.', stats: [['Auto-collect small finds', 'No', 'Yes']] },
  { id: 'suit', name: 'Hazmat Suit & Steel Boots', price: 6400, level: 2, desc: 'Full protection for contaminated ground. Required for the Old Landfill.', stats: [['Dig speed', '115%', '135%'], ['Landfill access', 'No', 'Yes']] },
  { id: 'scanner', name: 'Gold Pulse Scanner', price: 21000, level: 3, desc: 'Press to send a ground-penetrating pulse that marks gold and gems within 4 m for a few seconds. 20 s recharge.', stats: [['Reveal radius', '—', '4 m'], ['Recharge', '—', '20 s']] },
];

// ---- Areas -----------------------------------------------------------------------
// junk weights refer to keys in junk.js. rarity weights decide the mix of treasure.
export const AREAS = [
  {
    id: 'dump', name: 'The Local Dump', blurb: 'Household rubbish, a few lost rings and plenty of flakes. Learn the ropes here.',
    unlock: { price: 0, level: 1 },
    pile: { radius: 6.0, maxLayers: 12, mounds: 3 },
    treasures: { count: 34, soilShare: 0.12, weights: { common: 64, uncommon: 29, rare: 6, epic: 0.8, legendary: 0 } },
    kinds: ['flake', 'silverScrap', 'penny', 'fragment', 'chain', 'sixpence', 'nugget', 'ring18', 'sovereign', 'diamond', 'bracelet', 'goldWatch'],
    junk: { can: 5, bottle: 10, box: 8, sheet: 8, paper: 9, bag: 11, clothes: 8, packaging: 10, toy: 5, wood: 6, household: 4, glass: 4, tyre: 1, electronics: 1.5, scrap: 1.2, furniture: 2 },
    look: 'dump',
  },
  {
    id: 'scrapyard', name: 'Industrial Scrap Yard', blurb: 'Tonnes of iron that set off every cheap detector. Better finds for those with iron reject.',
    unlock: { price: 1500, level: 3 },
    pile: { radius: 6.2, maxLayers: 14, mounds: 4 },
    treasures: { count: 42, soilShare: 0.15, weights: { common: 46, uncommon: 35, rare: 15, epic: 3.6, legendary: 0.35 } },
    kinds: ['flake', 'silverScrap', 'fragment', 'chain', 'nugget', 'ring18', 'sovereign', 'diamond', 'silverWatch', 'chunk', 'bracelet', 'bullion', 'goldWatch', 'bar100'],
    junk: { scrap: 16, machinery: 9, can: 6, tyre: 2.2, wood: 6, sheet: 4, furniture: 4, electronics: 4, household: 4, bottle: 3, bag: 3, packaging: 2, glass: 2 },
    look: 'scrapyard',
  },
  {
    id: 'facility', name: 'Abandoned Electronics Facility', blurb: 'A dark hall of dead electronics. Gold pins, vintage chips and collectables. Bring a light.',
    unlock: { price: 8500, level: 6, gear: 'light' },
    pile: { radius: 5.8, maxLayers: 13, mounds: 4 },
    treasures: { count: 52, soilShare: 0.05, weights: { common: 36, uncommon: 38, rare: 18, epic: 6.5, legendary: 0.8 } },
    kinds: ['flake', 'fragment', 'goldPins', 'vintageChip', 'chain', 'nugget', 'diamond', 'silverWatch', 'ring18', 'chunk', 'gemstone', 'bullion', 'goldWatch', 'bar100'],
    junk: { electronics: 22, monitor: 7, cables: 9, pcb: 12, box: 6, sheet: 4, scrap: 4, packaging: 4, bag: 3, can: 2, furniture: 3 },
    look: 'facility',
  },
  {
    id: 'landfill', name: 'The Old Landfill', blurb: 'Decades of buried waste in huge mounds. Deep finds for deep detectors. Protective suit required.',
    unlock: { price: 36000, level: 10, gear: 'suit' },
    pile: { radius: 6.6, maxLayers: 22, mounds: 5 },
    treasures: { count: 62, soilShare: 0.28, weights: { common: 30, uncommon: 33, rare: 23, epic: 11, legendary: 2.2 } },
    kinds: ['flake', 'fragment', 'chain', 'penny', 'sixpence', 'nugget', 'ring18', 'sovereign', 'diamond', 'silverWatch', 'chunk', 'bracelet', 'gemstone', 'goldWatch', 'bullion', 'bar100', 'bar1k', 'brooch'],
    junk: { bag: 14, paper: 8, sheet: 6, bottle: 8, can: 7, clothes: 8, packaging: 7, box: 5, tyre: 3, household: 5, wood: 5, glass: 4, scrap: 4, electronics: 3, furniture: 3, toy: 3 },
    look: 'landfill',
  },
  {
    id: 'forgotten', name: 'The Forgotten Treasure Site', blurb: 'Rubble over an ancient hoard. Legendary finds lie deep. Advanced detector required.',
    unlock: { price: 160000, level: 15, detector: 'det4' },
    pile: { radius: 6.4, maxLayers: 16, mounds: 4 },
    treasures: { count: 64, soilShare: 0.42, weights: { common: 18, uncommon: 30, rare: 28, epic: 17, legendary: 5 } },
    kinds: ['flake', 'fragment', 'nugget', 'sovereign', 'diamond', 'chunk', 'bracelet', 'gemstone', 'goldWatch', 'bullion', 'bar100', 'bar1k', 'torc', 'brooch', 'bigDiamond', 'mask'],
    junk: { rubble: 22, pottery: 12, wood: 8, rustiron: 10, scrap: 3, sheet: 2, bag: 2, clothes: 4 },
    look: 'forgotten',
  },
];

// ---- Progression ----------------------------------------------------------------
export const xpForLevel = (lvl) => Math.round(160 * Math.pow(lvl - 1, 1.75)); // total XP needed to reach a level
export const xpForFind = (value, rarity) => Math.round((6 + 2.6 * Math.sqrt(value)) * RARITIES[rarity].xpMul);
export const xpForSale = (value) => Math.round(2 + 0.9 * Math.sqrt(value));

export const ACHIEVEMENTS = [
  { id: 'firstGold', name: 'First Gold Found', desc: 'Find your first piece of gold.' },
  { id: 'firstSale', name: 'First Sale', desc: 'Sell something at the refinery.' },
  { id: 'g10', name: '10 Grams Collected', desc: 'Collect 10 g of gold in total.' },
  { id: 'g100', name: '100 Grams Collected', desc: 'Collect 100 g of gold in total.' },
  { id: 'g1000', name: 'Kilo Club', desc: 'Collect 1 kg of gold in total.' },
  { id: 'firstNugget', name: 'First Gold Nugget', desc: 'Find a gold nugget.' },
  { id: 'firstDiamond', name: 'Ice Cold', desc: 'Find a diamond.' },
  { id: 'firstBar', name: 'First Gold Bar', desc: 'Find a gold bar.' },
  { id: 'firstLegendary', name: 'First Legendary Treasure', desc: 'Find a legendary treasure.' },
  { id: 'coins10', name: 'Numismatist', desc: 'Find 10 coins.' },
  { id: 'e1k', name: '£1,000 Earned', desc: 'Earn £1,000 in total.' },
  { id: 'e10k', name: '£10,000 Earned', desc: 'Earn £10,000 in total.' },
  { id: 'e100k', name: '£100,000 Earned', desc: 'Earn £100,000 in total.' },
  { id: 'millionaire', name: 'Millionaire', desc: 'Earn £1,000,000 in total.' },
  { id: 'dig1000', name: 'Rubbish Removal', desc: 'Move 1,000 pieces of rubbish.' },
  { id: 'pileCleared', name: 'Clean Sweep', desc: 'Clear 90% of a rubbish pile.' },
  { id: 'eliteDetector', name: 'Top of the Range', desc: 'Own the Elite Detector.' },
  { id: 'allAreas', name: 'Every Corner', desc: 'Unlock all five search areas.' },
  { id: 'hour', name: 'Dedicated Prospector', desc: 'Spend an hour searching.' },
];

export const COIN_KINDS = new Set(['penny', 'sixpence', 'sovereign', 'bullion']);
