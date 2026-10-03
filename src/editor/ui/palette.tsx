import { useEffect, useMemo, useState } from 'preact/hooks';
import type { BrushKind } from '../sculpt';
import { matchScore, searchKey } from '../../app/search';
import { spawnFile } from '../../explorer/spawns';
import { creatureIcon, type IconName } from '../../ui/wowSkin';
import type { Stamp, TerrainMode } from '../viewport';
import type { TerrainTexture } from '../../explorer/world';
import type { WaterType } from '../../formats/surfaceEdits';
import { Check, Icon, Panel, Slot } from './common';
import type { EditorContext } from './context';

/** The palette's tabs: NPCs and game objects (VMaNGOS templates), the game's map models, and what was placed lately. */
type Category = 'npc' | 'object' | 'nature' | 'props' | 'buildings' | 'effects' | 'terrain' | 'recent';

const CATEGORIES: [Category, IconName, string][] = [
	['npc', 'npc', 'NPCs and monsters'],
	['object', 'object', 'Objects (chests, doors, mailboxes…)'],
	['nature', 'nature', 'Nature: trees, bushes, rocks…'],
	['props', 'props', 'Props: furniture, barrels, lamps, signs…'],
	['buildings', 'town', 'Buildings'],
	['effects', 'effects', 'Effects: glows, smoke, particles'],
	['terrain', 'terrain', 'Terrain: shape, paint and flood the ground'],
	['recent', 'recent', 'Placed lately'],
];

interface Row extends Stamp {
	category: Exclude<Category, 'recent' | 'terrain'>;
	/** The group within the category: a creature or object type, or Trees, Furniture... */
	group: string;
	/** What it is, or where it's from. */
	sub: string;
	/** The name, and for map models also the folder, made ready for matching. */
	key: string;
	where?: string;
	/** Map models from before The Burning Crusade (always true for templates). */
	classic: boolean;
	/** 0 for proper names; 1 for those starting oddly ("Plucky"); 2 for placeholders ([NOT USED], [PH]). */
	rank: number;
}

/** Results shown at most. */
const LIMIT = 150;
const RECENT_KEY = 'mapExplorer.recentStamps';
const CLASSIC_KEY = 'mapExplorer.paletteClassic';
const RECENT_LIMIT = 40;

function readStored<T>(key: string, fallback: T): T {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : (JSON.parse(v) as T);
	} catch {
		return fallback;
	}
}

function store(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Not remembered.
	}
}

/** Templates nobody would place on purpose sort last. */
function rankOf(name: string): number {
	if (/^\[|\bUNUSED\b|\bNOT USED\b|\bDEPRECATED\b|\bTEST\b|\bzzOLD/i.test(name)) return 2;
	return /^[A-Za-z]/.test(name) ? 0 : 1;
}

/** A model file's name made readable: ElwynnTree01 -> Elwynn tree 01, stormwind_lamp_02 -> Stormwind lamp 02. */
function modelName(file: string): string {
	const words = file
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Za-z])(\d)/g, '$1 $2')
		.trim()
		.toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Where a model is from, from its folder: generic/human/passive doodads/stormwind -> Human · Stormwind. */
function modelPlace(dir: string): string {
	const skip = new Set(['generic', 'passivedoodads', 'passive doodads', 'doodads', 'activedoodads', 'wmo', 'buildings', 'passive', 'doodad']);
	const parts = dir.split('/').filter((p) => !skip.has(p)).slice(-2);
	return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' · ');
}

/** public/spawns/models.json (tools/buildModels.ts). */
interface ModelFile {
	groups: { category: Row['category']; name: string }[];
	dirs: string[];
	models: [number, number, string, number, number][];
}

const GROUP_ICONS: Record<string, IconName> = {
	'Lights and fire': 'candle', 'Food and kitchen': 'food', 'Remains and graves': 'bone', 'Books and papers': 'book',
	'Signs and banners': 'note', 'Herbs and ore': 'prop', 'Bushes and plants': 'prop', 'Containers': 'object',
};

