import { CHUNKS_PER_TILE, TILE_CELLS, TILE_SIZE } from './adt';
import { chunks } from './chunks';

/**
 * Rewrites a 1.12 (version 18) ADT with the editor's changes: heights moved (and the shading
 * normals made again to match), and map models taken out or added. Everything else is kept as
 * the file has it. The file is laid out again in the game's order (MVER, MHDR, MCIN, MTEX, the
 * model names and placements, the 256 MCNKs), with MHDR's and MCIN's offsets to match.
 *
 * Models are placed by MDDF (M2s) and MODF (WMOs), naming them through MMDX/MMID and MWMO/MWID;
 * each chunk lists the placements it shows in its MCRF (M2s first, then WMOs), and the game
 * draws a model only through the chunks that list it.
 */

/** A model placed on the tile, in the file's own space (x east, y up, z south, as continent space). */
export interface AdtModel {
	kind: 'm2' | 'wmo';
	/** As the file names it (World\...\Name.mdx or .wmo). */
	name: string;
	uid: number;
	position: [number, number, number];
	/** Degrees, as the file stores them (see objects.ts placementMatrix). */
	rotation: [number, number, number];
	/** M2s only; WMOs are always full size in 1.12. */
	scale: number;
	/** Its bounds in the same space: which chunks list it, and a WMO's MODF extents. */
	min: [number, number, number];
	max: [number, number, number];
	doodadSet: number;
	nameSet: number;
}

export interface AdtChanges {
	/** Height changes per lattice point (129x129 outer, then 128x128 inner), or none. */
	heights?: Float32Array;
	/** Placements to take out, by unique ID. */
	remove: Set<number>;
	add: AdtModel[];
}

const CHUNK_SIZE = TILE_SIZE / CHUNKS_PER_TILE;
const OUTER_ROW = TILE_CELLS + 1;
const OUTER_COUNT = OUTER_ROW * OUTER_ROW;
const STEP = CHUNK_SIZE / 8;
const MDDF_SIZE = 36;
const MODF_SIZE = 64;
/** MCNK header fields. */
const N_DOODAD_REFS = 0x10;
const OFS_HEIGHT = 0x14;
const OFS_NORMAL = 0x18;
const OFS_REFS = 0x20;
const N_MAP_OBJ_REFS = 0x38;
const POSITION = 0x68;
/** Every sub-chunk offset in the MCNK header (height, normal, layer, refs, alpha, shadow, sounds, liquid). */
const OFFSET_FIELDS = [0x14, 0x18, 0x1c, 0x20, 0x24, 0x2c, 0x58, 0x60];
/** MHDR fields (offsets from MHDR's data): MCIN, MTEX, MMDX, MMID, MWMO, MWID, MDDF, MODF. */
const MHDR_ORDER = ['MCIN', 'MTEX', 'MMDX', 'MMID', 'MWMO', 'MWID', 'MDDF', 'MODF'];

/** A chunk id as the file stores it (reversed). */
const tag = (id: string) => [...id].reverse().map((c) => c.charCodeAt(0));

class Out {
	private parts: Uint8Array[] = [];
	length = 0;

	/** Adds a chunk; returns where its header starts. */
	chunk(id: string, data: Uint8Array): number {
		const at = this.length;
		const head = new Uint8Array(8);
		head.set(tag(id));
		new DataView(head.buffer).setUint32(4, data.length, true);
		this.parts.push(head, data);
		this.length += 8 + data.length;
		return at;
	}

	bytes(): Uint8Array {
		const out = new Uint8Array(this.length);
		let at = 0;
		for (const p of this.parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	}
}

/** Zero-terminated names and each one's offset (MMDX and MMID, MWMO and MWID). */
function nameBlock(names: string[]): { text: Uint8Array; offsets: Uint8Array } {
	const encoder = new TextEncoder();
	const encoded = names.map((n) => encoder.encode(n));
	const text = new Uint8Array(encoded.reduce((n, e) => n + e.length + 1, 0));
	const offsets = new Uint8Array(names.length * 4);
	const view = new DataView(offsets.buffer);
	let at = 0;
	encoded.forEach((e, i) => {
		view.setUint32(i * 4, at, true);
		text.set(e, at);
		at += e.length + 1;
	});
	return { text, offsets };
}

/** The names a file lists (names chunk, offsets chunk), by index. */
function readNames(bytes: Uint8Array, view: DataView, text: { offset: number; size: number } | undefined, offsets: { offset: number; size: number } | undefined): string[] {
	if (!text || !offsets) return [];
	return Array.from({ length: offsets.size / 4 }, (_, i) => {
		const from = text.offset + view.getUint32(offsets.offset + i * 4, true);
		let end = from;
		while (end < text.offset + text.size && bytes[end]) end++;
		return new TextDecoder().decode(bytes.subarray(from, end));
	});
}

/** Unique names in order, each once (case doesn't matter to the game). */
class Names {
	readonly list: string[] = [];
	private readonly index = new Map<string, number>();

