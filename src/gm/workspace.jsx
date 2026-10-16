// Shared workspace state for the GM screen: which side panel is open and
// which dialogs are showing. Scene state lives in store.jsx.
import { createContext, useContext } from 'react';

/** id · label · icon · heading · one-line help — in the order they appear on the tab rail. */
export const PANELS = [
  { id: 'scenes', group: 'Prepare', label: 'Scenes', icon: 'map', title: 'Scenes', help: 'Save and load maps with their tokens, fog and combat.' },
  { id: 'tokens', group: 'On the table', label: 'Tokens', icon: 'users', title: 'Tokens', help: 'Heroes, creatures and objects on the table.' },
  { id: 'combat', group: 'Encounter', label: 'Combat', icon: 'swords', title: 'Combat', help: 'Initiative, hit points and the turn order.' },
  { id: 'table', group: 'Players', label: 'Table', icon: 'wifi', title: 'The table', help: 'Who has joined, and which hero is theirs.' },
  { id: 'quests', group: 'Notebook', label: 'Quests', icon: 'scroll-text', title: 'Quests', help: 'Objectives, rewards and the people involved.' },
  { id: 'npcs', group: 'Notebook', label: 'NPCs', icon: 'drama', title: 'Cast of characters', help: 'Everyone your players might meet.' },
  { id: 'sheets', group: 'Reference', label: 'Sheets', icon: 'book-user', title: 'Character sheets', help: 'Your players’ PDFs, kept private to you.' },
  { id: 'handouts', group: 'Reveal', label: 'Handouts', icon: 'images', title: 'Handouts', help: 'Preview privately, then reveal to the table.' },
  { id: 'spells', group: 'Draw', label: 'Spells', icon: 'wand-sparkles', title: 'Spell areas', help: 'Measured circles, cones and squares.' },
  { id: 'markers', group: 'Draw', label: 'Markers', icon: 'map-pin', title: 'Map markers', help: 'Points of interest and notes on the map.' },
  { id: 'sound', group: 'Atmosphere', label: 'Sound', icon: 'music', title: 'Sound', help: 'Share your computer’s music with chosen players.' },
  { id: 'settings', group: 'Setup', label: 'Settings', icon: 'settings', title: 'Settings', help: 'Grid, scale, fog and the player view.' },
];

export const WorkspaceCtx = createContext(null);
export const useWorkspace = () => useContext(WorkspaceCtx);