/** An icon for a palette entry: a creature type's, an object type's, or its group's or category's. */
function iconOf(row: Row): IconName {
	if (row.category === 'npc') return creatureIcon(row.group);
	if (row.category === 'object') return /^(Text|Quest giver)/.test(row.group) ? 'note' : 'object';
	return GROUP_ICONS[row.group] ?? CATEGORIES.find(([c]) => c === row.category)![1];
}

let catalog: Promise<Row[]> | null = null;

/** Every template and map model, read once: templates from the worker, models from models.json. */
function loadCatalog(ctx: EditorContext): Promise<Row[]> {
	catalog ??= Promise.all([
		ctx.storage.listTemplates(),
		fetch(spawnFile('models.json')).then((r) => (r.ok ? (r.json() as Promise<ModelFile>) : null), () => null),
	]).then(([templates, models]) => {
		const rows: Row[] = [];
		for (const [entry, name, sub, kind] of templates.npcs) {
			rows.push({ type: 'npc', category: 'npc', entry, name, sub, group: kind || 'Not specified', key: searchKey(name), classic: true, rank: rankOf(name) });
		}
		for (const [entry, name, kind] of templates.objects) {
			rows.push({ type: 'object', category: 'object', entry, name, sub: kind, group: kind, key: searchKey(name), classic: true, rank: rankOf(name) });
		}
		for (const [fdid, dir, file, group, classic] of models?.models ?? []) {
			const g = models!.groups[group];
			const name = modelName(file);
			rows.push({
				type: g.category === 'buildings' ? 'wmo' : 'm2', category: g.category, entry: fdid, name,
				sub: modelPlace(models!.dirs[dir]), group: g.name, key: searchKey(name), where: searchKey(models!.dirs[dir]), classic: classic === 1, rank: 0,
			});
		}
		return rows.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
	});
	return catalog;
}

/**
 * The palette: everything that can be placed, in categories (NPCs, objects, nature, props,
 * buildings, effects) and groups within them, found by name, folder or ID. Choosing one starts
 * placing it: a copy follows the mouse, and each click puts one down.
 */
