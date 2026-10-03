import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ViewSettings } from '../../viewer/viewer';
import type { Tool } from '../viewport';
import { desktop, installPatch, saveTextFile } from '../../app/desktop';
import { projectTitle } from '../../app/projects';
import { exportSql } from '../sqlExport';
import { Check, Slot } from './common';
import type { EditorContext } from './context';
import { Inspector, Outliner } from './inspector';
import { Palette } from './palette';

const showHelp = signal(false);

/**
 * The world editor: menus and tools along the top, the palette on the left, the minimap,
 * inspector and list of changes on the right, the 3D view in between (the page's canvas, sized
 * to the gap) and a status line at the bottom.
 */
export function EditorApp({ ctx }: { ctx: EditorContext }) {
	return (
		<div class="ed wow">
			<MenuBar ctx={ctx} />
			<Toolbar ctx={ctx} />
			<Palette ctx={ctx} />
			<div class="ed-view" />
			<aside class="ed-side">
				<MinimapSlot ctx={ctx} />
				<Inspector ctx={ctx} />
				<Outliner ctx={ctx} />
			</aside>
			<StatusBar ctx={ctx} />
			{showHelp.value && <Help />}
		</div>
	);
}

// --- Menus ---

interface MenuProps {
	label: string;
	open: string | null;
	setOpen: (label: string | null) => void;
	children: ComponentChildren;
}

/** One menu: a click opens it; while any is open, pointing at another opens that instead. */
function Menu({ label, open, setOpen, children }: MenuProps) {
	const isOpen = open === label;
	return (
		<div class={`ed-menu ${isOpen ? 'open' : ''}`}>
			<button class="ed-menu-button wow-label" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : label)} onPointerEnter={() => open && !isOpen && setOpen(label)}>
				{label}
			</button>
			{isOpen && (
				<div class="ed-menu-panel wow-panel" onClick={(e) => (e.target as Element).closest('.ed-item') && setOpen(null)}>
					{children}
				</div>
			)}
		</div>
	);
}

/** A command in a menu: closes it. */
function Item({ label, keys, disabled, onClick }: { label: string; keys?: string; disabled?: boolean; onClick: () => void }) {
	return (
		<button class="ed-item" disabled={disabled} onClick={onClick}>
			<span>{label}</span>
			{keys && <kbd>{keys}</kbd>}
		</button>
	);
}

