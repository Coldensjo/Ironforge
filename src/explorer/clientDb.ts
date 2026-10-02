import type { GameStorage } from '../casc/storage';
import { Db2 } from '../formats/db2';
import type { LiquidKind } from '../formats/mh2o';
import { vanillaTable } from '../mpq/vanillaTables';
import { VanillaStorage } from '../mpq/vanillaStorage';

/** File IDs of client database tables (DBFilesClient/*.db2); they're unnamed in the root. */
export const DB2_FILES = {
	AreaPOI: 1000630,
	AreaTable: 1353545,
	GroundEffectDoodad: 1308057,
	GroundEffectTexture: 1308499,
	Light: 1375579,
	LightData: 1375580,
	LightParams: 1334669,
	LiquidType: 1371380,
	Lock: 1343608,
	Map: 1349477,
	SoundAmbience: 1310628,
	SoundKitEntry: 1237435,
	UiMap: 1957206,
	UiMapAssignment: 1957219,
	WMOAreaTable: 1355528,
	ZoneIntroMusicTable: 1310251,
	ZoneMusic: 1310254,
} as const;

/**
 * A client table as the engine reads one: rows by ID, fields by index, some fields arrays. The
 * modern client's DB2 files are read as they are; the original client's DBC files are made to
 * look like them here.
 */
export interface Table {
	readonly fieldCount: number;
	ids(): number[];
	has(id: number): boolean;
	arrayLength(field: number): number;
	getInt(id: number, field: number, arrayIndex?: number): number | null;
	getFloat(id: number, field: number, arrayIndex?: number): number | null;
	getString(id: number, field: number, arrayIndex?: number): string | null;
	/** DB2 relationship fields; the original client's tables have none. */
	getParent(id: number): number | null;
}

const tables = new WeakMap<GameStorage, Map<number, Promise<Table>>>();

/**
 * Loads a table once per storage. Encrypted sections are skipped rather than failing. The
 * original client's tables are read from its DBC files, in the modern ones' shape.
 */
export function loadTable(storage: GameStorage, fdid: number): Promise<Table> {
	let cache = tables.get(storage);
	if (!cache) {
		cache = new Map();
		tables.set(storage, cache);
	}
	let table = cache.get(fdid);
	if (!table) {
		const name = Object.entries(DB2_FILES).find(([, id]) => id === fdid)?.[0];
		const vanilla = storage instanceof VanillaStorage && name ? vanillaTable(storage, name) : null;
		table = vanilla ?? storage.readFileWithStatus(fdid, true).then(({ data }): Table => new Db2(data));
		cache.set(fdid, table);
	}
	return table;
}

/** How a liquid looks from inside it (LiquidType.db2). */
export interface LiquidLook {
	/** The deep colour the view fades to, 0xRRGGBB; 0 when the type has none (older liquids). */
	color: number;
	/** The surface's colours from the shore to deep water, 0xRRGGBB; 0 where the type has none. */
	colors: [number, number, number];
	/** Foam along the shore, 0xRRGGBB; 0 where the type has none. */
	foam: number;
	/** Yards below the surface at which darkening is complete, and how much it darkens fog, ambient and sun light (0-1). */
	darkenDepth: number;
	fogDarken: number;
	ambientDarken: number;
	sunDarken: number;
}

export interface LiquidLooks {
	types: Record<number, LiquidLook>;
	/** The type of the open sea (drawn as one plane, so it has no type of its own). */
	ocean: number;
}

/** LiquidType fields. */
const LIQUID_DARKEN_DEPTH = 6;
const LIQUID_FOG_DARKEN = 7;
const LIQUID_AMBIENT_DARKEN = 8;
const LIQUID_SUN_DARKEN = 9;
const LIQUID_FOAM_COLOR = 15;
const LIQUID_COLORS = 17;

/** Underwater looks of every liquid type. */
export async function liquidLooks(storage: GameStorage): Promise<LiquidLooks> {
	const table = await loadTable(storage, DB2_FILES.LiquidType);
	const types: Record<number, LiquidLook> = {};
	let ocean = 2;
	for (const id of table.ids()) {
		const name = table.getString(id, 0) ?? '';
		if (name === 'PBRWater - Generic - Ocean') ocean = id;
		// Three colours, lightest to deepest; the view fades to the deepest. Only the newer
		// (PBRWater) types have them, and only those have a foam colour too.
		const colors = [0, 1, 2].map((k) => (table.getInt(id, LIQUID_COLORS, k) ?? 0) & 0xffffff) as [number, number, number];
		types[id] = {
			color: colors[2],
			colors,
			foam: colors[2] ? (table.getInt(id, LIQUID_FOAM_COLOR) ?? 0) & 0xffffff : 0,
			darkenDepth: table.getFloat(id, LIQUID_DARKEN_DEPTH) ?? 0,
			fogDarken: table.getFloat(id, LIQUID_FOG_DARKEN) ?? 0,
			ambientDarken: table.getFloat(id, LIQUID_AMBIENT_DARKEN) ?? 0,
			sunDarken: table.getFloat(id, LIQUID_SUN_DARKEN) ?? 0,
		};
	}
	return { types, ocean };
}

/** What opening a lock takes: a gathering skill, or picking it. */
export type LockKind = 'herb' | 'ore' | 'lockbox';

/** Lock fields: [8] arrays of index, required skill and key type. */
const LOCK_INDEX = 1;
const LOCK_SKILL = 2;
const LOCK_TYPE = 3;
/** Key type 2 is a lock type (LockType.db2), whose ID is in the index field. */
const KEY_LOCK_TYPE = 2;
const LOCK_KINDS: Record<number, LockKind> = { 1: 'lockbox', 2: 'herb', 3: 'ore' };

/**
 * Locks that take Herbalism, Mining or Lockpicking, by Lock ID (game object data0 for chests,
 * which is what herbs and ore veins are). Quest objects gathered without the skill need none.
 */
export async function lockKinds(storage: GameStorage): Promise<Record<number, LockKind>> {
	const table = await loadTable(storage, DB2_FILES.Lock);
	const kinds: Record<number, LockKind> = {};
	for (const id of table.ids()) {
		for (let k = 0; k < 8; k++) {
			const kind = LOCK_KINDS[table.getInt(id, LOCK_INDEX, k) ?? 0];
			if (kind && table.getInt(id, LOCK_TYPE, k) === KEY_LOCK_TYPE && (table.getInt(id, LOCK_SKILL, k) ?? 0) > 0) {
				kinds[id] = kind;
				break;
			}
		}
	}
	return kinds;
}

/** Classifies liquid types by name ("Ocean", "Magma", "PBRWater - Generic - Lake", ...). */
export async function liquidKinds(storage: GameStorage): Promise<(type: number) => LiquidKind> {
	let table: Table | null = null;
	try {
		table = await loadTable(storage, DB2_FILES.LiquidType);
	} catch (e) {
		console.warn('LiquidType.db2 unavailable, treating all liquids as water', e);
	}
	const cache = new Map<number, LiquidKind>();
	return (type) => {
		let kind = cache.get(type);
		if (!kind) {
			const name = (table?.getString(type, 0) ?? '').toLowerCase();
			kind = /ocean|sea/.test(name) ? 'ocean' : /magma|lava/.test(name) ? 'magma' : /slime/.test(name) ? 'slime' : 'water';
			cache.set(type, kind);
		}
		return kind;
	};
}
