/**
 * The editor's changes to a tile's surface, chunk by chunk (chunk index y * 16 + x): its texture
 * layers as painted, and its water. Each edit replaces the chunk's own data whole.
 */

/** Texels per side of a chunk's alpha maps. */
export const PAINT_SIZE = 64;
export const PAINT_TEXELS = PAINT_SIZE * PAINT_SIZE;
/** A chunk shows at most four textures: a base and three blended over it. */
export const MAX_LAYERS = 4;

/**
 * A chunk's texture layers: up to four textures, by reference (a file path in the original
 * client, '#' and a file ID in the modern one), and the shares of layers 1-3 (0-255, 64x64 each,
 * one after the other; the base gets what's left).
 */
export interface ChunkPaint {
	textures: string[];
	alpha: Uint8Array;
}

/** Liquid types, as the original client's chunk flags number them (and its LiquidType table). */
export const WATER_TYPES = { none: 0, water: 1, ocean: 2, magma: 3, slime: 4 } as const;
export type WaterType = keyof typeof WATER_TYPES;

/** A chunk's liquid: its type (0 for none), a flat surface level, and its 8x8 cells (1 where there's liquid). */
export interface ChunkWater {
	type: number;
	level: number;
	cells: Uint8Array;
}

export type TilePaint = Record<number, ChunkPaint>;
export type TileWater = Record<number, ChunkWater>;

/** A tile's surface edits, as the worker applies them when it builds the tile. */
export interface SurfaceEdits {
	paint?: TilePaint;
	water?: TileWater;
}

export const copyPaint = (p: ChunkPaint): ChunkPaint => ({ textures: [...p.textures], alpha: p.alpha.slice() });
export const copyWater = (w: ChunkWater): ChunkWater => ({ type: w.type, level: w.level, cells: w.cells.slice() });