function MenuBar({ ctx }: { ctx: EditorContext }) {
	const [open, setOpen] = useState<string | null>(null);
	const bar = useRef<HTMLElement>(null);
	const file = useRef<HTMLInputElement>(null);
	const { doc, viewport } = ctx;
	const selected = doc.selection.value.length > 0;
	useEffect(() => {
		if (!open) return;
		const close = (e: PointerEvent) => {
			if (!bar.current?.contains(e.target as Node)) setOpen(null);
		};
		const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
		document.addEventListener('pointerdown', close);
		window.addEventListener('keydown', esc);
		return () => {
			document.removeEventListener('pointerdown', close);
			window.removeEventListener('keydown', esc);
		};
	}, [open]);

	const exportEdits = async () => {
		if (await saveTextFile('ironforge-edits.json', doc.exportJson())) ctx.notify('Edits saved');
	};
	/** Spawn edits as SQL for a VMaNGOS world database. */
	const exportServer = async () => {
		const result = exportSql(doc.entries());
		if (!result.added && !result.changed && !result.deleted) {
			ctx.notify(result.skipped.length ? 'Nothing the server can take: map models and terrain need the map export' : 'No NPC or object edits to export');
			return;
		}
		if (!(await saveTextFile('ironforge-spawns.sql', result.sql, 'application/sql'))) return;
		const left = result.skipped.length ? `; ${result.skipped.length} left out (listed at the top of the file)` : '';
		ctx.notify(`Exported ${result.added} added, ${result.changed} changed, ${result.deleted} deleted${left}`);
	};
	/** Ground and map model edits as a patch for the 1.12 client, put into its Data folder. */
	const exportMap = async () => {
		const models = doc.entries().filter((e) => /^\d+:(m2|wmo):/.test(e.id));
		const terrain = doc.terrainEdits();
		const paint = doc.paintEdits();
		const water = doc.waterEdits();
		if (!models.length && !Object.keys(terrain).length && !Object.keys(paint).length && !Object.keys(water).length) {
			ctx.notify('No ground, paint, water or map model edits to export (NPCs and objects go through the SQL export)');
			return;
		}
		ctx.notify('Making the map patch…');
		let patch;
		try {
			patch = await ctx.storage.exportMapPatch(models, terrain, paint, water);
		} catch (e) {
			ctx.notify(`Could not export the map: ${(e as Error).message}`);
			return;
		}
		if (patch.skipped.length) console.warn(`Map export left out:\n${patch.skipped.join('\n')}`);
		const left = patch.skipped.length ? ` (${patch.skipped.length} left out: see the console)` : '';
		if (!patch.tiles.length) {
			ctx.notify(`Nothing to export${left}`);
			return;
		}
		const result = await installPatch(patch.archive);
		const tiles = `${patch.tiles.length} tile${patch.tiles.length === 1 ? '' : 's'}`;
		if (result.written) ctx.notify(`Map patch with ${tiles} put in the game${left}. Run update-maps.bat for the server, then log in.`);
		else if (result.reason) ctx.notify(`Map patch not written: ${result.reason}`);
		else ctx.notify(`Saved patch-3.MPQ with ${tiles}${left}: put it in the game's Data folder`);
	};
	const importText = (text: string) => {
		try {
			ctx.notify(`Imported ${doc.importJson(text)} changes`);
		} catch (e) {
			ctx.notify(`Could not import: ${(e as Error).message}`);
		}
	};
	const importEdits = async (chosen: File | undefined) => {
		if (chosen) importText(await chosen.text());
	};
	/** The desktop app's open dialog, or the browser's file picker. */
	const chooseImport = async () => {
		if (!desktop) return file.current?.click();
		const opened = await desktop.openText();
		if (opened) importText(opened.text);
	};
	const props = { open, setOpen };
	return (
		<nav class="ed-menubar wow-panel" ref={bar}>
			<Menu label="File" {...props}>
				<Item label="New project…" onClick={() => void ctx.projects.close()} />
				<Item label="Open project…" keys="Ctrl+O" onClick={() => void ctx.projects.open()} />
				<Item label="Save" keys="Ctrl+S" onClick={() => void ctx.projects.save()} />
				<Item label="Save as…" keys="Ctrl+Shift+S" onClick={() => void ctx.projects.save(true)} />
				<Item label="Close project" onClick={() => void ctx.projects.close()} />
				<hr />
				<Item label="Export edits…" disabled={!doc.count.value} onClick={() => void exportEdits()} />
				<Item label="Import edits…" onClick={() => void chooseImport()} />
				<Item label="Export for server (SQL)…" disabled={!doc.count.value} onClick={() => void exportServer()} />
				<Item label="Export map to game…" disabled={!doc.count.value} onClick={() => void exportMap()} />
				<Item label="Clear all edits…" disabled={!doc.count.value} onClick={() => {
					if (confirm('Put every NPC and object back as the spawn data has it? This removes all your changes and everything you placed.')) doc.clearAll();
				}} />
				<hr />
				<Item label="Copy link to this view" onClick={ctx.copyLink} />
				<Item label="Screenshot, full detail" onClick={ctx.screenshot} />
				<hr />
				<Item label="Back to exploring" keys="Tab" onClick={ctx.exit} />
			</Menu>
			<Menu label="Edit" {...props}>
				<Item label="Undo" keys="Ctrl+Z" disabled={!doc.canUndo.value} onClick={() => doc.undo()} />
				<Item label="Redo" keys="Ctrl+Y" disabled={!doc.canRedo.value} onClick={() => doc.redo()} />
				<hr />
				<Item label="Cut" keys="Ctrl+X" disabled={!selected} onClick={() => viewport.cut()} />
				<Item label="Copy" keys="Ctrl+C" disabled={!selected} onClick={() => viewport.copy()} />
				<Item label="Paste" keys="Ctrl+V" disabled={!viewport.clipboard.value.length} onClick={() => viewport.paste()} />
				<Item label="Duplicate" keys="Ctrl+D" disabled={!selected} onClick={() => viewport.duplicate()} />
				<Item label="Delete" keys="Del" disabled={!selected} onClick={() => viewport.remove()} />
				<Item label="Back to the original" disabled={!selected} onClick={() => doc.revert(doc.selection.value)} />
				<Item label="Select nothing" keys="Esc" disabled={!selected} onClick={() => doc.select([])} />
				<hr />
				<div class="ed-menu-heading wow-label">Clicks pick</div>
				<Check checked={viewport.props.value} onChange={(on) => (viewport.props.value = on)}>The map's props (trees, crates…)</Check>
				<Check checked={viewport.buildings.value} onChange={(on) => (viewport.buildings.value = on)}>Buildings</Check>
			</Menu>
			<Menu label="View" {...props}>
				<ViewMenu ctx={ctx} />
			</Menu>
			<Menu label="Help" {...props}>
				<Item label="Editor controls" keys="F1" onClick={() => (showHelp.value = true)} />
			</Menu>
			<div class="ed-project wow-label" title="The project open">{projectTitle.value}</div>
			<div class="ed-menubar-title wow-title">Ironforge</div>
			<button class="wow-button ed-exit" onClick={ctx.exit} title="Back to exploring (Tab)">Explore</button>
			<input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => {
				const input = e.target as HTMLInputElement;
				void importEdits(input.files?.[0]);
				input.value = '';
			}} />
		</nav>
	);
}

