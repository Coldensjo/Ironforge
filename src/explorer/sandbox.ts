import { CHUNK_HEIGHTS, CHUNKS_PER_TILE, TILE_SIZE, type AdtChunk, type AdtRoot } from '../formats/adt';
import type { AdtTex } from '../formats/adtTex';
import type { Image, TextureData } from '../formats/blp';
import { WDL_CELLS } from '../formats/wdl';
import { buildTerrainMesh } from './terrainMesh';

/**
 * The sandbox: a big flat field of grass to build on, made here rather than read from a map. It
 * has a map ID and WDT of its own that no game map uses, and its tiles are laid out like a
 * continent's, around the middle of the 64x64 grid, so world coordinates stay near zero.
 */
export const SANDBOX_MAP_ID = 100000;
/** No file has a negative ID. */
export const SANDBOX_WDT = -1;
export const SANDBOX_NAME = 'Sandbox';
/** Tiles per side (each 533 yards): 16 makes a field about 8.5 km across. */
export const SANDBOX_TILES = 16;
const FIRST_TILE = 32 - SANDBOX_TILES / 2;
/** Yards above sea level: the sea around it then reads as a shore. */
export const SANDBOX_HEIGHT = 20;

/** Elwynn Forest's base grass (tileset/elwynn/elwynngrassbase_s.blp) and the grass that grows on it. */
const GRASS = { diffuse: 187127, effect: 762, repeats: 8 };
/** About the grass texture's colour, for the low-detail view and the minimap. */
const GRASS_COLOR: [number, number, number] = [86, 112, 44];

export const isSandbox = (wdt: number) => wdt === SANDBOX_WDT;

/** Whether a tile is part of the field. */
export function sandboxHasTile(x: number, y: number): boolean {
	return x >= FIRST_TILE && x < FIRST_TILE + SANDBOX_TILES && y >= FIRST_TILE && y < FIRST_TILE + SANDBOX_TILES;
}

/** Every tile of the field, as [x, y]. */
export function sandboxTiles(): [number, number][] {
	const out: [number, number][] = [];
	for (let y = FIRST_TILE; y < FIRST_TILE + SANDBOX_TILES; y++) for (let x = FIRST_TILE; x < FIRST_TILE + SANDBOX_TILES; x++) out.push([x, y]);
	return out;
}

/** The middle of the field, in tiles. */
export const SANDBOX_CENTER = 32;

/** A tile's low-detail mesh and heights, flat. */
export function sandboxFarTile(x: number, y: number) {
	const outer = new Float32Array((WDL_CELLS + 1) ** 2).fill(SANDBOX_HEIGHT);
	const inner = new Float32Array(WDL_CELLS ** 2).fill(SANDBOX_HEIGHT);
	return { x, y, hasAdt: true, geometry: buildTerrainMesh(outer, inner, WDL_CELLS, TILE_SIZE, null, 60), heights: outer };
}

/** A tile's ground, as a parsed ADT would give it: 256 flat chunks, no holes, no water. */
export function sandboxRoot(x: number, y: number): AdtRoot {
	const chunks: AdtChunk[] = [];
	const corner = 32 * TILE_SIZE;
	const size = TILE_SIZE / CHUNKS_PER_TILE;
	for (let cy = 0; cy < CHUNKS_PER_TILE; cy++) {
		for (let cx = 0; cx < CHUNKS_PER_TILE; cx++) {
			chunks.push({
				indexX: cx,
				indexY: cy,
				flags: 0,
				areaId: 0,
				holes: new Uint8Array(8),
				// World x is north, y west (see spawnMatrix): a chunk's corner from its tile and place in it.
				position: [corner - y * TILE_SIZE - cy * size, corner - x * TILE_SIZE - cx * size, SANDBOX_HEIGHT],
				heights: new Float32Array(CHUNK_HEIGHTS).fill(SANDBOX_HEIGHT),
				colors: null,
				effectLayers: new Uint8Array(64),
				noEffect: new Uint8Array(8),
			});
		}
	}
	return { chunks, chunkIds: ['MCNK'], hasWater: false, liquids: [] };
}

/** The tile's texture layers: grass everywhere, one layer per chunk. */
export function sandboxTex(): AdtTex {
	return {
		diffuse: [GRASS.diffuse],
		height: [0],
		params: [{ repeats: GRASS.repeats, heightScale: 0, heightOffset: 1 }],
		chunks: Array.from({ length: CHUNKS_PER_TILE * CHUNKS_PER_TILE }, () => ({ layers: [{ texture: 0, flags: 0, effect: GRASS.effect }], alpha: [] })),
	};
}

/** Grass-green pixels with a little speckle, so a flat field doesn't look like a painted board. */
function grassPixels(size: number): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	let seed = 1234567;
	for (let i = 0; i < size * size; i++) {
		seed = (seed * 1103515245 + 12345) >>> 0;
		const shade = 0.9 + ((seed >>> 16) / 65535) * 0.2;
		data[i * 4] = Math.min(255, GRASS_COLOR[0] * shade);
		data[i * 4 + 1] = Math.min(255, GRASS_COLOR[1] * shade);
		data[i * 4 + 2] = Math.min(255, GRASS_COLOR[2] * shade);
		data[i * 4 + 3] = 255;
	}
	return data;
}

/** The field's colour as a tile's low-detail texture. */
export function sandboxTileTexture(): TextureData {
	const size = 32;
	return { format: 'rgba', width: size, height: size, mips: [{ width: size, height: size, data: grassPixels(size) }] };
}

/** The field's colour as a minimap image. */
export function sandboxMinimap(size: number): Image {
	return { width: size, height: size, rgba: grassPixels(size) };
}
