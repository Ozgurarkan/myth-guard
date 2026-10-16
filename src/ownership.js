// Shared by the player UI, GM, and relay: a missing owner means GM-only.
export function canPlayerMoveToken(state, token, playerId) {
  if (!state || !token || !playerId || token.ownerId !== playerId ||
      state.playerCanMoveTokens === false || token.visibleToPlayers === false) return false;
  const fog = new Set(state.showFog ? state.fogCells || [] : []);
  const col = Math.floor(token.x / state.gridSize), row = Math.floor(token.y / state.gridSize);
  for (let x = 0; x < Math.ceil(token.gridSize || 1); x++) for (let y = 0; y < Math.ceil(token.gridSize || 1); y++) {
    if (fog.has(`${col + x},${row + y}`)) return false;
  }
  return true;
}
