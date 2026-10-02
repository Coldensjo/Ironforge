import { CHUNK_HEIGHTS, readEffectLayers, readHoles, type AdtChunk, type AdtRoot } from './adt';
import { ALPHA_SIZE, decode4Bit, type AdtTex, type TexChunk } from './adtTex';
import { chunks } from './chunks';
import type { LiquidInstance } from './mh2o';
import { TILE_FILE_KINDS, type Wdt, type WdtTile } from './wdt';

/**
 * The original (1.12) client's map files. Its ADTs are one file per tile (heights, texture layers,
 * alpha maps and object placements together) and name their textures and models by path; its
 * WDTs list which tiles exist, and the tiles are found by name. Paths become numbers through idOf
 * (see VanillaStorage), so the rest of the engine can treat them like the modern client's files.
 */
export type IdOf = (path: string) => number;

const MAP_SIZE = 64;
/** MCNK header: offsets of its sub-chunks, from the start of the MCNK chunk (its own header included). */
const MCNK_OFS_HEIGHT = 0x14;
const MCNK_OFS_LAYER = 0x1c;
const MCNK_OFS_ALPHA = 0x24;
const MCNK_SIZE_ALPHA = 0x28;
const MCNK_OFS_LIQUID = 0x60;
const MCNK_SIZE_LIQUID = 0x64;
/**
 * MCNK flags for the liquids in its MCLQ, in the order they're stored, and the LiquidType each
 * becomes (1 water, 2 ocean, 3 magma, 4 slime: the modern table's first four).
 */
const LIQUID_FLAGS: [number, number][] = [[0x04, 1], [0x08, 2], [0x10, 3], [0x20, 4]];
/** One liquid in an MCLQ: min and max height, 9x9 vertices of 8 bytes, 8x8 cell flags, then flow data. */
const MCLQ_ENTRY = 8 + 81 * 8 + 64 + 4 + 2 * 40;
/** MCLY flag: the layer has an alpha map. */
const LAYER_USE_ALPHA = 0x100;
const ALPHA_TEXELS = ALPHA_SIZE * ALPHA_SIZE;
/** 4-bit alpha maps: 64x64 texels, two a byte. */
const ALPHA_4BIT_BYTES = ALPHA_TEXELS / 2;

/** A tile's ADT path: World\Maps\<folder>\<folder>_<x>_<y>.adt. */
export function adtPath(folder: string, x: number, y: number): string {
	return `World\\Maps\\${folder}\\${folder}_${x}_${y}.adt`;
}

/** The map's WDT and WDL paths, by its folder (Map.dbc's directory field). */
export const wdtPath = (folder: string) => `World\\Maps\\${folder}\\${folder}.wdt`;
export const wdlPath = (folder: string) => `World\\Maps\\${folder}\\${folder}.wdl`;

/** Where the original client's minimap images are, and the table naming them. */
export const MINIMAP_FOLDER = 'Textures\\Minimap';
export const MINIMAP_TRANSLATE = `${MINIMAP_FOLDER}\\md5translate.trs`;

/**
 * md5translate.trs: the minimap images are stored under hashed names, listed by what they show.
 * Lines are "<folder>\map<x>_<y>.blp<tab><hash>.blp" (and "dir: <folder>" headings). Returns
 * each tile's image path by "<folder>\map<x>_<y>", lower case.
 */
export function parseMinimapTranslate(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const [shown, stored] = line.split('\t');
		if (!stored) continue;
		out.set(shown.trim().toLowerCase().replace(/\.blp$/, ''), `${MINIMAP_FOLDER}\\${stored.trim()}`);
	}
	return out;
}

/**
 * A 1.12 WDT, in the shape the modern parser gives: each tile's root file is its ADT (by name,
 * as a number from idOf), its minimap from the minimap table where it has one; the modern
 * split files it doesn't have are 0.
 */