	of(name: string): number {
		const key = name.toLowerCase();
		let i = this.index.get(key);
		if (i === undefined) {
			i = this.list.length;
			this.list.push(name);
			this.index.set(key, i);
		}
		return i;
	}
}

export function rewriteVanillaAdt(bytes: Uint8Array, tileX: number, tileY: number, changes: AdtChanges): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const found = new Map<string, { offset: number; size: number }>();
	const mcnks: { offset: number; size: number }[] = [];
	const others: { id: string; offset: number; size: number }[] = [];
	for (const c of chunks(bytes)) {
		if (c.id === 'MCNK') mcnks.push(c);
		else if (['MVER', 'MHDR', ...MHDR_ORDER].includes(c.id)) found.set(c.id, c);
		else others.push(c);
	}
	if (!found.has('MHDR') || mcnks.length !== CHUNKS_PER_TILE * CHUNKS_PER_TILE) throw new Error(`Not a whole ADT (${mcnks.length} chunks)`);

	// Placements: the kept ones (renumbered names), then the added ones.
	const m2Names = new Names();
	const wmoNames = new Names();
	const oldM2Names = readNames(bytes, view, found.get('MMDX'), found.get('MMID'));
	const oldWmoNames = readNames(bytes, view, found.get('MWMO'), found.get('MWID'));
	const m2Entries: Uint8Array[] = [];
	const wmoEntries: Uint8Array[] = [];
	const m2Index: number[] = [];
	const wmoIndex: number[] = [];
	const keep = (c: { offset: number; size: number } | undefined, size: number, names: string[], into: Names, entries: Uint8Array[], index: number[]) => {
		for (let o = c?.offset ?? 0, i = 0; c && o + size <= c.offset + c.size; o += size, i++) {
			if (changes.remove.has(view.getUint32(o + 4, true))) {
				index.push(-1);
				continue;
			}
			const entry = bytes.slice(o, o + size);
			new DataView(entry.buffer).setUint32(0, into.of(names[view.getUint32(o, true)] ?? ''), true);
			index.push(entries.length);
			entries.push(entry);
		}
	};
	keep(found.get('MDDF'), MDDF_SIZE, oldM2Names, m2Names, m2Entries, m2Index);
	keep(found.get('MODF'), MODF_SIZE, oldWmoNames, wmoNames, wmoEntries, wmoIndex);

	// Added models, and the chunks whose squares their bounds reach.
	const addedRefs = Array.from({ length: CHUNKS_PER_TILE * CHUNKS_PER_TILE }, () => ({ m2: [] as number[], wmo: [] as number[] }));
	for (const model of changes.add) {
		const isWmo = model.kind === 'wmo';
		const entry = new Uint8Array(isWmo ? MODF_SIZE : MDDF_SIZE);
		const e = new DataView(entry.buffer);
		e.setUint32(0, (isWmo ? wmoNames : m2Names).of(model.name), true);
		e.setUint32(4, model.uid, true);
		model.position.forEach((v, k) => e.setFloat32(8 + k * 4, v, true));
		model.rotation.forEach((v, k) => e.setFloat32(20 + k * 4, v, true));
		if (isWmo) {
			model.min.forEach((v, k) => e.setFloat32(32 + k * 4, v, true));
			model.max.forEach((v, k) => e.setFloat32(44 + k * 4, v, true));
			e.setUint16(56, 0, true);
			e.setUint16(58, model.doodadSet, true);
			e.setUint16(60, model.nameSet, true);
		} else {
			e.setUint16(32, Math.max(1, Math.min(0xffff, Math.round(model.scale * 1024))), true);
			e.setUint16(34, 0, true);
		}
		const index = (isWmo ? wmoEntries : m2Entries).push(entry) - 1;
		const x0 = tileX * TILE_SIZE, z0 = tileY * TILE_SIZE;
		for (let cy = 0; cy < CHUNKS_PER_TILE; cy++) {
			for (let cx = 0; cx < CHUNKS_PER_TILE; cx++) {
				const left = x0 + cx * CHUNK_SIZE, top = z0 + cy * CHUNK_SIZE;
				if (model.max[0] < left || model.min[0] > left + CHUNK_SIZE || model.max[2] < top || model.min[2] > top + CHUNK_SIZE) continue;
				(isWmo ? addedRefs[cy * CHUNKS_PER_TILE + cx].wmo : addedRefs[cy * CHUNKS_PER_TILE + cx].m2).push(index);
			}
		}
	}

