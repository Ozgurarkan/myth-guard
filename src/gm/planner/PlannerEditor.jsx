// The page editor: a rich-text surface (TipTap) with a toolbar. Loaded only when the planner opens, so the table
// screen and the players never download it.
import React, { useEffect } from 'react';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Icon } from '../../ui';

const EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
  Placeholder.configure({ placeholder: 'Start writing your session…' }),
  Highlight,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow, TableHeader, TableCell,
];

function Tool({ icon, label, active = false, disabled = false, onClick, text }) {
  return (
    <button type="button" className={`planner-tool${active ? ' is-active' : ''}`} title={label} aria-label={label} aria-pressed={active}
      disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>
      {icon ? <Icon name={icon} size={17} /> : <span aria-hidden="true">{text}</span>}
    </button>
  );
}
const Sep = () => <span className="planner-toolbar__sep" aria-hidden="true" />;

function Toolbar({ editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'),
      highlight: e.isActive('highlight'), bullet: e.isActive('bulletList'), ordered: e.isActive('orderedList'), task: e.isActive('taskList'),
      quote: e.isActive('blockquote'), link: e.isActive('link'), inTable: e.isActive('table'),
      block: e.isActive('heading', { level: 1 }) ? 'h1' : e.isActive('heading', { level: 2 }) ? 'h2' : e.isActive('heading', { level: 3 }) ? 'h3' : 'p',
      canUndo: e.can().undo(), canRedo: e.can().redo(),
    }),
  });
  const run = fn => () => fn(editor.chain().focus()).run();
  const setBlock = event => {
    const value = event.target.value;
    const chain = editor.chain().focus();
    (value === 'p' ? chain.setParagraph() : chain.setHeading({ level: Number(value.slice(1)) })).run();
  };
  const setLink = () => {
    const previous = editor.getAttributes('link').href || '';
    const url = window.prompt('Link address (leave empty to remove the link)', previous);
    if (url === null) return;
    if (!url.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  return (
    <div className="planner-toolbar" role="toolbar" aria-label="Formatting">
      <Tool icon="undo-2" label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={run(c => c.undo())} />
      <Tool icon="redo-2" label="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={run(c => c.redo())} />
      <Sep />
      <select className="planner-select" aria-label="Text style" value={s.block} onChange={setBlock}>
        <option value="p">Normal text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option>
      </select>
      <Sep />
      <Tool icon="bold" label="Bold (Ctrl+B)" active={s.bold} onClick={run(c => c.toggleBold())} />
      <Tool icon="italic" label="Italic (Ctrl+I)" active={s.italic} onClick={run(c => c.toggleItalic())} />
      <Tool icon="underline" label="Underline (Ctrl+U)" active={s.underline} onClick={run(c => c.toggleUnderline())} />
      <Tool icon="strikethrough" label="Strikethrough" active={s.strike} onClick={run(c => c.toggleStrike())} />
      <Tool icon="highlighter" label="Highlight" active={s.highlight} onClick={run(c => c.toggleHighlight())} />
      <Sep />
      <Tool icon="list" label="Bulleted list" active={s.bullet} onClick={run(c => c.toggleBulletList())} />
      <Tool icon="list-ordered" label="Numbered list" active={s.ordered} onClick={run(c => c.toggleOrderedList())} />
      <Tool icon="list-checks" label="Checklist" active={s.task} onClick={run(c => c.toggleTaskList())} />
      <Sep />
      <Tool icon="quote" label="Read-aloud box (quote)" active={s.quote} onClick={run(c => c.toggleBlockquote())} />
      <Tool icon="minus" label="Divider line" onClick={run(c => c.setHorizontalRule())} />
      <Tool icon="link" label="Link" active={s.link} onClick={setLink} />
      <Tool icon="table" label="Insert a table" onClick={run(c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))} />
      <Tool icon="remove-formatting" label="Clear formatting" onClick={run(c => c.unsetAllMarks().clearNodes())} />
      {s.inTable && <>
        <Sep />
        <Tool text="+Row" label="Add a row below" onClick={run(c => c.addRowAfter())} />
        <Tool text="+Col" label="Add a column to the right" onClick={run(c => c.addColumnAfter())} />
        <Tool text="−Row" label="Delete this row" onClick={run(c => c.deleteRow())} />
        <Tool text="−Col" label="Delete this column" onClick={run(c => c.deleteColumn())} />
        <Tool icon="trash" label="Delete the table" onClick={run(c => c.deleteTable())} />
      </>}
    </div>
  );
}

/** `content` is the page's HTML when it was opened; `onChange(html)` fires on every edit. Remount (key) to switch pages. */
export default function PlannerEditor({ content, onChange, autoFocus = false }) {
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: content || '<p></p>',
    immediatelyRender: true,
    editorProps: { attributes: { class: 'planner-prose', 'aria-label': 'Session plan page', spellcheck: 'true' } },
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });
  useEffect(() => { if (editor && autoFocus) editor.commands.focus('end'); }, [editor, autoFocus]);
  if (!editor) return null;
  return (
    <>
      <Toolbar editor={editor} />
      <div className="planner-sheet-wrap"><EditorContent editor={editor} className="planner-sheet" /></div>
    </>
  );
}
