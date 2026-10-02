import type { SpawnInfo, SpawnPlace } from '../../explorer/spawns';
import { creatureIcon, type IconName } from '../../ui/wowSkin';
import { spawnId } from '../document';
import { canPose, POSES } from '../poses';
import { turned } from '../viewport';
import { Icon, NumberField, Panel } from './common';
import type { EditorContext } from './context';

const DEGREES = 180 / Math.PI;

/** The value every spawn shares, or null where they differ. */
function shared(infos: SpawnInfo[], get: (p: SpawnPlace) => number): number | null {
	const first = get(infos[0].place);
	return infos.every((i) => Math.abs(get(i.place) - first) < 1e-6) ? first : null;
}

export function iconFor(info: SpawnInfo): IconName {
	if (info.type === 'npc') return creatureIcon(info.kind);
	if (info.type === 'm2') return 'props';
	if (info.type === 'wmo') return 'town';
	return info.kind === 'Text' ? 'note' : 'object';
}

/** What a spawn is, in a few words. */
function describe(info: SpawnInfo): string {
	if (info.type === 'm2' || info.type === 'wmo') return `${info.kind} · model file ${info.entry}`;
	const what = info.type === 'npc' ? [info.level && `Level ${info.level}`, info.kind, info.rank] : ['Object', info.kind];
	return [...what, `ID ${info.entry}`].filter(Boolean).join(' · ');
}

/**
 * The selection's properties: where it stands, which way it faces, its size and (NPCs) its
 * pose. With several selected, a field shows the value they share and sets it on all of them.
 */
export function Inspector({ ctx }: { ctx: EditorContext }) {
	const { doc, viewport } = ctx;
	const selected = doc.selection.value;
	void doc.version.value; // edited state shows

	if (!selected.length) {
		return (
			<Panel title="Inspector" class="ed-inspector">
				<p class="wow-muted ed-hint">Click an NPC, an object or one of the map's props to change it. Drag a box to pick several.</p>
			</Panel>
		);
	}
	const one = selected.length === 1 ? selected[0] : null;
	const set = (change: (s: SpawnInfo) => SpawnInfo) => doc.update(selected, change);
	const setPlace = (key: keyof SpawnPlace, v: number) => set((s) => ({ ...s, place: { ...s.place, [key]: v } }));
	const npcs = selected.filter((s) => s.type === 'npc');
	const pose = npcs.length && npcs.every((n) => (n.place.pose ?? 0) === (npcs[0].place.pose ?? 0)) ? String(npcs[0].place.pose ?? 0) : '';
	const animations = npcs.length === 1 ? viewport.animationsOf(npcs[0]) : undefined;
	const edited = selected.some((s) => doc.isEdited(spawnId(s)) && !s.created);

	return (
		<Panel title="Inspector" class="ed-inspector">
			{one ? (
				<div class="ed-ident">
					<Icon name={iconFor(one)} size={36} />
					<div>
						<h3 class="wow-title ed-name">{one.name}</h3>
						{one.subname && <div class="wow-label ed-subname">&lt;{one.subname}&gt;</div>}
						<div class="wow-muted ed-desc">{describe(one)}{one.created ? ' · new' : ''}</div>
					</div>
				</div>
			) : (
				<div class="ed-ident">
					<h3 class="wow-title ed-name">{selected.length} selected</h3>
				</div>
			)}
			<div class="ed-fields">
				{one && <NumberField label="X" value={one.place.x} step={0.5} onCommit={(v) => setPlace('x', v)} />}
				{one && <NumberField label="Y" value={one.place.y} step={0.5} onCommit={(v) => setPlace('y', v)} />}
				<NumberField label="Z" value={shared(selected, (p) => p.z)} step={0.1} onCommit={(v) => setPlace('z', v)} />
				<NumberField
					label="Facing"
					value={(() => {
						const o = shared(selected, (p) => p.o);
						return o === null ? null : o * DEGREES;
					})()}
					step={5}
					digits={1}
					onCommit={(v) => set((s) => turned(s, (((v % 360) + 360) % 360) / DEGREES - s.place.o))}
				/>
				<NumberField label="Scale" value={shared(selected, (p) => p.scale)} step={0.05} digits={3} onCommit={(v) => v > 0 && setPlace('scale', v)} />
			</div>
			{npcs.length > 0 && (
				<label class="ed-field ed-pose">
					<span class="wow-label">Pose</span>
					<select
						class="wow-input"
						value={pose}
						onChange={(e) => {
							const id = Number((e.target as HTMLSelectElement).value);
							doc.update(npcs, (s) => ({ ...s, place: { ...s.place, pose: id || undefined } }));
						}}
					>
						{pose === '' && <option value="">Mixed</option>}
						{POSES.map(([group, poses]) => (
							<optgroup label={group}>
								{poses.map(([id, name]) => (
									<option value={String(id)} disabled={!!animations && id !== 0 && !canPose(animations, id)}>{name}</option>
								))}
							</optgroup>
						))}
					</select>
				</label>
			)}
			<div class="ed-buttons">
				<button class="wow-button" onClick={() => viewport.duplicate()} title="Ctrl+D">Duplicate</button>
				<button class="wow-button" onClick={() => viewport.remove()} title="Delete">Delete</button>
				<button class="wow-button" disabled={!edited} onClick={() => doc.revert(selected)} title="Back to how the spawn data has it">Original</button>
			</div>
		</Panel>
	);
}

const STATE_MARK = { added: '+', changed: '~', deleted: '−' } as const;

/** Every change made: click one to select it and fly there; deleted ones can be brought back. */
export function Outliner({ ctx }: { ctx: EditorContext }) {
	const { doc, viewport } = ctx;
	void doc.version.value;
	const rows = doc.list();
	const ground = doc.terrainTiles();
	const selected = new Set(doc.selection.value.map(spawnId));
	return (
		<Panel title={`Changes (${rows.length + ground.length})`} class="ed-outliner">
			{!rows.length && !ground.length && <p class="wow-muted ed-hint">Nothing changed yet. What you move, place or delete is listed here.</p>}
			<ul class="ed-list">
				{rows.map(({ id, info, state }) => (
					<li
						key={id}
						class={`wow-row ed-row ed-change ${selected.has(id) ? 'chosen' : ''} ${state}`}
						onClick={() => {
							if (state === 'deleted' || !info) return;
							doc.select([info]);
							viewport.focusSelection();
						}}
					>
						<span class={`ed-mark ${state}`}>{STATE_MARK[state]}</span>
						{info && <Icon name={iconFor(info)} size={20} />}
						<span class="ed-row-name">{info?.name ?? `Deleted spawn ${id.split(':')[2]}`}</span>
						{state === 'deleted' && info && (
							<button class="wow-button ed-small" onClick={(e) => { e.stopPropagation(); doc.revert([info]); }}>Restore</button>
						)}
					</li>
				))}
				{ground.map((tile) => (
					<li key={tile} class="wow-row ed-row ed-change changed" title="Ground reshaped on this map tile">
						<span class="ed-mark changed">~</span>
						<Icon name="terrain" size={20} />
						<span class="ed-row-name">Ground, tile {tile.split(':')[1].replace('_', ', ')}</span>
						<button class="wow-button ed-small" onClick={() => doc.revertTerrain(tile)} title="Put this tile's ground back as the map has it">Restore</button>
					</li>
				))}
			</ul>
		</Panel>
	);
}