export function parseVanillaWdt(bytes: Uint8Array, folder: string, idOf: IdOf, minimaps?: Map<string, string>): Wdt {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let flags = 0;
	let main: number | null = null;
	let wmoName: string | null = null;
	let modf: number | null = null;
	for (const c of chunks(bytes)) {
		if (c.id === 'MPHD') flags = view.getUint32(c.offset, true);
		else if (c.id === 'MAIN') main = c.offset;
		else if (c.id === 'MWMO' && c.size > 1) wmoName = new TextDecoder().decode(bytes.subarray(c.offset, c.offset + c.size)).split('\0')[0];
		else if (c.id === 'MODF' && c.size >= 64) modf = c.offset;
	}
	if (main === null) throw new Error('WDT has no MAIN chunk');
	const tiles: (WdtTile | null)[] = new Array(MAP_SIZE * MAP_SIZE).fill(null);
	let tileCount = 0;
	for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
		// 8 bytes a tile: flags (1: has an ADT) and a value the client fills in at run time.
		if (!(view.getUint32(main + i * 8, true) & 1)) continue;
		const x = i % MAP_SIZE;
		const y = Math.floor(i / MAP_SIZE);
		const files = Object.fromEntries(TILE_FILE_KINDS.map((k) => [k, 0])) as WdtTile['files'];
		files.root = idOf(adtPath(folder, x, y));
		const minimap = minimaps?.get(`${folder}\\map${x}_${y}`.toLowerCase());
		if (minimap) files.minimap = idOf(minimap);
		tiles[i] = { x, y, flags: 0, files, flowMap: 0 };
		tileCount++;
	}
	let globalWmo: Wdt['globalWmo'] = null;
	if (wmoName && modf !== null) {
		const f = (k: number) => view.getFloat32(modf! + k, true);
		globalWmo = {
			fdid: idOf(wmoName),
			position: [f(8), f(12), f(16)],
			rotation: [f(20), f(24), f(28)],
			min: [f(32), f(36), f(40)],
			max: [f(44), f(48), f(52)],
			doodadSet: view.getUint16(modf + 58, true),
			nameSet: view.getUint16(modf + 60, true),
			scale: 1,
		};
	}
	return { flags, tiles, tileCount, globalWmo };
}

/** Zero-separated names (MTEX, MMDX, MWMO). */
function names(bytes: Uint8Array, offset: number, size: number): string[] {
	return new TextDecoder().decode(bytes.subarray(offset, offset + size)).split('\0').filter(Boolean);
}

/** A model's path as the client reads it: maps and WMOs name M2s as .mdx or .mdl files. */
export const modelPath = (name: string) => name.replace(/\.md[lx]$/i, '.m2');

/**
 * The models a 1.12 ADT places, as numbers from idOf, by the index its placements use: M2s
 * (MMDX names, MMID their offsets) and WMOs (MWMO, MWID). For parsePlacements.
 */
export function vanillaModelNames(bytes: Uint8Array, idOf: IdOf): { m2: number[]; wmo: number[] } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const found = new Map<string, { offset: number; size: number }>();
	for (const c of chunks(bytes)) if (!found.has(c.id)) found.set(c.id, c);
	const list = (namesId: string, offsetsId: string, toPath: (name: string) => string) => {
		const text = found.get(namesId);
		const offsets = found.get(offsetsId);
		if (!text || !offsets) return [];
		return Array.from({ length: offsets.size / 4 }, (_, i) => {
			const from = text.offset + view.getUint32(offsets.offset + i * 4, true);
			const end = bytes.indexOf(0, from);
			const name = new TextDecoder().decode(bytes.subarray(from, end < 0 ? text.offset + text.size : Math.min(end, text.offset + text.size)));
			return name ? idOf(toPath(name)) : 0;
		});
	};
	return { m2: list('MMDX', 'MMID', modelPath), wmo: list('MWMO', 'MWID', (name) => name) };
}

/**
 * A 1.12 ADT's ground: the chunks' heights and holes as the modern root parser gives them, and
 * their texture layers and alpha maps as the modern _tex0 parser does, with the textures (by
 * name in the file) as numbers from idOf. The MCNK header's offsets lead to each sub-chunk; the
 * file's sizes can't be followed in order (MCNR's size leaves out its 13 bytes of padding).
 */
export function parseVanillaAdt(bytes: Uint8Array, idOf: IdOf): { root: AdtRoot; tex: AdtTex } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const root: AdtRoot = { chunks: [], chunkIds: [], hasWater: false, liquids: [] };
	const tex: AdtTex = { diffuse: [], height: [], params: [], chunks: [] };
	for (const c of chunks(bytes)) {
		if (!root.chunkIds.includes(c.id)) root.chunkIds.push(c.id);
		if (c.id === 'MTEX') {
			tex.diffuse = names(bytes, c.offset, c.size).map(idOf);
			// No height maps, and each texture repeats 8 times a chunk, as the modern files' default.
			tex.height = tex.diffuse.map(() => 0);
			tex.params = tex.diffuse.map(() => ({ repeats: 8, heightScale: 0, heightOffset: 1 }));
		} else if (c.id === 'MCNK') {
			const { chunk, layers, liquids } = parseChunk(bytes, view, c.offset - 8, c.offset);
			root.chunks.push(chunk);
			tex.chunks.push(layers);
			root.liquids.push(...liquids);
		}
	}
	root.hasWater = root.liquids.length > 0;
	return { root, tex };
}

