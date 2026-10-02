import { modelPath, wdtPath } from '../formats/vanilla';
import { Dbc } from './dbc';
import type { Table } from '../explorer/clientDb';
import type { VanillaStorage } from './vanillaStorage';

type Value = number | string | null;
type Field = Value | Value[];

/** A table built in memory: each row its fields, at the modern table's field indices. */
class RowTable implements Table {
	readonly fieldCount: number;

	constructor(private readonly rows: Map<number, Field[]>) {
		let count = 0;
		for (const row of rows.values()) count = Math.max(count, row.length);
		this.fieldCount = count;
	}

	ids(): number[] {
		return [...this.rows.keys()];
	}

	has(id: number): boolean {
		return this.rows.has(id);
	}

	arrayLength(field: number): number {
		for (const row of this.rows.values()) {
			const value = row[field];
			if (Array.isArray(value)) return value.length;
		}
		return 1;
	}

	private value(id: number, field: number, k: number): Value | undefined {
		const value = this.rows.get(id)?.[field];
		return Array.isArray(value) ? value[k] : k === 0 ? value : undefined;
	}

	getInt(id: number, field: number, k = 0): number | null {
		const v = this.value(id, field, k);
		return typeof v === 'number' ? v : null;
	}

	getFloat(id: number, field: number, k = 0): number | null {
		return this.getInt(id, field, k);
	}

	getString(id: number, field: number, k = 0): string | null {
		const v = this.value(id, field, k);
		return typeof v === 'string' ? v : null;
	}

	getParent(): number | null {
		return null;
	}
}

/** Fields of a DBC row, read by column. */
interface Columns {
	int(column: number): number;
	float(column: number): number;
	string(column: number): string;
	ints(column: number, count: number): number[];
}

/** A DBC's rows rebuilt, keyed by what row() returns (by default the row's ID); null skips a row. */
async function rebuild(storage: VanillaStorage, name: string, row: (c: Columns, id: number) => [number, Field[]] | Field[] | null, keyed = false): Promise<RowTable> {
	const dbc = await readDbc(storage, name);
	const rows = new Map<number, Field[]>();
	for (const id of dbc.ids()) {
		const c: Columns = {
			int: (column) => dbc.getInt(id, column) ?? 0,
			float: (column) => dbc.getFloat(id, column) ?? 0,
			string: (column) => dbc.getString(id, column) ?? '',
			ints: (column, count) => Array.from({ length: count }, (_, k) => dbc.getInt(id, column + k) ?? 0),
		};
		const out = row(c, id);
		if (!out) continue;
		if (keyed) {
			const [key, fields] = out as [number, Field[]];
			rows.set(key, fields);
		} else {
			rows.set(id, out as Field[]);
		}
	}
	return new RowTable(rows);
}

/** Fields at the given indices, the rest left empty. */
function at(fields: Record<number, Field>): Field[] {
	const out: Field[] = [];
	for (const [i, v] of Object.entries(fields)) out[Number(i)] = v;
	return out;
}

/** 1.12 column layouts (from the client's own DBC files), into the modern tables' fields. */
const BUILDERS: Record<string, (storage: VanillaStorage) => Promise<Table>> = {
	// Directory 1, instance type 2, name 4 (the first of 8 locales and their flags). The WDT by its path.
	Map: (s) => rebuild(s, 'Map', (c) => at({ 1: c.string(4), 8: c.int(2), 21: s.idOf(wdtPath(c.string(1))) })),
	// Parent 2, ambience 7, music 8, intro 9, name 11. No separate underwater ambience in 1.12.
	AreaTable: (s) => rebuild(s, 'AreaTable', (c) => at({ 1: c.string(11), 3: c.int(2), 8: 0, 9: c.int(8), 12: c.int(9) })),
	// Name 1, silence min 2-3 and max 4-5 (day, night), sounds 6-7 (SoundEntries).
	ZoneMusic: (s) => rebuild(s, 'ZoneMusic', (c) => at({ 0: c.string(1), 1: c.ints(2, 2), 2: c.ints(4, 2), 3: c.ints(6, 2) })),
	// Name 1, sound 2, minimum delay 4.
	ZoneIntroMusicTable: (s) => rebuild(s, 'ZoneIntroMusicTable', (c) => at({ 0: c.string(1), 1: c.int(2), 3: c.int(4) })),
	// The original client has no sound kits; its SoundEntries name up to 10 files in a folder. Each
	// becomes a kit entry: the sound's ID as the kit, the file by its path.
	SoundKitEntry: async (s) => {
		const dbc = await readDbc(s, 'SoundEntries');
		const rows = new Map<number, Field[]>();
		for (const id of dbc.ids()) {
			const folder = dbc.getString(id, 23) ?? '';
			for (let k = 0; k < 10; k++) {
				const file = dbc.getInt(id, 3 + k) ? dbc.getString(id, 3 + k) : '';
				if (file) rows.set(id * 16 + k, [id, s.idOf(folder ? `${folder}\\${file}` : file)]);
			}
		}
		return new RowTable(rows);
	},
	// Day and night ambiences, not the underwater sounds the modern table holds; none are used.
	SoundAmbience: async () => new RowTable(new Map()),
	// WMO 1, name set 2, group 3, music 7, intro 8, area 10, name 11.
	WMOAreaTable: (s) => rebuild(s, 'WMOAreaTable', (c) => at({ 0: c.string(11), 2: c.int(1), 3: c.int(2), 4: c.int(3), 9: c.int(7), 11: c.int(8), 13: c.int(10) })),
	// Name 1.
	LiquidType: (s) => rebuild(s, 'LiquidType', (c) => at({ 0: c.string(1) })),
	// Key types 1-8, indexes 9-16, skills 17-24.
	Lock: (s) => rebuild(s, 'Lock', (c) => at({ 1: c.ints(9, 8), 2: c.ints(17, 8), 3: c.ints(1, 8) })),
	// Doodads 1-4 (-1 for none), density 5. No weights: the doodads share alike.
	GroundEffectTexture: (s) => rebuild(s, 'GroundEffectTexture', (c) => {
		const doodads = c.ints(1, 4).map((d) => Math.max(0, d));
		return at({ 0: c.int(5), 2: doodads, 3: doodads.map((d) => (d ? 1 : 0)) });
	}),
	// Keyed by the internal ID (1) the textures use; the model's name (2) is in World\NoDXT\Detail.
	// Everything sways a little: the old table doesn't say which models are stones.
	GroundEffectDoodad: (s) => rebuild(s, 'GroundEffectDoodad', (c) => [c.int(1), at({ 0: s.idOf(`World\\NoDXT\\Detail\\${modelPath(c.string(2))}`), 2: 1 })], true),
};

/** A modern table's look-alike, by its name, from the original client's DBC; null where there's none. */
export function vanillaTable(storage: VanillaStorage, name: string): Promise<Table> | null {
	return BUILDERS[name]?.(storage) ?? null;
}

/** A DBC as it is, by name, for readers written for the original client's columns. */
export async function readDbc(storage: VanillaStorage, name: string): Promise<Dbc> {
	const bytes = await storage.mpq.read(`DBFilesClient\\${name}.dbc`);
	if (!bytes) throw new Error(`${name}.dbc is not in the client's archives`);
	return new Dbc(bytes);
}
