export const emptyCombat = () => ({ entries: [], activeId: null, round: 1 });
export const initiativeOrder = combat => [...(combat?.entries || [])].sort((a, b) => b.initiative - a.initiative);
export const tokenKind = token => token.characterType ?? (token.category?.toUpperCase() === 'NPC' ? 'npc' : 'pc');
export function healthCondition(entry) {
  if (!entry.maxHp) return 'Unknown';
  if (entry.hp <= 0) return 'Down';
  const remaining = entry.hp / entry.maxHp;
  if (remaining <= .25) return 'Almost dead';
  if (remaining <= .5) return 'Badly wounded';
  if (remaining < 1) return 'Wounded';
  return 'Healthy';
}
export const healthLabel = entry => entry.condition ?? (entry.maxHp ? `${entry.hp} / ${entry.maxHp} HP` : 'HP not set');
export const bloodLevel = entry => entry.condition
  ? ({ Healthy: 0, Wounded: .25, 'Badly wounded': .55, 'Almost dead': .85, Down: 1, Unknown: 0 }[entry.condition] ?? 0)
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
  return { entries, activeId: entries.some(e => e.tokenId === combat?.activeId) ? combat.activeId : null,
    round: Number.isInteger(combat?.round) && combat.round > 0 ? combat.round : 1 };
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
      const index = order.findIndex(e => e.tokenId === action.id);
      const entries = current.entries.filter(e => e.tokenId !== action.id);
      if (!entries.length) return emptyCombat();
      return { ...current, entries, activeId: current.activeId === action.id
        ? order[(index + 1) % order.length]?.tokenId ?? null : current.activeId,
        round: current.round + (current.activeId === action.id && index === order.length - 1 ? 1 : 0) };
    }
    case 'COMBAT_NEXT':
    case 'COMBAT_PREVIOUS': {
      if (!order.length) return current;
      const index = order.findIndex(e => e.tokenId === current.activeId);
      if (index < 0) return { ...current, activeId: order[0].tokenId };
      const direction = action.type === 'COMBAT_NEXT' ? 1 : -1;
      if (direction < 0 && index === 0 && current.round === 1) return current;
      return { ...current, activeId: order[(index + direction + order.length) % order.length].tokenId,
        round: current.round + (direction > 0 && index === order.length - 1 ? 1 : direction < 0 && index === 0 ? -1 : 0) };
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
  return { ...publicCombat, entries: publicCombat.entries.map(entry => {
    const token = visible.find(t => t.id === entry.tokenId);
    // Numeric NPC health stays GM-side, including tooltips and reconnect snapshots.
    if (tokenKind(token) === 'npc') return {
      tokenId: entry.tokenId, initiative: entry.initiative, condition: healthCondition(entry),
    };
    return entry;
  }) };
}
