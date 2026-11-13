// Player progression and persistence.
import { ECONOMY, DETECTORS, DIGGERS, BAGS, GEAR, AREAS, ACHIEVEMENTS, xpForLevel, COIN_KINDS, TREASURES } from './config.js';
import { fineGold } from './treasure.js';

const KEY = 'goldrush.save.v1';

export function defaultState() {
  return {
    version: 1,
    created: Date.now(),
    balance: ECONOMY.startingBalance,
    xp: 0,
    level: 1,
    inventory: [],
    owned: { det: ['det1'], dig: ['dig1'], bag: ['bag1'], gear: [] },
    equipped: { det: 'det1', dig: 'dig1', bag: 'bag1' },
    toggles: { detector: true, light: true, ironReject: false, alReject: false },
    areasUnlocked: ['dump'],
    currentArea: 'dump',
    piles: {},
    pileCounter: {},
    stats: { goldGrams: 0, fineGoldGrams: 0, goldSoldGrams: 0, earned: 0, treasures: 0, rubbish: 0, searchTime: 0, itemsSold: 0, coins: 0, best: null, byRarity: {} },
    achievements: {},
    sales: [],
    settings: { volume: 0.8, detVolume: 0.7, quality: 'auto', hints: true },
    tutorial: {},
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const s = JSON.parse(raw);
    const d = defaultState();
    // shallow-merge so new fields added in later versions get defaults
    const merged = { ...d, ...s, owned: { ...d.owned, ...s.owned }, equipped: { ...d.equipped, ...s.equipped }, toggles: { ...d.toggles, ...s.toggles }, stats: { ...d.stats, ...s.stats }, settings: { ...d.settings, ...s.settings } };
    if (!AREAS.find((a) => a.id === merged.currentArea)) merged.currentArea = 'dump';
    merged.level = levelForXp(merged.xp || 0);
    if (!merged.areasUnlocked.includes(merged.currentArea)) merged.currentArea = 'dump';
    return merged;
  } catch {
    return defaultState();
  }
}

export function saveState(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}
export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export const detector = (s) => DETECTORS.find((d) => d.id === s.equipped.det) || DETECTORS[0];
export const digger = (s) => DIGGERS.find((d) => d.id === s.equipped.dig) || DIGGERS[0];
export const bag = (s) => BAGS.find((d) => d.id === s.equipped.bag) || BAGS[0];
export const hasGear = (s, id) => s.owned.gear.includes(id);
export const capacity = (s) => bag(s).capacity;
export const digTime = (s) => {
  let t = digger(s).time;
  if (hasGear(s, 'suit')) t /= 1.35;
  else if (hasGear(s, 'gloves')) t /= 1.15;
  return t;
};
export const pickReach = (s) => (hasGear(s, 'magnifier') ? 0.15 : 0.06);

export function levelForXp(xp) {
  let l = 1;
  while (xp >= xpForLevel(l + 1)) l++;
  return l;
}

// returns number of levels gained
export function addXp(s, n) {
  s.xp += n;
  const before = s.level;
  s.level = levelForXp(s.xp);
  return s.level - before;
}

export function areaLocked(s, area) {
  if (s.areasUnlocked.includes(area.id)) return null;
  const u = area.unlock;
  const reasons = [];
  if (s.level < u.level) reasons.push(`Reach level ${u.level}`);
  if (u.gear && !hasGear(s, u.gear)) reasons.push(`Own the ${GEAR.find((g) => g.id === u.gear).name}`);
  if (u.detector && !s.owned.det.includes(u.detector) && !s.owned.det.some((d) => DETECTORS.findIndex((x) => x.id === d) >= DETECTORS.findIndex((x) => x.id === u.detector))) reasons.push(`Own the ${DETECTORS.find((d) => d.id === u.detector).name}`);
  return { price: u.price, reasons, canBuy: !reasons.length && s.balance >= u.price };
}

export function recordFind(s, item) {
  s.stats.treasures++;
  s.stats.byRarity[item.rarity] = (s.stats.byRarity[item.rarity] || 0) + 1;
  if (item.metal === 'gold') { s.stats.goldGrams += item.mass; s.stats.fineGoldGrams += fineGold(item); }
  if (COIN_KINDS.has(item.kind)) s.stats.coins++;
}

// Evaluate achievements; returns the newly unlocked definitions.
export function checkAchievements(s, ctx = {}) {
  const got = [];
  const give = (id) => { if (!s.achievements[id]) { s.achievements[id] = Date.now(); got.push(ACHIEVEMENTS.find((a) => a.id === id)); } };
  const st = s.stats;
  const kinds = new Set([...s.inventory.map((i) => i.kind), ...(ctx.kind ? [ctx.kind] : [])]);
  if (st.goldGrams > 0) give('firstGold');
  if (st.itemsSold > 0) give('firstSale');
  if (st.goldGrams >= 10) give('g10');
  if (st.goldGrams >= 100) give('g100');
  if (st.goldGrams >= 1000) give('g1000');
  if (kinds.has('nugget') || ctx.everNugget) give('firstNugget');
  if (kinds.has('diamond') || kinds.has('bigDiamond')) give('firstDiamond');
  if (kinds.has('bar100') || kinds.has('bar1k')) give('firstBar');
  if ((st.byRarity.legendary || 0) > 0) give('firstLegendary');
  if (st.coins >= 10) give('coins10');
  if (st.earned >= 1000) give('e1k');
  if (st.earned >= 10000) give('e10k');
  if (st.earned >= 100000) give('e100k');
  if (st.earned >= 1000000) give('millionaire');
  if (st.rubbish >= 1000) give('dig1000');
  if (ctx.cleared >= 0.9) give('pileCleared');
  if (s.owned.det.includes('det5')) give('eliteDetector');
  if (s.areasUnlocked.length >= AREAS.length) give('allAreas');
  if (st.searchTime >= 3600) give('hour');
  return got.filter(Boolean);
}

export function rarityOfKind(kind) {
  return TREASURES[kind].rarity;
}
