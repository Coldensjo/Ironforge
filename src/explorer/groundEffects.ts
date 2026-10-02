import type { GameStorage } from '../casc/storage';
import { CHUNKS_PER_TILE, TILE_CELLS, type AdtRoot } from '../formats/adt';
import type { AdtTex } from '../formats/adtTex';
import { DB2_FILES, loadTable } from './clientDb';

/** GroundEffectTexture fields. */
const TEXTURE_DENSITY = 0;
const TEXTURE_DOODADS = 2;
const TEXTURE_WEIGHTS = 3;
/** GroundEffectDoodad fields. */
const DOODAD_MODEL = 0;
const DOODAD_SWAY = 2;
const DOODAD_MIN_SCALE = 4;
const DOODAD_MAX_SCALE = 5;
const DOODAD_YAW = 7;

/** One kind of clutter model an effect scatters. */
export interface ClutterDoodad {
	fdid: number;
	/** Share of the effect's doodads (the weights of an effect add up to 100). */
	weight: number;
	/** How much it bends in the wind (0 for stones). */
	sway: number;
	minScale: number;
	maxScale: number;
	/** Largest random turn, in degrees. */
	yaw: number;
}

/** A GroundEffectTexture row: what grows on a terrain texture, and how thickly. */
export interface ClutterEffect {
	/** Doodads per terrain cell (about 4 yards square). */
	density: number;
	doodads: ClutterDoodad[];
}

/**
 * What a tile's ground clutter is made of; the viewer scatters the actual copies near the camera.
 * Like the game, each terrain cell takes its clutter from the texture layer that covers most of it.
 */
export interface ClutterSource {
	effects: ClutterEffect[];
	/** 128x128 cells: index into effects + 1, or 0 for none (holes, water, cells switched off, bare textures). */
	cells: Uint8Array;
	/** 129x129 outer and 128x128 inner heights, for standing each copy on the exact surface. */
	outer: Float32Array;
	inner: Float32Array;
}

/** GroundEffectTexture and GroundEffectDoodad, read once. */
export class GroundEffects {
	private constructor(private readonly effects: Map<number, ClutterEffect | null>) {}

	static async load(storage: GameStorage): Promise<GroundEffects> {
		const [textures, doodads] = await Promise.all([loadTable(storage, DB2_FILES.GroundEffectTexture), loadTable(storage, DB2_FILES.GroundEffectDoodad)]);
		const effects = new Map<number, ClutterEffect | null>();
		for (const id of textures.ids()) {
			const list: ClutterDoodad[] = [];
			for (let k = 0; k < textures.arrayLength(TEXTURE_DOODADS); k++) {
				const doodad = textures.getInt(id, TEXTURE_DOODADS, k) ?? 0;
				// Weights are bytes; the pallet keeps unrelated bits above them.
				const weight = (textures.getInt(id, TEXTURE_WEIGHTS, k) ?? 0) & 0xff;
				const fdid = doodads.getInt(doodad, DOODAD_MODEL) ?? 0;
				if (!doodad || !weight || !fdid || storage.status(fdid) !== 'ok') continue;
				list.push({
					fdid,
					weight,
					sway: doodads.getFloat(doodad, DOODAD_SWAY) ?? 0,
					minScale: doodads.getFloat(doodad, DOODAD_MIN_SCALE) || 1,
					maxScale: doodads.getFloat(doodad, DOODAD_MAX_SCALE) || 1,
					yaw: doodads.getFloat(doodad, DOODAD_YAW) ?? 360,
				});
			}
			const density = textures.getInt(id, TEXTURE_DENSITY) ?? 0;
			effects.set(id, list.length && density ? { density, doodads: list } : null);
		}
		return new GroundEffects(effects);
	}

	/** A tile's clutter map; null when none of its textures grow anything. */
	source(root: AdtRoot, tex: AdtTex, outer: Float32Array, inner: Float32Array, holes: Uint8Array): ClutterSource | null {
		const n = TILE_CELLS;
		const cells = new Uint8Array(n * n);
		const effects: ClutterEffect[] = [];
		const indexOf = new Map<number, number>();
		const water = waterLevels(root);
		for (const c of root.chunks) {
			const id = c.indexY * CHUNKS_PER_TILE + c.indexX;
			const layers = tex.chunks[id]?.layers;
			if (!layers) continue;
			for (let row = 0; row < 8; row++) {
				for (let col = 0; col < 8; col++) {
					if (c.noEffect[row] & (1 << col)) continue;
					const gx = c.indexX * 8 + col;
					const gz = c.indexY * 8 + row;
					const cell = gz * n + gx;
					if (holes[cell]) continue;
					// Nothing grows under water.
					if (water[cell] > inner[cell]) continue;
					const effectId = layers[c.effectLayers[row * 8 + col]]?.effect ?? 0;
					const effect = this.effects.get(effectId);
					if (!effect) continue;
					let index = indexOf.get(effectId);
					if (index === undefined) {
						if (effects.length >= 255) continue;
						index = effects.length;
						effects.push(effect);
						indexOf.set(effectId, index);
					}
					cells[cell] = index + 1;
				}
			}
		}
		return effects.length ? { effects, cells, outer, inner } : null;
	}
}

/** Liquid surface height per cell (128x128), -Infinity where there's none. */
function waterLevels(root: AdtRoot): Float32Array {
	const n = TILE_CELLS;
	const levels = new Float32Array(n * n).fill(-Infinity);
	for (const l of root.liquids) {
		const cx = (l.chunk % CHUNKS_PER_TILE) * 8;
		const cy = Math.floor(l.chunk / CHUNKS_PER_TILE) * 8;
		for (let row = 0; row < l.height; row++) {
			for (let col = 0; col < l.width; col++) {
				if (l.exists && !l.exists[row * l.width + col]) continue;
				// The surface at the cell's corners, or flat.
				let level = l.minHeight;
				if (l.heights) {
					const w = l.width + 1;
					level = Math.max(l.heights[row * w + col], l.heights[row * w + col + 1], l.heights[(row + 1) * w + col], l.heights[(row + 1) * w + col + 1]);
				}
				const cell = (cy + l.y + row) * n + cx + l.x + col;
				levels[cell] = Math.max(levels[cell], level);
			}
		}
	}
	return levels;
}
