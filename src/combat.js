export const emptyCombat = () => ({ entries: [], activeId: null, round: 1 });
export const initiativeOrder = combat => [...(combat?.entries || [])].sort((a, b) => b.initiative - a.initiative);

/**
 * The order the turns really come in this round. Normally that is the initiative order. A combatant who delays steps out of
 * their place and acts right after someone of the same kind (a hero after a hero, a creature after a creature) who comes later
 * in the round (`combat.delays`: [{ tokenId, after }], applied in the order they were made); next round everyone is back in
 * initiative order. Players are sent the finished order (`combat.order`, only the combatants they can see) instead of the
 * delays, so a hidden creature is never named on their screens.
 */
export function turnOrder(combat) {
  const base = initiativeOrder(combat);
  if (Array.isArray(combat?.order)) {
    const byId = new Map(base.map(entry => [entry.tokenId, entry]));
    const ordered = combat.order.map(id => byId.get(id)).filter(Boolean);
    const seen = new Set(ordered.map(entry => entry.tokenId));
    return [...ordered, ...base.filter(entry => !seen.has(entry.tokenId))];
  }
  let order = base;
  for (const { tokenId, after } of combat?.delays ?? []) {
    const mover = order.find(entry => entry.tokenId === tokenId);
    if (!mover || !order.some(entry => entry.tokenId === after)) continue;
    order = order.filter(entry => entry !== mover);
    order.splice(order.findIndex(entry => entry.tokenId === after) + 1, 0, mover);
  }
  return order;
}

/** Ids of the combatants who have delayed their turn this round. */
export const delayedIds = combat => (Array.isArray(combat?.delayed) ? combat.delayed : (combat?.delays ?? []).map(delay => delay.tokenId));
export const tokenKind = token => token.characterType ?? (token.category?.toUpperCase() === 'NPC' ? 'npc' : 'pc');
/**
 * Hero or creature, for a combatant in a fight. Players are never sent a token's type, only a creature's condition in place
 * of its hit points, so on their screens an entry with a condition is a creature; everywhere else the token says.
 */
const entryKind = (entry, token) => (entry.condition !== undefined ? 'npc' : tokenKind(token));
/**
 * Who `tokenId` may delay behind: the combatants that act later this round and are of the same kind. Heroes wait for other
 * heroes, creatures only for other creatures; a hero never waits for a creature or the other way round. Entries, in turn order.
 */
export function delayTargets(combat, tokens, tokenId) {
  const turns = turnOrder(combat);
  const from = turns.findIndex(entry => entry.tokenId === tokenId);
  const mover = (tokens ?? []).find(token => token.id === tokenId);
  if (!mover || from < 0) return [];
  const kind = entryKind(turns[from], mover);
  return turns.slice(from + 1).filter(entry => {
    const other = tokens.find(token => token.id === entry.tokenId);
    return other && entryKind(entry, other) === kind;
  });
}
/**
 * What players are told about a creature instead of numbers (and the colour band of the turn order):
 *   100%  Healthy        up to 75%  Minor injury    up to 50%  Injured
 *   under 50%  Bloodied (50% itself counts as bloodied)   under 25%  Severely injured   10% or less  Critically injured   0  Down
 */
export function healthCondition(entry) {
  if (!entry.maxHp) return 'Unknown';
  if (entry.hp <= 0) return 'Down';
  const remaining = entry.hp / entry.maxHp;
  if (remaining >= 1) return 'Healthy';
  if (remaining > .75) return 'Minor injury';
  if (remaining > .5) return 'Injured';
  if (remaining >= .25) return 'Bloodied';
  if (remaining > .1) return 'Severely injured';
  return 'Critically injured';
}
export const healthLabel = entry => entry.condition ?? (entry.maxHp ? `${entry.hp} / ${entry.maxHp} HP` : 'HP not set');
export const bloodLevel = entry => entry.condition
  ? ({ Healthy: 0, 'Minor injury': .15, Injured: .35, Bloodied: .6, 'Severely injured': .8, 'Critically injured': .95, Down: 1, Unknown: 0 }[entry.condition] ?? 0)
  : entry.maxHp ? 1 - entry.hp / entry.maxHp : 0;

/** A token joining combat starts at full health when it has hit points saved on it (set in the token form). */
export function combatEntryFor(token, initiative) {
  const maxHp = Number.isFinite(token?.maxHp) && token.maxHp > 0 ? Math.floor(token.maxHp) : null;
  return { tokenId: token.id, initiative, hp: maxHp, maxHp };
}

export function normalizeCombat(combat, tokens) {
  const ids = new Set(tokens.map(t => t.id));
  const seen = new Set();
  const entries = (Array.isArray(combat?.entries) ? combat.entries : []).filter(e => {
    if (!ids.has(e.tokenId) || seen.has(e.tokenId) || !Number.isFinite(e.initiative)) return false;
    seen.add(e.tokenId); return true;
  }).map(e => {
    const maxHp = Number.isFinite(e.maxHp) && e.maxHp > 0 ? Math.floor(e.maxHp) : null;
    return { tokenId: e.tokenId, initiative: e.initiative, maxHp,
      hp: maxHp === null ? null : Math.max(0, Math.min(maxHp, Number.isFinite(e.hp) ? Math.floor(e.hp) : maxHp)) };
  });
  // a delay only counts while both combatants are still in the fight, once per hero
  const inFight = new Set(entries.map(e => e.tokenId));
  const taken = new Set();
  const delays = (Array.isArray(combat?.delays) ? combat.delays : []).filter(d => {
    if (!d || !inFight.has(d.tokenId) || !inFight.has(d.after) || d.tokenId === d.after || taken.has(d.tokenId)) return false;
    taken.add(d.tokenId); return true;
  }).map(d => ({ tokenId: d.tokenId, after: d.after }));
  return { entries, activeId: entries.some(e => e.tokenId === combat?.activeId) ? combat.activeId : null,
    round: Number.isInteger(combat?.round) && combat.round > 0 ? combat.round : 1, ...(delays.length ? { delays } : {}) };
}