export function Palette({ ctx }: { ctx: EditorContext }) {
	const [category, setCategory] = useState<Category>('npc');
	const [group, setGroup] = useState<string | null>(null);
	const [query, setQuery] = useState('');
	const [rows, setRows] = useState<Row[] | null>(null);
	// Kept from earlier visits; older entries lack some fields.
	const [recent, setRecent] = useState<Row[]>(() => readStored<Row[]>(RECENT_KEY, []).map((r) => ({
		...r,
		category: r.category ?? (r.type === 'npc' ? 'npc' : r.type === 'object' ? 'object' : r.type === 'wmo' ? 'buildings' : 'props'),
		group: r.group ?? '',
		rank: r.rank ?? 0,
		classic: r.classic ?? true,
	})));
	const [classicOnly, setClassicOnly] = useState(() => readStored(CLASSIC_KEY, true));
	const stamp = ctx.viewport.stamp.value;

	useEffect(() => {
		void loadCatalog(ctx).then(setRows, () => setRows([]));
	}, []);
	// The sculpt tool (T) shows the terrain brushes; leaving them puts the move tool back.
	const tool = ctx.viewport.tool.value;
	useEffect(() => {
		if (tool === 'sculpt') setCategory('terrain');
	}, [tool]);

	// What's in this category (minus later expansions' models unless asked), and its groups with counts.
	const inCategory = useMemo(() => {
		const list = category === 'recent' ? recent : (rows ?? []).filter((r) => r.category === category && (r.classic || !classicOnly));
		const counts = new Map<string, number>();
		for (const r of list) counts.set(r.group, (counts.get(r.group) ?? 0) + 1);
		const groups = [...counts].sort((a, b) => (a[0] === 'Other') !== (b[0] === 'Other') ? (a[0] === 'Other' ? 1 : -1) : a[0].localeCompare(b[0]));
		return { list, groups };
	}, [category, rows, recent, classicOnly]);

	const found = useMemo(() => {
		const list = group && category !== 'recent' ? inCategory.list.filter((r) => r.group === group) : inCategory.list;
		const q = searchKey(query.trim());
		if (!q) return { shown: list.slice(0, LIMIT), total: list.length };
		const id = Number(q);
		if (Number.isInteger(id) && id > 0) {
			const hits = list.filter((r) => r.entry === id);
			return { shown: hits, total: hits.length };
		}
		// Every word must be in it somewhere: model files often run words together (elwynntreecanopy).
		// Matches in the name come before those that need the folder too.
		const words = q.split(/\s+/);
		const score = (r: Row) => {
			if (words.every((w) => r.key.includes(w))) return Math.max(0, matchScore(r.key, words[0]));
			const both = `${r.key} ${r.where ?? ''}`;
			return words.every((w) => both.includes(w)) ? 3 : -1;
		};
		const hits = list.map((r) => ({ r, score: score(r) })).filter((m) => m.score >= 0)
			.sort((a, b) => a.r.rank - b.r.rank || a.score - b.score || a.r.name.length - b.r.name.length);
		return { shown: hits.slice(0, LIMIT).map((m) => m.r), total: hits.length };
	}, [inCategory, group, query]);

	const choose = async (row: Row) => {
		const next = [row, ...recent.filter((r) => r.type !== row.type || r.entry !== row.entry)].slice(0, RECENT_LIMIT);
		setRecent(next);
		store(RECENT_KEY, next);
		(document.activeElement as HTMLElement | null)?.blur();
		if (!(await ctx.viewport.startPlacing({ type: row.type, entry: row.entry, name: row.name }))) ctx.notify('Point at the ground on a map to place it there');
	};

	const pick = (c: Category) => {
		setCategory(c);
		setGroup(null);
		if (c === 'terrain') {
			ctx.viewport.cancel();
			ctx.viewport.stamp.value = null;
			ctx.viewport.tool.value = 'sculpt';
		} else if (ctx.viewport.tool.value === 'sculpt') {
			ctx.viewport.tool.value = 'move';
		}
	};
	const models = category !== 'npc' && category !== 'object' && category !== 'recent';
	const title = CATEGORIES.find(([c]) => c === category)![2];
	return (
		<Panel title="Palette" class="ed-palette">
			<div class="ed-categories" role="tablist">
				{CATEGORIES.map(([c, icon, label]) => (
					<Slot icon={icon} title={label} pressed={category === c} onClick={() => pick(c)} />
				))}
			</div>
			<div class="ed-category-title wow-label">{title}</div>
			{category === 'terrain' && <TerrainPanel ctx={ctx} />}
			{category !== 'recent' && category !== 'terrain' && inCategory.groups.length > 1 && (
				<div class="ed-groups">
					<button class={`ed-chip ${group === null ? 'on' : ''}`} onClick={() => setGroup(null)}>All <span>{inCategory.list.length}</span></button>
					{inCategory.groups.map(([g, n]) => (
						<button class={`ed-chip ${group === g ? 'on' : ''}`} onClick={() => setGroup(group === g ? null : g)}>{g} <span>{n}</span></button>
					))}
				</div>
			)}
			{category !== 'terrain' && <input
				class="wow-input ed-search"
				type="search"
				placeholder={models ? 'Find by name or folder…' : 'Find by name or ID…'}
				value={query}
				spellcheck={false}
				onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && found.shown[0]) void choose(found.shown[0]);
					if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
				}}
			/>}
			{models && category !== 'terrain' && (
				<Check checked={classicOnly} onChange={(on) => {
					setClassicOnly(on);
					store(CLASSIC_KEY, on);
					setGroup(null);
				}} title="Hide the models of later expansions (The Burning Crusade onwards)">Classic only</Check>
			)}
			{category !== 'terrain' && <ul class="ed-list">
				{!rows && category !== 'recent' && <li class="ed-empty wow-muted">Reading the list…</li>}
				{rows && !found.shown.length && (
					<li class="ed-empty wow-muted">{category === 'recent' ? 'What you place shows up here.' : 'Nothing by that name.'}</li>
				)}
				{found.shown.map((r) => (
					<li
						key={`${r.type}:${r.entry}`}
						class={`wow-row ed-row ${stamp?.type === r.type && stamp.entry === r.entry ? 'chosen' : ''}`}
						onClick={() => void choose(r)}
						title={`${r.name} (${r.type === 'npc' ? 'NPC' : r.type === 'object' ? 'object' : 'model file'} ${r.entry})`}
					>
						<Icon name={iconOf(r)} size={28} />
						<span class="ed-row-text">
							<span class="ed-row-name">{r.name}</span>
							<span class="ed-row-sub wow-muted">{r.category === 'npc' || r.category === 'object' ? `${r.sub} · ${r.entry}` : `${r.group} · ${r.sub}`}</span>
						</span>
					</li>
				))}
				{found.total > found.shown.length && <li class="ed-empty wow-muted">{found.total - found.shown.length} more: narrow it down</li>}
			</ul>}
		</Panel>
	);
}

