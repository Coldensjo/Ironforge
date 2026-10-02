import { batch, computed, signal } from '@preact/signals';
import * as THREE from 'three';
import { TILE_SIZE } from '../formats/adt';
import { spawnKind, spawnPlacement, type SpawnInfo, type SpawnType } from '../explorer/spawns';
import type { ObjectManager } from '../viewer/objects';
import { LATTICE_POINTS } from '../viewer/terrainEdit';
import type { ContinentPlacement } from '../viewer/terrain';

/**
 * An edited spawn as it now is. Deleted ones keep their details (deleted: true), so the outliner
 * can still name them; null is a deletion saved before that (name unknown). Unedited spawns have
 * no entry at all.
 */
export type SpawnEdit = SpawnInfo | null;

/** Edits by spawn: `${map}:${type}:${guid}`. */
export const spawnId = (info: Pick<SpawnInfo, 'type' | 'guid' | 'place'>) => `${info.place.map}:${info.type}:${info.guid}`;

/** Whether an edit removes its spawn. */
export const isDeleted = (edit: SpawnEdit | undefined) => edit === null || !!edit?.deleted;

/** One spawn's part of a change; undefined is unedited (or, for new ones, not there). */
export interface SpawnChange {
	id: string;
	before: SpawnEdit | undefined;
	after: SpawnEdit | undefined;
}

/**
 * Ground heights a step changed on one tile (by its height key, map:x_y): the lattice points it
 * touched, and their height changes (from the map's own heights) before and after.
 */
export interface TerrainPatch {
	tile: string;
	points: Uint32Array;
	before: Float32Array;
	after: Float32Array;
}

/** One undoable step: every spawn it changed, and any ground. */
interface Step {
	changes: SpawnChange[];
	terrain?: TerrainPatch[];
	/** Steps of the same gesture (wheel turns, nudges) fold into one. */
	merge?: string;
	time: number;
}

/** Steps within this long (ms) of each other with the same merge key undo together. */
const MERGE_TIME = 800;
/** Guids for new NPCs and objects start here, well above VMaNGOS's own. */
const FIRST_NEW_GUID = 9_000_000;
/** The same for new copies of the map's own models, above any ADT placement's unique ID. */
const FIRST_NEW_MODEL_ID = 1_000_000_000;
const DB_NAME = 'mapExplorer';
/** Version 2 added the ground's height changes, 3 the browser's saved projects. */
const DB_VERSION = 3;
const DB_STORES = ['spawnEdits', 'terrainEdits', 'projects'];
const EXPORT_FORMAT = 'mapexplorer-spawn-edits';

let database: Promise<IDBDatabase | null> | null = null;

