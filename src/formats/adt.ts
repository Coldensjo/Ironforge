import { chunks } from './chunks';
import { parseMh2o, type LiquidInstance } from './mh2o';

/** 9x9 outer + 8x8 inner height samples per chunk, stored as alternating rows of 9 and 8. */
export const CHUNK_HEIGHTS = 145;
export const CHUNKS_PER_TILE = 16;
export const TILE_SIZE = 1600 / 3; // yards
export const CHUNK_SIZE = TILE_SIZE / CHUNKS_PER_TILE;

export interface AdtChunk {
	indexX: number;
	indexY: number;
	flags: number;
	areaId: number;
	/** One byte per cell row (8 rows of 8 cells); bit n set = cell n in that row is a hole. */
	holes: Uint8Array;
	/** Chunk corner in world coordinates; z is the base height added to every sample. */
	position: [number, number, number];
	heights: Float32Array;
	/** Vertex colour multipliers (1 = neutral), 145 x RGB in MCVT order, or null. */
	colors: Float32Array | null;
	/** Per cell (row * 8 + col): the texture layer that covers most of it, which picks its ground clutter. */
	effectLayers: Uint8Array;
	/** One byte per cell row; bit n set = no ground clutter in cell n. */
	noEffect: Uint8Array;
}

export interface AdtRoot {
	chunks: AdtChunk[];
	chunkIds: string[];
	hasWater: boolean;
	liquids: LiquidInstance[];
}

const FLAG_HIGH_RES_HOLES = 0x10000;

/** The 2-bit-per-cell dominant layer map (MCNK +0x40), lowest bits first. */
export function readEffectLayers(bytes: Uint8Array, header: number): Uint8Array {
	const layers = new Uint8Array(64);
	for (let i = 0; i < 64; i++) layers[i] = (bytes[header + 0x40 + (i >> 2)] >> ((i & 3) * 2)) & 3;
	return layers;
}

export function readHoles(view: DataView, header: number): Uint8Array {
	const holes = new Uint8Array(8);
	const flags = view.getUint32(header, true);
	if (flags & FLAG_HIGH_RES_HOLES) {
		// 8x8 bitmap stored where older files kept the MCVT offset.
		for (let row = 0; row < 8; row++) holes[row] = view.getUint8(header + 0x14 + row);
	} else {
		// 4x4 bitmap, each bit covering 2x2 cells.
		const low = view.getUint16(header + 0x3c, true);
		for (let row = 0; row < 8; row++) {
			for (let col = 0; col < 8; col++) {
				if (low & (1 << ((row >> 1) * 4 + (col >> 1)))) holes[row] |= 1 << col;
			}
		}
	}
	return holes;
}

export function parseAdtRoot(bytes: Uint8Array): AdtRoot {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const result: AdtRoot = { chunks: [], chunkIds: [], hasWater: false, liquids: [] };
	for (const c of chunks(bytes)) {
		if (!result.chunkIds.includes(c.id)) result.chunkIds.push(c.id);
		if (c.id === 'MH2O' && c.size > 0) {
			result.hasWater = true;
			result.liquids = parseMh2o(bytes, c.offset);
		}
		if (c.id !== 'MCNK') continue;

		const h = c.offset;
		const chunk: AdtChunk = {
			flags: view.getUint32(h, true),
			indexX: view.getUint32(h + 0x04, true),
			indexY: view.getUint32(h + 0x08, true),
			areaId: view.getUint32(h + 0x34, true),
			holes: readHoles(view, h),
			position: [view.getFloat32(h + 0x68, true), view.getFloat32(h + 0x6c, true), view.getFloat32(h + 0x70, true)],
			heights: new Float32Array(CHUNK_HEIGHTS),
			colors: null,
			effectLayers: readEffectLayers(bytes, h),
			noEffect: bytes.slice(h + 0x50, h + 0x58),
		};
		for (const sub of chunks(bytes, h + 0x80, c.offset + c.size)) {
			if (sub.id === 'MCVT') {
				for (let i = 0; i < CHUNK_HEIGHTS; i++) chunk.heights[i] = chunk.position[2] + view.getFloat32(sub.offset + i * 4, true);
			} else if (sub.id === 'MCCV') {
				// BGRA bytes where 0x7f is neutral.
				chunk.colors = new Float32Array(CHUNK_HEIGHTS * 3);
				for (let i = 0; i < CHUNK_HEIGHTS; i++) {
					chunk.colors[i * 3] = bytes[sub.offset + i * 4 + 2] / 127;
					chunk.colors[i * 3 + 1] = bytes[sub.offset + i * 4 + 1] / 127;
					chunk.colors[i * 3 + 2] = bytes[sub.offset + i * 4] / 127;
				}
			}
		}
		result.chunks.push(chunk);
	}
	return result;
}

/** Outer-vertex height grid for a whole tile: 129x129 samples (16 chunks x 8 cells + 1). */
export function tileHeightGrid(adt: AdtRoot): { size: number; heights: Float32Array; min: number; max: number } {
	const size = CHUNKS_PER_TILE * 8 + 1;
	const heights = new Float32Array(size * size);
	let min = Infinity;
	let max = -Infinity;
	for (const chunk of adt.chunks) {
		for (let row = 0; row < 9; row++) {
			for (let col = 0; col < 9; col++) {
				const v = chunk.heights[row * 17 + col];
				heights[(chunk.indexY * 8 + row) * size + chunk.indexX * 8 + col] = v;
				if (v < min) min = v;
				if (v > max) max = v;
			}
		}
	}
	return { size, heights, min, max };
}

export const TILE_CELLS = CHUNKS_PER_TILE * 8;

/** Whole-tile grids: 129x129 outer and 128x128 inner heights, plus a 128x128 hole flag per cell. */
export function tileGrids(adt: AdtRoot): { outer: Float32Array; inner: Float32Array; holes: Uint8Array } {
	const n = TILE_CELLS;
	const outer = new Float32Array((n + 1) * (n + 1));
	const inner = new Float32Array(n * n);
	const holes = new Uint8Array(n * n);
	for (const chunk of adt.chunks) {
		const x0 = chunk.indexX * 8;
		const y0 = chunk.indexY * 8;
		for (let row = 0; row < 9; row++) {
			for (let col = 0; col < 9; col++) outer[(y0 + row) * (n + 1) + x0 + col] = chunk.heights[row * 17 + col];
		}
		for (let row = 0; row < 8; row++) {
			for (let col = 0; col < 8; col++) {
				inner[(y0 + row) * n + x0 + col] = chunk.heights[row * 17 + 9 + col];
				if (chunk.holes[row] & (1 << col)) holes[(y0 + row) * n + x0 + col] = 1;
			}
		}
	}
	return { outer, inner, holes };
}