const BRUSHES: [BrushKind, 'raise' | 'lower' | 'flatten' | 'smooth', string, string][] = [
	['raise', 'raise', 'Raise', '1'],
	['lower', 'lower', 'Lower', '2'],
	['flatten', 'flatten', 'Flatten', '3'],
	['smooth', 'smooth', 'Smooth', '4'],
];

/** A brush setting as a slider, with its value. */
function BrushSlider({ label, value, min, max, step, show, onInput, title }: {
	label: string; value: number; min: number; max: number; step: number; show: (v: number) => string; onInput: (v: number) => void; title: string;
}) {
	return (
		<label class="ed-slider" title={title}>
			<span class="wow-label">{label}</span>
			<input type="range" min={min} max={max} step={step} value={value} onInput={(e) => onInput(Number((e.target as HTMLInputElement).value))} />
			<output>{show(value)}</output>
		</label>
	);
}

/** The terrain tool's modes: shape the ground, paint it, flood it. */
const TERRAIN_MODES: [TerrainMode, string][] = [['sculpt', 'Sculpt'], ['paint', 'Paint'], ['water', 'Water']];

/** The terrain tool: its mode, then that mode's brush settings. */
function TerrainPanel({ ctx }: { ctx: EditorContext }) {
	const mode = ctx.viewport.terrainMode.value;
	return (
		<div class="ed-terrain">
			<div class="ed-groups ed-modes" role="tablist">
				{TERRAIN_MODES.map(([m, label]) => (
					<button class={`ed-chip ${mode === m ? 'on' : ''}`} role="tab" aria-selected={mode === m} onClick={() => {
						ctx.viewport.terrainMode.value = m;
						ctx.viewport.tool.value = 'sculpt';
					}}>{label}</button>
				))}
			</div>
			{mode === 'sculpt' && <SculptPanel ctx={ctx} />}
			{mode === 'paint' && <PaintPanel ctx={ctx} />}
			{mode === 'water' && <WaterPanel ctx={ctx} />}
		</div>
	);
}

