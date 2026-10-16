import test from 'node:test';
import assert from 'node:assert/strict';
import { canPlayerMoveToken } from '../src/ownership.js';

test('only the assigned player can move a token, subject to GM visibility and movement controls', () => {
  const state = { playerCanMoveTokens: true, showFog: true, fogCells: [], gridSize: 50 };
  const token = { ownerId: 'alice', x: 0, y: 0, gridSize: 2 };
  assert.equal(canPlayerMoveToken(state, token, 'alice'), true);
  assert.equal(canPlayerMoveToken(state, token, 'bob'), false);
  assert.equal(canPlayerMoveToken(state, { ...token, ownerId: null }, 'alice'), false);
  assert.equal(canPlayerMoveToken(state, token, null), false);
  assert.equal(canPlayerMoveToken({ ...state, playerCanMoveTokens: false }, token, 'alice'), false);
  assert.equal(canPlayerMoveToken(state, { ...token, visibleToPlayers: false }, 'alice'), false);
  assert.equal(canPlayerMoveToken({ ...state, fogCells: ['1,1'] }, token, 'alice'), false);
  assert.equal(canPlayerMoveToken({ ...state, showFog: false, fogCells: ['1,1'] }, token, 'alice'), true);
  assert.equal(canPlayerMoveToken(state, { ...token, ownerId: 'bob' }, 'alice'), false);
});