/** Time of day and the look switches, shared with the explorer's View panel. */
function ViewMenu({ ctx }: { ctx: EditorContext }) {
	const [, redraw] = useState(0);
	const s = ctx.settings.get();
	const set = (next: Partial<ViewSettings>) => {
		ctx.settings.set(next);
		redraw((n) => n + 1);
	};
	const minutes = ctx.viewer.timeMinutes;
	const switches: [keyof ViewSettings, string][] = [
		['shadows', 'Shadows'], ['fog', 'Fog and sun shafts'], ['grading', 'Colour grading'], ['clutter', 'Grass and flowers'],
		['torch', 'Torch'], ['npcNames', 'Names over NPCs'], ['creatures', 'NPCs and monsters'], ['gameObjects', 'Objects'],
	];
	return (
		<div class="ed-view-menu">
			<label class="ed-time">
				<span class="wow-label">Time</span>
				<input type="range" min={0} max={1425} step={15} value={Math.round(minutes / 15) * 15} onInput={(e) => {
					ctx.viewer.timeMinutes = Number((e.target as HTMLInputElement).value);
					redraw((n) => n + 1);
				}} />
				<output>{`${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`}</output>
			</label>
			{switches.map(([key, label]) => (
				<Check checked={s[key] as boolean} onChange={(on) => set({ [key]: on })}>{label}</Check>
			))}
		</div>
	);
}

// --- Tools ---

const TOOLS: [Tool, 'select' | 'move' | 'rotate' | 'scale' | 'terrain', string, string][] = [
	['select', 'select', 'Select', 'Q'],
	['move', 'move', 'Move', 'W'],
	['rotate', 'rotate', 'Turn', 'E'],
	['scale', 'scale', 'Resize', 'R'],
	['sculpt', 'terrain', 'Shape the ground', 'T'],
];

function Toolbar({ ctx }: { ctx: EditorContext }) {
	const { viewport, doc } = ctx;
	const tool = viewport.tool.value;
	const stamp = viewport.stamp.value;
	const selected = doc.selection.value.length > 0;
	return (
		<div class="ed-toolbar wow-panel">
			<div class="ed-slots">
				{TOOLS.map(([t, icon, title, key]) => (
					<Slot icon={icon} title={title} keyLabel={key} pressed={tool === t} onClick={() => {
						viewport.cancel();
						viewport.stamp.value = null;
						viewport.tool.value = t;
					}} />
				))}
				<span class="ed-gap" />
				<Slot icon="place" title={stamp ? `Placing ${stamp.name}` : 'Place: choose something in the palette'} pressed={tool === 'place'} onClick={() => {
					(document.querySelector('.ed-search') as HTMLInputElement | null)?.focus();
				}} />
				<Slot icon="duplicate" title="Duplicate" keyLabel="c-D" disabled={!selected} onClick={() => viewport.duplicate()} />
				<Slot icon="remove" title="Delete" keyLabel="Del" disabled={!selected} onClick={() => viewport.remove()} />
				<span class="ed-gap" />
				<Slot icon="undo" title="Undo" keyLabel="c-Z" disabled={!doc.canUndo.value} onClick={() => doc.undo()} />
			</div>
			<div class="ed-toolbar-options">
				{tool === 'place' && stamp && <span class="wow-label ed-placing">Placing: {stamp.name}</span>}
				<Check checked={viewport.randomTurn.value} onChange={(on) => (viewport.randomTurn.value = on)} title="Each new one faces a random way">Random turn</Check>
				<Check checked={viewport.props.value} onChange={(on) => (viewport.props.value = on)} title="Clicks pick trees, crates and other props of the map">Props</Check>
				<Check checked={viewport.buildings.value} onChange={(on) => (viewport.buildings.value = on)} title="Clicks pick buildings">Buildings</Check>
			</div>
		</div>
	);
}