export function reduceCombat(combat, action, tokens) {
  const current = normalizeCombat(combat, tokens);
  const order = initiativeOrder(current);
  switch (action.type) {
    case 'COMBAT_RESET': return emptyCombat();
    case 'COMBAT_UPSERT': {
      if (!tokens.some(t => t.id === action.entry.tokenId) || !Number.isFinite(action.entry.initiative)) return current;
      const exists = current.entries.some(e => e.tokenId === action.entry.tokenId);
      return normalizeCombat({ ...current, entries: exists
        ? current.entries.map(e => e.tokenId === action.entry.tokenId ? action.entry : e)
        : [...current.entries, action.entry] }, tokens);
    }
    case 'COMBAT_REMOVE': {
      const turns = turnOrder(current);
      const index = turns.findIndex(e => e.tokenId === action.id);
      const entries = current.entries.filter(e => e.tokenId !== action.id);
      if (!entries.length) return emptyCombat();
      const newRound = current.activeId === action.id && index === turns.length - 1;
      return normalizeCombat({ ...current, entries, delays: newRound ? [] : current.delays, activeId: current.activeId === action.id
        ? (newRound ? initiativeOrder({ entries })[0] : turns[index + 1])?.tokenId ?? null : current.activeId,
        round: current.round + (newRound ? 1 : 0) }, tokens);
    }
    case 'COMBAT_NEXT':
    case 'COMBAT_PREVIOUS': {
      const turns = turnOrder(current);
      if (!turns.length) return current;
      const index = turns.findIndex(e => e.tokenId === current.activeId);
      if (index < 0) return { ...current, activeId: turns[0].tokenId };
      const { delays: _delays, ...plain } = current;
      if (action.type === 'COMBAT_NEXT') {
        // the last turn of the round ends it: everyone is back in initiative order
        if (index === turns.length - 1) return { ...plain, activeId: order[0].tokenId, round: current.round + 1 };
        return { ...current, activeId: turns[index + 1].tokenId };
      }
      if (index === 0) {
        if (current.round === 1) return current;
        return { ...plain, activeId: order[order.length - 1].tokenId, round: current.round - 1 };
      }
      return { ...current, activeId: turns[index - 1].tokenId };
    }
    case 'COMBAT_PATCH': {
      // A player's edit of their own hero: the initiative, hit points and maximum of an entry that already exists.
      const entry = current.entries.find(e => e.tokenId === action.tokenId);
      if (!entry) return current;
      const next = { ...entry };
      if (Number.isFinite(action.initiative)) next.initiative = Math.round(action.initiative);
      if (Number.isFinite(action.maxHp) && action.maxHp >= 1) {
        // A new maximum keeps the current hit points (cut down to fit); a hero that had none starts at full health.
        next.maxHp = Math.round(action.maxHp);
        if (next.hp === null || next.hp === undefined) next.hp = next.maxHp;
      }
      if (Number.isFinite(action.hp) && next.maxHp) next.hp = Math.round(action.hp);
      return normalizeCombat({ ...current, entries: current.entries.map(e => (e === entry ? next : e)) }, tokens);
    }
    case 'COMBAT_DELAY': {
      // Whoever's turn it is steps out and acts right after someone of their own kind who comes later this round; the turn passes on at once.
      const turns = turnOrder(current);
      const from = turns.findIndex(e => e.tokenId === action.tokenId);
      if (current.activeId !== action.tokenId || !delayTargets(current, tokens, action.tokenId).some(e => e.tokenId === action.after)) return current;
      if ((current.delays ?? []).some(d => d.tokenId === action.tokenId)) return current; // once a round
      const next = { ...current, delays: [...(current.delays ?? []), { tokenId: action.tokenId, after: action.after }] };
      return { ...next, activeId: turnOrder(next)[from].tokenId };
    }
    default: return current;
  }
}

export function playerCombat(combat, state) {
  const fog = new Set(state.showFog ? state.fogCells : []);
  const visible = state.tokens.filter(t => {
    if (t.visibleToPlayers === false) return false;
    const col = Math.floor(t.x / state.gridSize), row = Math.floor(t.y / state.gridSize);
    for (let x = 0; x < Math.ceil(t.gridSize); x++) for (let y = 0; y < Math.ceil(t.gridSize); y++) {
      if (fog.has(`${col + x},${row + y}`)) return false;
    }
    return true;
  });
  const publicCombat = normalizeCombat(combat, visible);
  // Delays name the combatant a hero waits for, who may be hidden: players get the finished order of what they can see instead.
  const full = normalizeCombat(combat, state.tokens);
  const delayed = full.delays?.length ? { order: turnOrder(full).map(e => e.tokenId).filter(id => visible.some(t => t.id === id)),
    delayed: full.delays.map(d => d.tokenId).filter(id => visible.some(t => t.id === id)) } : null;
  delete publicCombat.delays;
  return { ...publicCombat, ...(delayed ?? {}), entries: publicCombat.entries.map(entry => {
    const token = visible.find(t => t.id === entry.tokenId);
    // Numeric NPC health stays GM-side, including tooltips and reconnect snapshots.
    if (tokenKind(token) === 'npc') return {
      tokenId: entry.tokenId, initiative: entry.initiative, condition: healthCondition(entry),
    };
    return entry;
  }) };
}