	// Heights as they'll be, for the normals: absolute, on the tile's lattice.
	const heights = changes.heights;
	const lattice = heights ? new Float32Array(heights.length) : null;
	if (lattice && heights) {
		for (const { offset: h } of mcnks) {
			const cx = view.getUint32(h + 0x04, true), cy = view.getUint32(h + 0x08, true);
			const base = view.getFloat32(h + POSITION + 8, true);
			const mcvt = h + view.getUint32(h + OFS_HEIGHT, true);
			for (let i = 0; i < 145; i++) {
				const index = latticeOf(cx, cy, i);
				lattice[index] = base + view.getFloat32(mcvt + i * 4, true) + heights[index];
			}
		}
	}

	// The chunks, each with its heights, normals and model list made anew.
	const newChunks: Uint8Array[] = [];
	for (const { offset: h, size } of mcnks) {
		const cx = view.getUint32(h + 0x04, true), cy = view.getUint32(h + 0x08, true);
		let data = bytes.slice(h, h + size);
		let d = new DataView(data.buffer);
		// Offsets in the header are from the MCNK's chunk header, 8 bytes before its data: in
		// the data, each points at its sub-chunk's contents (its own header 8 bytes before).
		if (heights && lattice) {
			const mcvt = d.getUint32(OFS_HEIGHT, true);
			const mcnr = d.getUint32(OFS_NORMAL, true);
			for (let i = 0; i < 145; i++) {
				const index = latticeOf(cx, cy, i);
				const at = mcvt + i * 4;
				d.setFloat32(at, d.getFloat32(at, true) + heights[index], true);
				if (mcnr) {
					const [n, w, u] = normalAt(lattice, index);
					d.setInt8(mcnr + i * 3, Math.round(n * 127));
					d.setInt8(mcnr + i * 3 + 1, Math.round(w * 127));
					d.setInt8(mcnr + i * 3 + 2, Math.round(u * 127));
				}
			}
		}
		// Its model list: the kept references renumbered, then the added models over it.
		const refsAt = d.getUint32(OFS_REFS, true);
		if (!refsAt) throw new Error(`Chunk ${cx},${cy} has no MCRF`);
		const oldSize = d.getUint32(refsAt - 4, true);
		const nDoodads = d.getUint32(N_DOODAD_REFS, true);
		const nObjects = d.getUint32(N_MAP_OBJ_REFS, true);
		const m2Refs: number[] = [], wmoRefs: number[] = [];
		for (let k = 0; k < nDoodads + nObjects && k * 4 < oldSize; k++) {
			const old = d.getUint32(refsAt + k * 4, true);
			const now = k < nDoodads ? m2Index[old] : wmoIndex[old];
			if (now !== undefined && now >= 0) (k < nDoodads ? m2Refs : wmoRefs).push(now);
		}
		const added = addedRefs[cy * CHUNKS_PER_TILE + cx];
		for (const i of added.m2) if (!m2Refs.includes(i)) m2Refs.push(i);
		for (const i of added.wmo) if (!wmoRefs.includes(i)) wmoRefs.push(i);
		const refs = new Uint8Array((m2Refs.length + wmoRefs.length) * 4);
		const r = new DataView(refs.buffer);
		[...m2Refs, ...wmoRefs].forEach((v, k) => r.setUint32(k * 4, v, true));
		// Splice it in, and move the offsets of what follows.
		const before = data.subarray(0, refsAt);
		const after = data.subarray(refsAt + oldSize);
		const grown = new Uint8Array(before.length + refs.length + after.length);
		grown.set(before);
		grown.set(refs, before.length);
		grown.set(after, before.length + refs.length);
		data = grown;
		d = new DataView(data.buffer);
		d.setUint32(refsAt - 4, refs.length, true);
		const delta = refs.length - oldSize;
		for (const field of OFFSET_FIELDS) {
			const v = d.getUint32(field, true);
			if (v > refsAt) d.setUint32(field, v + delta, true);
		}
		d.setUint32(N_DOODAD_REFS, m2Refs.length, true);
		d.setUint32(N_MAP_OBJ_REFS, wmoRefs.length, true);
		newChunks.push(data);
	}