/**
 * A chunk's liquids (MCLQ): each a 9x9 grid of surface heights over its 8x8 cells, a cell with
 * flags 0xF having none. As the modern MH2O instances, covering the whole chunk.
 */
function parseLiquids(view: DataView, start: number, h: number, chunkIndex: number): LiquidInstance[] {
	const flags = view.getUint32(h, true);
	const size = view.getUint32(h + MCNK_SIZE_LIQUID, true);
	if (!(flags & 0x3c) || size <= 8) return [];
	let o = start + view.getUint32(h + MCNK_OFS_LIQUID, true) + 8;
	const out: LiquidInstance[] = [];
	for (const [flag, type] of LIQUID_FLAGS) {
		if (!(flags & flag)) continue;
		if (o + MCLQ_ENTRY > view.byteLength) break;
		const heights = new Float32Array(81);
		// Each vertex: water has depth and flow bytes, magma texture coordinates; the height is the second word either way.
		for (let i = 0; i < 81; i++) heights[i] = view.getFloat32(o + 8 + i * 8 + 4, true);
		const exists = new Uint8Array(64);
		for (let i = 0; i < 64; i++) exists[i] = (view.getUint8(o + 8 + 81 * 8 + i) & 0x0f) === 0x0f ? 0 : 1;
		out.push({ chunk: chunkIndex, type, minHeight: view.getFloat32(o, true), maxHeight: view.getFloat32(o + 4, true), x: 0, y: 0, width: 8, height: 8, exists, heights });
		o += MCLQ_ENTRY;
	}
	return out;
}

/** One MCNK: start is where its chunk header is, h where its own header (after that) begins. */
function parseChunk(bytes: Uint8Array, view: DataView, start: number, h: number): { chunk: AdtChunk; layers: TexChunk; liquids: LiquidInstance[] } {
	const position: [number, number, number] = [view.getFloat32(h + 0x68, true), view.getFloat32(h + 0x6c, true), view.getFloat32(h + 0x70, true)];
	const chunk: AdtChunk = {
		flags: view.getUint32(h, true),
		indexX: view.getUint32(h + 0x04, true),
		indexY: view.getUint32(h + 0x08, true),
		areaId: view.getUint32(h + 0x34, true),
		holes: readHoles(view, h),
		position,
		heights: new Float32Array(CHUNK_HEIGHTS),
		colors: null,
		effectLayers: readEffectLayers(bytes, h),
		noEffect: bytes.slice(h + 0x50, h + 0x58),
	};
	// Sub-chunk offsets point at its header; the data follows 8 bytes on.
	const sub = (field: number) => start + view.getUint32(h + field, true) + 8;
	const heights = sub(MCNK_OFS_HEIGHT);
	for (let i = 0; i < CHUNK_HEIGHTS; i++) chunk.heights[i] = position[2] + view.getFloat32(heights + i * 4, true);

	const layers: TexChunk = { layers: [], alpha: [] };
	const layerCount = view.getUint32(h + 0x0c, true);
	const mcly = sub(MCNK_OFS_LAYER);
	const mcal = sub(MCNK_OFS_ALPHA);
	const alphaEnd = start + view.getUint32(h + MCNK_OFS_ALPHA, true) + view.getUint32(h + MCNK_SIZE_ALPHA, true);
	for (let l = 0; l < layerCount; l++) {
		const o = mcly + l * 16;
		const flags = view.getUint32(o + 4, true);
		layers.layers.push({ texture: view.getUint32(o, true), flags, effect: view.getUint32(o + 12, true) });
		if (l === 0) continue;
		// Every layer after the first blends in by its 4-bit alpha map (the 63x63 kind: last row and column repeated).
		const alpha = new Uint8Array(ALPHA_TEXELS);
		if (flags & LAYER_USE_ALPHA) {
			const from = mcal + view.getUint32(o + 8, true);
			decode4Bit(bytes.subarray(from, Math.min(from + ALPHA_4BIT_BYTES, alphaEnd)), alpha, true);
		}
		layers.alpha.push(alpha);
	}
	return { chunk, layers, liquids: parseLiquids(view, start, h, chunk.indexY * 16 + chunk.indexX) };
}
