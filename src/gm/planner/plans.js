// Session plan pages: the GM's private writing. They live only in this browser's IndexedDB (the same private
// store family as Quests and NPCs) and are never part of the shared scene, so players can never receive them.
import { dbListLibrary, dbSaveLibrary, dbDeleteLibrary } from '../../db';

export const listPlans = () => dbListLibrary('plans');
/** Saves a page and returns its id (a new page gets one). */
export const savePlan = record => dbSaveLibrary('plans', record);
export const deletePlan = id => dbDeleteLibrary('plans', id);

const esc = text => text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const list = items => `<ul>${items.map(item => `<li><p>${esc(item)}</p></li>`).join('')}</ul>`;
const todo = items => `<ul data-type="taskList">${items.map(item => `<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>${esc(item)}</p></div></li>`).join('')}</ul>`;
const section = (title, body) => `<h2>${esc(title)}</h2>${body}`;

/** What a new page can start from. */
export const TEMPLATES = [
  { id: 'blank', label: 'Blank page', hint: 'Start with an empty page.', html: '<p></p>' },
  {
    id: 'outline', label: 'Session outline', hint: 'Eight steps for a session you can run from one page.',
    html: [
      section('Recap', list(['What happened last time, in a few lines.'])),
      section('Strong start', '<p>The first scene: where the players are and what is already going wrong.</p>'),
      section('Scenes', todo(['A scene that could happen', 'Another one', 'And a third'])),
      section('Secrets and clues', list(['A secret the players can find', 'Where they can learn it'])),
      section('Locations', list(['A place worth describing, with one vivid detail'])),
      section('People', list(['Name: what they want, how they speak'])),
      section('Monsters', list(['Creature: how many, where, what they do'])),
      section('Rewards', list(['Treasure, favours and information the players can earn'])),
      section('Afterwards', '<p>Notes for next time.</p>'),
    ].join(''),
  },
];

/** The words of a page's HTML as plain text, for search, word counts and the .txt export. */
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const lines = [];
  const blocks = doc.body.querySelectorAll('h1,h2,h3,p,li,blockquote,tr,hr');
  for (const node of blocks) {
    if (node.tagName === 'HR') { lines.push('---'); continue; }
    if (node.tagName === 'TR') { lines.push([...node.children].map(cell => cell.textContent.trim()).join(' | ')); continue; }
    if (node.tagName === 'P' && node.closest('li, blockquote, td, th')) continue;
    if (node.tagName === 'BLOCKQUOTE') { lines.push(`> ${node.textContent.trim()}`); continue; }
    const text = node.textContent.trim();
    if (!text) continue;
    if (node.tagName === 'LI') {
      const checkbox = node.querySelector('input[type=checkbox]');
      const mark = checkbox ? (node.getAttribute('data-checked') === 'true' ? '[x] ' : '[ ] ') : '- ';
      lines.push(mark + text);
    } else if (/^H[123]$/.test(node.tagName)) lines.push('', text.toUpperCase());
    else lines.push(text);
  }
  return lines.join('\n').trim();
}

export const countWords = text => (text.match(/\S+/g) || []).length;

const safeName = title => (title || 'session-plan').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'session-plan';

/** A self-contained web page of the plan (opens anywhere, prints cleanly). */
export function toHtmlDocument(plan) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(plan.title || 'Session plan')}</title>
<style>body{font:17px/1.65 Georgia,serif;max-width:46rem;margin:2.5rem auto;padding:0 1.2rem;color:#1b1b24}h1,h2,h3{font-family:Georgia,serif;line-height:1.25}
blockquote{margin:1em 0;padding-left:1em;border-left:4px solid #9b8ad8;color:#444}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:.35em .6em;vertical-align:top}
th{background:#eee}mark{background:#ffe58a}hr{border:0;border-top:1px solid #bbb;margin:1.5em 0}ul[data-type=taskList]{list-style:none;padding-left:0}
ul[data-type=taskList] li{display:flex;gap:.5em}ul[data-type=taskList] li>label{flex:none}</style></head>
<body><h1>${esc(plan.title || 'Session plan')}</h1>${plan.html || ''}</body></html>`;
}

/** Hands the browser a file to save. */
export function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const exportName = (plan, extension) => `${safeName(plan.title)}.${extension}`;