/** The browser's database for edits (IndexedDB), with a store for each kind; null without storage. */
function openDatabase(): Promise<IDBDatabase | null> {
	database ??= new Promise((resolve) => {
		try {
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				for (const name of DB_STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return database;
}

/** Edits saved in the browser, so they're still there next visit. Without storage, they last the visit. */
export class EditStore<T> {
	constructor(private readonly name: string) {}

	async all(): Promise<[string, T][]> {
		const db = await openDatabase();
		if (!db) return [];
		return new Promise((resolve) => {
			const out: [string, T][] = [];
			try {
				const request = db.transaction(this.name).objectStore(this.name).openCursor();
				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) return resolve(out);
					out.push([String(cursor.key), cursor.value as T]);
					cursor.continue();
				};
				request.onerror = () => resolve(out);
			} catch {
				resolve(out);
			}
		});
	}

	/** Saves an edit (undefined forgets it); resolves once it's written. */
	async put(id: string, value: T | undefined): Promise<void> {
		await this.write((store) => (value === undefined ? store.delete(id) : store.put(value, id)), 'Edit not saved:');
	}

	/** Forgets everything in the store; resolves once that's written. */
	async clear(): Promise<void> {
		await this.write((store) => store.clear(), 'Edits not cleared:');
	}

	/** One read-write step, waited for until the database has it (a reload straight after keeps it). */
	private async write(step: (store: IDBObjectStore) => void, failure: string): Promise<void> {
		const db = await openDatabase();
		if (!db) return;
		await new Promise<void>((resolve) => {
			try {
				const transaction = db.transaction(this.name, 'readwrite');
				step(transaction.objectStore(this.name));
				transaction.oncomplete = () => resolve();
				transaction.onerror = transaction.onabort = () => {
					console.warn(failure, transaction.error);
					resolve();
				};
			} catch (e) {
				console.warn(failure, e);
				resolve();
			}
		});
	}
}

/** Float32Array <-> base64, for ground in exported files. */
export function toBase64(values: Float32Array): string {
	const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
	let text = '';
	for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(text);
}

export function fromBase64(text: string): Float32Array {
	const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
	return new Float32Array(bytes.buffer);
}

/** Where the document draws: the object manager and where each map lies in the world. */
export interface DocumentHost {
	objects: ObjectManager;
	mapPlacement(mapId: number): ContinentPlacement | null;
	/** Shows a tile's ground height changes again (if the tile is loaded in detail). */
	refreshTerrain(tile: string): void;
}

/**
 * The world as edited: one edit per changed spawn on top of the spawn data, an undo history of
 * steps that can each change many spawns, and the selection. Every change goes through here,
 * and everything that shows it (the 3D view, the inspector, the outliner) reads it from here.
 */
export class EditDocument {
	private readonly edits = new Map<string, SpawnEdit>();
	/** Shown but not yet recorded: spawns being dragged, or carried before a click puts them down. */
	private readonly previews = new Map<string, SpawnInfo>();
	/** Spawns as the data has them, kept from when they were first picked or changed. */
	private readonly originals = new Map<string, SpawnInfo>();
	private readonly store = new EditStore<SpawnEdit>('spawnEdits');
	/** Ground height changes per tile (map:x_y), one per lattice point (see HeightTile). */
	private readonly terrain = new Map<string, Float32Array>();
	private readonly terrainStore = new EditStore<Float32Array>('terrainEdits');
	private undoStack: Step[] = [];
	private redoStack: Step[] = [];

	/** Bumped on every change, for anything that lists or counts edits. */
	readonly version = signal(0);
	/** The selected spawns, as they now are. */
	readonly selection = signal<SpawnInfo[]>([]);
	readonly canUndo = signal(false);
	readonly canRedo = signal(false);
	readonly count = computed(() => (this.version.value, this.edits.size + this.terrain.size));

	constructor(private readonly host: DocumentHost) {}

	/** Reads the saved edits and shows them. Call once the maps are laid out. */
	async load(): Promise<void> {
		for (const [id, edit] of await this.store.all()) {
			if (this.edits.has(id)) continue; // edited already, while loading
			this.edits.set(id, edit);
			this.draw(id, edit);
		}
		for (const [tile, delta] of await this.terrainStore.all()) {
			if (this.terrain.has(tile) || delta.length !== LATTICE_POINTS) continue;
			this.terrain.set(tile, delta);
			this.host.refreshTerrain(tile);
		}
		this.changed();
	}

	/** A spawn as it now is: its edit, or as the data has it (undefined if deleted or unknown). */
	current(id: string): SpawnInfo | undefined {
		const edit = this.previews.get(id) ?? (this.edits.has(id) ? this.edits.get(id) : this.originals.get(id));
		return edit && !edit.deleted ? edit : undefined;
	}

	/** Whether a spawn has been changed (or added, or deleted). */
	isEdited(id: string): boolean {
		return this.edits.has(id);
	}

	/** Every edit, for the outliner: the spawn (as it was, if deleted) and what happened to it. */
	list(): { id: string; info: SpawnInfo | null; state: 'added' | 'changed' | 'deleted' }[] {
		return [...this.edits].map(([id, edit]) => ({
			id,
			info: edit ?? this.originals.get(id) ?? null,
			state: isDeleted(edit) ? 'deleted' : edit?.created ? 'added' : 'changed',
		}));
	}

	/** Remembers a spawn as the data has it, the first time it's picked. */
	remember(info: SpawnInfo): SpawnInfo {
		const id = spawnId(info);
		if (!this.edits.has(id) && !this.originals.has(id)) this.originals.set(id, info);
		return this.current(id) ?? info;
	}

	// --- Selection ---

	select(infos: SpawnInfo[]): void {
		this.selection.value = infos.map((i) => this.remember(i));
	}

	/** Adds a spawn to the selection, or takes it out if it's in already. */
	toggle(info: SpawnInfo): void {
		const id = spawnId(info);
		const now = this.selection.value;
		this.selection.value = now.some((s) => spawnId(s) === id) ? now.filter((s) => spawnId(s) !== id) : [...now, this.remember(info)];
	}

	/** Refreshes the selection from the edits (after a change), dropping what's gone. */
	private refreshSelection(): void {
		this.selection.value = this.selection.value.map((s) => this.current(spawnId(s))).filter((s): s is SpawnInfo => !!s);
	}

	// --- Changing ---

	/** Records a step (unless it changes nothing) and applies it. */
	commit(changes: SpawnChange[], merge?: string): void {
		const real = changes.filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
		if (!real.length) return;
		const now = performance.now();
		const last = this.undoStack.at(-1);
		const sameIds = last && last.changes.length === real.length && last.changes.every((c, i) => c.id === real[i].id);
		if (merge && last?.merge === merge && sameIds && now - last.time < MERGE_TIME) {
			last.changes.forEach((c, i) => (c.after = real[i].after));
			last.time = now;
		} else {
			this.undoStack.push({ changes: real, merge, time: now });
		}
		this.redoStack = [];
		batch(() => {
			for (const c of real) this.apply(c.id, c.after);
			this.refreshSelection();
			this.changed();
		});
	}

	/** Changes spawns by a function of each, as one step. */
	update(infos: SpawnInfo[], change: (info: SpawnInfo) => SpawnInfo, merge?: string): void {
		this.commit(infos.map((info) => {
			const id = spawnId(info);
			return { id, before: this.edits.get(id), after: change(this.current(id) ?? info) };
		}), merge);
	}

	/** Deletes spawns: new ones simply go, those from the data are kept as deleted. */
	remove(infos: SpawnInfo[]): void {
		this.commit(infos.map((info) => {
			const id = spawnId(info);
			return { id, before: this.edits.get(id), after: info.created ? undefined : { ...info, deleted: true } };
		}));
	}

	/** Puts spawns back as the data has them (new ones are left alone). */
	revert(infos: SpawnInfo[]): void {
		this.commit(infos.filter((i) => !i.created).map((info) => {
			const id = spawnId(info);
			return { id, before: this.edits.get(id), after: undefined };
		}));
	}

	/** Shows a spawn changed without recording it (while it's being dragged). */
	preview(info: SpawnInfo): void {
		const id = spawnId(info);
		this.previews.set(id, info);
		this.draw(id, info);
	}

	/** Drops a preview: the spawn shows as recorded again. */
	restore(id: string): void {
		if (!this.previews.delete(id)) return;
		this.draw(id, this.edits.get(id));
	}

	/** A spawn's recorded edit (undefined: none). */
	editOf(id: string): SpawnEdit | undefined {
		return this.edits.get(id);
	}

	/** A spawn as it's shown now: its preview, else its recorded edit. */
	shown(id: string): SpawnEdit | undefined {
		return this.previews.get(id) ?? this.edits.get(id);
	}

	undo(): void {
		const step = this.undoStack.pop();
		if (!step) return;
		batch(() => {
			for (const c of [...step.changes].reverse()) this.apply(c.id, c.before);
			for (const t of step.terrain ?? []) this.applyTerrain(t, t.before);
			this.redoStack.push(step);
			this.refreshSelection();
			this.changed();
		});
	}

	redo(): void {
		const step = this.redoStack.pop();
		if (!step) return;
		batch(() => {
			for (const c of step.changes) this.apply(c.id, c.after);
			for (const t of step.terrain ?? []) this.applyTerrain(t, t.after);
			this.undoStack.push(step);
			this.refreshSelection();
			this.changed();
		});
	}

	// --- Ground ---

	/** A tile's ground height changes (by lattice point); with create, made if it has none yet. */
	heightDelta(tile: string, create = false): Float32Array | undefined {
		let delta = this.terrain.get(tile);
		if (!delta && create) {
			delta = new Float32Array(LATTICE_POINTS);
			this.terrain.set(tile, delta);
		}
		return delta;
	}

	/**
	 * Records ground already changed (a brush stroke wrote the deltas as it went) as a step,
	 * and saves the tiles.
	 */
	commitTerrain(patches: TerrainPatch[]): void {
		if (!patches.length) return;
		this.undoStack.push({ changes: [], terrain: patches, time: performance.now() });
		this.redoStack = [];
		for (const p of patches) void this.terrainStore.put(p.tile, this.terrain.get(p.tile));
		this.changed();
	}

	/** Puts a tile's ground back as the map has it, as a step. */
	revertTerrain(tile: string): void {
		const delta = this.terrain.get(tile);
		if (!delta) return;
		const points: number[] = [];
		for (let i = 0; i < delta.length; i++) if (delta[i] !== 0) points.push(i);
		const patch: TerrainPatch = { tile, points: Uint32Array.from(points), before: Float32Array.from(points, (i) => delta[i]), after: new Float32Array(points.length) };
		this.applyTerrain(patch, patch.after);
		this.commitTerrain([patch]);
	}

	/** Tiles whose ground has been reshaped, for the outliner. */
	terrainTiles(): string[] {
		return [...this.terrain.keys()];
	}

	/** Writes one side of a patch into a tile's deltas, shows it and saves it. */
	private applyTerrain(patch: TerrainPatch, values: Float32Array): void {
		const delta = this.heightDelta(patch.tile, true)!;
		patch.points.forEach((p, k) => (delta[p] = values[k]));
		// Nothing left changed: the tile is the map's own again.
		if (delta.every((v) => v === 0)) {
			this.terrain.delete(patch.tile);
			void this.terrainStore.put(patch.tile, undefined);
		} else {
			void this.terrainStore.put(patch.tile, delta);
		}
		this.host.refreshTerrain(patch.tile);
	}

	/** A guid no spawn of this type on this map has. */
	nextGuid(type: SpawnType, map: number): number {
		const prefix = `${map}:${type}:`;
		let guid = type === 'm2' || type === 'wmo' ? FIRST_NEW_MODEL_ID : FIRST_NEW_GUID;
		for (const id of [...this.edits.keys(), ...this.previews.keys()]) if (id.startsWith(prefix)) guid = Math.max(guid, Number(id.slice(prefix.length)) + 1);
		return guid;
	}

	// --- Files ---

	/** Every edit, as a file to keep or share. */
	exportJson(): string {
		const terrain = Object.fromEntries([...this.terrain].map(([tile, delta]) => [tile, toBase64(delta)]));
		return JSON.stringify({ format: EXPORT_FORMAT, version: 2, edits: Object.fromEntries(this.edits), terrain });
	}

	/** Adds the edits in a file made by exportJson; returns how many. Not undoable. */
	importJson(text: string): number {
		const file = JSON.parse(text) as { format?: string; edits?: Record<string, SpawnEdit>; terrain?: Record<string, string> };
		if (file.format !== EXPORT_FORMAT || !file.edits) throw new Error('Not a MapExplorer edits file');
		let n = 0;
		batch(() => {
			for (const [id, edit] of Object.entries(file.edits!)) {
				if (edit !== null && (typeof edit !== 'object' || !edit.place)) continue;
				this.apply(id, edit);
				n++;
			}
			for (const [tile, data] of Object.entries(file.terrain ?? {})) {
				const delta = fromBase64(data);
				if (delta.length !== LATTICE_POINTS) continue;
				this.terrain.set(tile, delta);
				void this.terrainStore.put(tile, delta);
				this.host.refreshTerrain(tile);
				n++;
			}
			this.undoStack = [];
			this.redoStack = [];
			this.refreshSelection();
			this.changed();
		});
		return n;
	}

	/** Back to the spawn data everywhere. Not undoable. */
	clearAll(): void {
		batch(() => {
			for (const id of [...this.edits.keys(), ...this.previews.keys()]) this.draw(id, undefined);
			this.edits.clear();
			this.previews.clear();
			const tiles = [...this.terrain.keys()];
			this.terrain.clear();
			for (const tile of tiles) this.host.refreshTerrain(tile);
			void this.terrainStore.clear();
			void this.store.clear();
			this.undoStack = [];
			this.redoStack = [];
			this.selection.value = [];
			this.changed();
		});
	}

	// --- Drawing ---

	/** Sets a spawn's edit, draws it and saves it. */
	private apply(id: string, edit: SpawnEdit | undefined): void {
		this.previews.delete(id);
		if (edit === undefined) this.edits.delete(id);
		else this.edits.set(id, edit);
		this.draw(id, edit);
		void this.store.put(id, edit);
	}

	private draw(id: string, edit: SpawnEdit | undefined): void {
		const [map, type, guid] = id.split(':');
		const placement = this.host.mapPlacement(Number(map));
		if (!placement) return;
		const offset = new THREE.Vector3(placement.offsetX * TILE_SIZE, 0, placement.offsetY * TILE_SIZE);
		const drawn = edit === undefined ? undefined : isDeleted(edit) ? null : spawnPlacement(edit!);
		this.host.objects.setEdit(placement.wdt, offset, spawnKind(type as SpawnType), Number(guid), drawn);
	}

	private changed(): void {
		this.canUndo.value = this.undoStack.length > 0;
		this.canRedo.value = this.redoStack.length > 0;
		this.version.value++;
	}
}

/**
 * Replaces the working copy saved in the browser (what the document loads) with a project's
 * edits and ground, before the world loads; the document then reads them as it starts.
 */
export async function replaceWorkingCopy(edits: Record<string, SpawnEdit>, terrain: Record<string, string>): Promise<void> {
	const spawns = new EditStore<SpawnEdit>('spawnEdits');
	const ground = new EditStore<Float32Array>('terrainEdits');
	await Promise.all([spawns.clear(), ground.clear()]);
	await Promise.all([
		...Object.entries(edits).map(([id, edit]) => spawns.put(id, edit)),
		...Object.entries(terrain).map(([tile, data]) => ground.put(tile, fromBase64(data))),
	]);
}