	// The file, in the game's order.
	const out = new Out();
	const mver = found.get('MVER');
	out.chunk('MVER', mver ? bytes.slice(mver.offset, mver.offset + mver.size) : new Uint8Array([18, 0, 0, 0]));
	const mhdrSource = found.get('MHDR')!;
	const mhdr = bytes.slice(mhdrSource.offset, mhdrSource.offset + mhdrSource.size);
	const mhdrAt = out.chunk('MHDR', mhdr);
	const mcin = new Uint8Array(CHUNKS_PER_TILE * CHUNKS_PER_TILE * 16);
	const positions: Record<string, number> = {};
	positions.MCIN = out.chunk('MCIN', mcin);
	const mtex = found.get('MTEX');
	positions.MTEX = out.chunk('MTEX', mtex ? bytes.slice(mtex.offset, mtex.offset + mtex.size) : new Uint8Array(0));
	const m2Block = nameBlock(m2Names.list);
	const wmoBlock = nameBlock(wmoNames.list);
	positions.MMDX = out.chunk('MMDX', m2Block.text);
	positions.MMID = out.chunk('MMID', m2Block.offsets);
	positions.MWMO = out.chunk('MWMO', wmoBlock.text);
	positions.MWID = out.chunk('MWID', wmoBlock.offsets);
	const join = (entries: Uint8Array[], size: number) => {
		const all = new Uint8Array(entries.length * size);
		entries.forEach((e, i) => all.set(e, i * size));
		return all;
	};
	positions.MDDF = out.chunk('MDDF', join(m2Entries, MDDF_SIZE));
	positions.MODF = out.chunk('MODF', join(wmoEntries, MODF_SIZE));
	for (const o of others) out.chunk(o.id, bytes.slice(o.offset, o.offset + o.size));
	const mcinView = new DataView(mcin.buffer);
	for (const data of newChunks) {
		const at = out.chunk('MCNK', data);
		const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const index = d.getUint32(0x08, true) * CHUNKS_PER_TILE + d.getUint32(0x04, true);
		mcinView.setUint32(index * 16, at, true);
		mcinView.setUint32(index * 16 + 4, data.length + 8, true);
	}
	const mhdrView = new DataView(mhdr.buffer);
	MHDR_ORDER.forEach((id, k) => mhdrView.setUint32(4 + k * 4, positions[id] - (mhdrAt + 8), true));
	return out.bytes();
}

/** A chunk's height point (MCVT order: 9 outer, 8 inner, ... 9 outer) on the tile's lattice. */
function latticeOf(cx: number, cy: number, i: number): number {
	const row = Math.floor(i / 17);
	const col = i % 17;
	if (col < 9) return (cy * 8 + row) * OUTER_ROW + cx * 8 + col;
	return OUTER_COUNT + (cy * 8 + row) * TILE_CELLS + cx * 8 + col - 9;
}

/**
 * The ground's normal at a lattice point, from the heights around it (one-sided at the tile's
 * edges), in the file's order: north, west, up. Rows run south and columns east.
 */
function normalAt(lattice: Float32Array, index: number): [number, number, number] {
	const outer = (r: number, c: number) => lattice[Math.max(0, Math.min(TILE_CELLS, r)) * OUTER_ROW + Math.max(0, Math.min(TILE_CELLS, c))];
	let north: number, west: number;
	if (index < OUTER_COUNT) {
		const r = Math.floor(index / OUTER_ROW), c = index % OUTER_ROW;
		const rn = Math.max(0, r - 1), rs = Math.min(TILE_CELLS, r + 1);
		const cw = Math.max(0, c - 1), ce = Math.min(TILE_CELLS, c + 1);
		north = (outer(rn, c) - outer(rs, c)) / ((rs - rn) * STEP);
		west = (outer(r, cw) - outer(r, ce)) / ((ce - cw) * STEP);
	} else {
		const i = index - OUTER_COUNT;
		const r = Math.floor(i / TILE_CELLS), c = i % TILE_CELLS;
		const nw = outer(r, c), ne = outer(r, c + 1), sw = outer(r + 1, c), se = outer(r + 1, c + 1);
		north = ((nw + ne) - (sw + se)) / 2 / STEP;
		west = ((nw + sw) - (ne + se)) / 2 / STEP;
	}
	const len = Math.hypot(north, west, 1);
	return [-north / len, -west / len, 1 / len];
}

/** The unique IDs of the models a 1.12 ADT places (MDDF and MODF). */
export function listedIds(bytes: Uint8Array): Set<number> {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ids = new Set<number>();
	for (const c of chunks(bytes)) {
		const size = c.id === 'MDDF' ? MDDF_SIZE : c.id === 'MODF' ? MODF_SIZE : 0;
		for (let o = c.offset; size && o + size <= c.offset + c.size; o += size) ids.add(view.getUint32(o + 4, true));
	}
	return ids;
}