// --- Right column ---

/** The explorer's minimap, borrowed while editing, in the game's ring. */
function MinimapSlot({ ctx }: { ctx: EditorContext }) {
	const slot = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const node = ctx.minimap;
		const home = node.parentElement;
		const next = node.nextSibling;
		slot.current?.append(node);
		return () => {
			home?.insertBefore(node, next);
		};
	}, []);
	return <div class="ed-minimap" ref={slot} />;
}

function StatusBar({ ctx }: { ctx: EditorContext }) {
	const hud = ctx.hud.value;
	const count = ctx.doc.selection.value.length;
	const changes = ctx.doc.count.value;
	return (
		<footer class="ed-status wow-panel">
			<span class="wow-label">{hud ? (hud.zone ? [hud.zone, hud.subzone].filter(Boolean).join(' · ') : hud.location) : ''}</span>
			<span class="wow-muted">{hud?.coordinates}</span>
			<span>{count ? `${count} selected` : ''}</span>
			<span class="ed-status-hint wow-muted">{ctx.viewport.hint.value}</span>
			<span class="wow-muted">{[changes ? `${changes} change${changes === 1 ? '' : 's'}` : 'No changes', projectTitle.value.endsWith('*') ? 'not saved yet (Ctrl+S)' : 'saved'].join(' · ')}</span>
		</footer>
	);
}

function Help() {
	const rows: [string, string][] = [
		['Right mouse + WASD', 'Look around and fly (Space / C up and down, Shift faster)'],
		['Wheel', 'Fly forward and back'],
		['Q · W · E · R', 'Select · Move · Turn · Resize'],
		['Click · Ctrl+click', 'Select · add or take away'],
		['Drag on empty ground', 'Select everything in a box'],
		['Drag the circle\'s orange part', 'Resize: out bigger, in smaller'],
		['Shift while moving', 'Snap onto what\'s under the mouse: the ground, or on top of a prop'],
		['Wheel while moving, Alt+wheel', 'Turn (Shift: finer)'],
		['Ctrl+wheel', 'Raise / lower (Shift: by a yard)'],
		['PgUp / PgDn', 'Raise / lower (Shift: by a yard)'],
		['F', 'Fly to the selection'],
		['Ctrl+C · Ctrl+X · Ctrl+V', 'Copy · cut · paste (follows the mouse until you click)'],
		['Ctrl+D · Del', 'Duplicate · delete'],
		['Ctrl+Z · Ctrl+Y', 'Undo · redo'],
		['Esc', 'Stop placing, then select nothing'],
		['Tab', 'Back to exploring'],
	];
	return (
		<div class="ed-help-backdrop" onClick={(e) => e.target === e.currentTarget && (showHelp.value = false)}>
			<div class="wow-dialog ed-help" role="dialog" aria-label="Editor controls">
				<div class="ed-help-head">
					<h2 class="wow-title">Editor controls</h2>
					<button class="wow-close" aria-label="Close" onClick={() => (showHelp.value = false)}>×</button>
				</div>
				<dl>
					{rows.map(([k, v]) => [<dt class="wow-label">{k}</dt>, <dd>{v}</dd>])}
				</dl>
			</div>
		</div>
	);
}

/** Opens or closes the controls list (F1 in the editor). */
export function toggleHelp(on = !showHelp.value): void {
	showHelp.value = on;
}