/** The sculpt brushes: which one, how big, how strong and how soft its edge. */
function SculptPanel({ ctx }: { ctx: EditorContext }) {
	const brush = ctx.viewport.brush;
	const kind = brush.kind.value;
	return (
		<>
			<div class="ed-brushes">
				{BRUSHES.map(([k, icon, label, key]) => (
					<div class="ed-brush">
						<Slot icon={icon} title={label} keyLabel={key} pressed={kind === k} onClick={() => {
							brush.kind.value = k;
							ctx.viewport.tool.value = 'sculpt';
						}} />
						<span class={kind === k ? 'wow-label' : 'wow-muted'}>{label}</span>
					</div>
				))}
			</div>
			<BrushSlider label="Size" value={brush.size.value} min={2} max={80} step={1} show={(v) => `${v} yd`} onInput={(v) => (brush.size.value = v)} title="Brush radius (Alt+wheel)" />
			<BrushSlider label="Strength" value={brush.strength.value} min={0.05} max={1} step={0.05} show={(v) => `${Math.round(v * 100)}%`} onInput={(v) => (brush.strength.value = v)} title="How fast it works (Ctrl+wheel)" />
			<BrushSlider label="Softness" value={brush.softness.value} min={0} max={1} step={0.05} show={(v) => `${Math.round(v * 100)}%`} onInput={(v) => (brush.softness.value = v)} title="How much of the brush fades out towards its edge" />
			<p class="wow-muted ed-hint">
				Hold the left mouse button on the ground. Shift swaps raise and lower; flatten levels to the height where you
				started. Each stroke is one step to undo. Only ground near the camera (in full detail) can be shaped.
			</p>
		</>
	);
}

/** Every texture the paint brush can use, read once. */
let textureList: Promise<TerrainTexture[]> | null = null;
const thumbnails = new Map<number, Promise<string | null>>();
const THUMB_SIZE = 40;
const TEXTURE_LIMIT = 60;

/** A texture as a small picture, made once. */
function thumbnail(ctx: EditorContext, id: number): Promise<string | null> {
	let url = thumbnails.get(id);
	if (!url) {
		url = ctx.storage.loadImages([id]).then(([image]) => {
			if (!image) return null;
			const full = document.createElement('canvas');
			full.width = image.width;
			full.height = image.height;
			full.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
			const small = document.createElement('canvas');
			small.width = small.height = THUMB_SIZE;
			small.getContext('2d')!.drawImage(full, 0, 0, THUMB_SIZE, THUMB_SIZE);
			return small.toDataURL();
		}, () => null);
		thumbnails.set(id, url);
	}
	return url;
}

function TextureThumb({ ctx, id }: { ctx: EditorContext; id: number }) {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void thumbnail(ctx, id).then((u) => live && setUrl(u));
		return () => {
			live = false;
		};
	}, [id]);
	return <span class="ed-texture-thumb" style={url ? { backgroundImage: `url(${url})` } : undefined} />;
}

/** The paint brush: the texture (those on the ground nearby first, or searched), and the brush. */
function PaintPanel({ ctx }: { ctx: EditorContext }) {
	const brush = ctx.viewport.paint;
	const chosen = brush.texture.value;
	const [all, setAll] = useState<TerrainTexture[]>([]);
	const [query, setQuery] = useState('');
	const [nearby, setNearby] = useState<string[]>([]);
	useEffect(() => {
		textureList ??= ctx.storage.listTerrainTextures().catch(() => []);
		void textureList.then(setAll);
		setNearby(ctx.viewport.nearbyTextures());
	}, []);
	const byRef = useMemo(() => new Map(all.map((t) => [t.ref.toLowerCase(), t])), [all]);
	const entry = (ref: string): TerrainTexture | undefined => byRef.get(ref.toLowerCase()) ?? (ref.startsWith('#') ? { ref, id: Number(ref.slice(1)), name: `Texture ${ref.slice(1)}` } : undefined);
	const shown = useMemo(() => {
		const q = searchKey(query.trim());
		if (!q) return nearby.map(entry).filter((t): t is TerrainTexture => !!t);
		const words = q.split(/\s+/);
		return all.filter((t) => words.every((w) => searchKey(t.name).includes(w))).slice(0, TEXTURE_LIMIT);
	}, [query, all, nearby, byRef]);
	const current = chosen ? entry(chosen) : undefined;
	return (
		<>
			<div class="ed-texture-chosen">
				{current ? <TextureThumb ctx={ctx} id={current.id} /> : <span class="ed-texture-thumb" />}
				<span class={current ? 'wow-label' : 'wow-muted'}>{current?.name ?? 'Choose a texture below'}</span>
			</div>
			<BrushSlider label="Size" value={brush.size.value} min={2} max={80} step={1} show={(v) => `${v} yd`} onInput={(v) => (brush.size.value = v)} title="Brush radius (Alt+wheel)" />
			<BrushSlider label="Strength" value={brush.strength.value} min={0.05} max={1} step={0.05} show={(v) => `${Math.round(v * 100)}%`} onInput={(v) => (brush.strength.value = v)} title="How fast it paints (Ctrl+wheel)" />
			<BrushSlider label="Softness" value={brush.softness.value} min={0} max={1} step={0.05} show={(v) => `${Math.round(v * 100)}%`} onInput={(v) => (brush.softness.value = v)} title="How much of the brush fades out towards its edge" />
			<input class="ed-search" type="search" placeholder={all.length ? `Search ${all.length} textures…` : 'Search textures…'} value={query}
				onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
			{!query && <div class="wow-muted ed-hint">{nearby.length ? 'On the ground nearby:' : 'Search, or come close to the ground to see its textures.'}</div>}
			<ul class="ed-list ed-textures">
				{shown.map((t) => (
					<li>
						<button class={`ed-texture ${chosen && chosen.toLowerCase() === t.ref.toLowerCase() ? 'on' : ''}`} title={t.name} onClick={() => {
							brush.texture.value = t.ref;
							ctx.viewport.tool.value = 'sculpt';
						}}>
							<TextureThumb ctx={ctx} id={t.id} />
							<span>{t.name.split(' / ').pop()}</span>
						</button>
					</li>
				))}
			</ul>
		</>
	);
}

const WATER_KINDS: [Exclude<WaterType, 'none'>, string][] = [['water', 'Water'], ['ocean', 'Ocean'], ['magma', 'Magma'], ['slime', 'Slime']];

/** The water brush: what it floods with, adding or drying, and at what level. */
function WaterPanel({ ctx }: { ctx: EditorContext }) {
	const brush = ctx.viewport.water;
	const fixed = brush.level.value;
	return (
		<>
			<div class="ed-groups">
				{WATER_KINDS.map(([k, label]) => (
					<button class={`ed-chip ${brush.type.value === k ? 'on' : ''}`} onClick={() => (brush.type.value = k)}>{label}</button>
				))}
			</div>
			<div class="ed-groups">
				<button class={`ed-chip ${brush.mode.value === 'add' ? 'on' : ''}`} onClick={() => (brush.mode.value = 'add')}>Flood</button>
				<button class={`ed-chip ${brush.mode.value === 'remove' ? 'on' : ''}`} onClick={() => (brush.mode.value = 'remove')}>Dry</button>
			</div>
			<BrushSlider label="Size" value={brush.size.value} min={2} max={80} step={1} show={(v) => `${v} yd`} onInput={(v) => (brush.size.value = v)} title="Brush radius (Alt+wheel)" />
			<Check checked={fixed !== null} onChange={(on) => void (brush.level.value = on ? Math.round(brush.lastLevel * 2) / 2 : null)}
				title="Off: each stroke takes the level of the water it starts in, or a little above the ground">Fixed level</Check>
			{fixed !== null
				? <label class="ed-slider" title="Height of the water's surface (yards)">
					<span class="wow-label">Level</span>
					<input type="number" step={0.5} value={fixed} onChange={(e) => (brush.level.value = Number((e.target as HTMLInputElement).value))} />
					<output>yd</output>
				</label>
				: <BrushSlider label="Depth" value={brush.depth.value} min={0.5} max={10} step={0.5} show={(v) => `${v} yd`} onInput={(v) => (brush.depth.value = v)} title="How deep new water is, over the ground where a stroke starts on dry land" />}
			<p class="wow-muted ed-hint">
				Hold the left mouse button over the ground. Each stroke floods at one level: the water it starts in, else a little above
				the ground. Shift dries instead. A chunk (about 33 yards) holds one flat liquid, so flooding part of one sets the whole of
				its liquid to that level.
			</p>
		</>
	);
}
