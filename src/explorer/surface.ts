import type { AdtRoot } from '../formats/adt';
import type { AdtTex } from '../formats/adtTex';
import type { LiquidInstance, LiquidKind } from '../formats/mh2o';
import { MAX_LAYERS, PAINT_TEXELS, WATER_TYPES, type ChunkWater, type SurfaceEdits } from '../formats/surfaceEdits';

/**
 * The editor's surface edits applied to a tile as it's read, before it's built: painted chunks'
 * layers in place of theirs, edited chunks' water in place of theirs. And the other way, each
 * chunk's layers and water as the editor's brushes start from them.
 */

/** Liquid types 1-4 (water, ocean, magma, slime) by kind, as both clients number them. */
const TYPE_OF_KIND: Record<LiquidKind, number> = { water: WATER_TYPES.water, ocean: WATER_TYPES.ocean, magma: WATER_TYPES.magma, slime: WATER_TYPES.slime };

/** A chunk's layers and water as the editor sees them: textures by reference. */
export interface SurfaceState {
	textures: string[][];
	water: (ChunkWater | null)[];
}

/** How texture files are named for the editor: by reference, and back. */
export interface TextureNames {
	ref(id: number): string;
	id(ref: string): number;
}

export function applySurfaceEdits(root: AdtRoot, tex: AdtTex | null, edits: SurfaceEdits | undefined, names: TextureNames): void {
	if (!edits) return;
	if (tex && edits.paint) {
		// Each texture's ground clutter here, for layers painted where it wasn't.
		const effects = new Map<number, number>();
		for (const c of tex.chunks) for (const l of c.layers) if (l.effect && !effects.has(l.texture)) effects.set(l.texture, l.effect);
		for (const [key, paint] of Object.entries(edits.paint)) {
			const chunk = Number(key);
			if (!tex.chunks[chunk] || !paint.textures.length) continue;
			const own = new Map(tex.chunks[chunk].layers.map((l) => [l.texture, l]));
			const layers = paint.textures.slice(0, MAX_LAYERS).map((ref, i) => {
				const id = names.id(ref);
				let texture = tex.diffuse.indexOf(id);
				if (texture < 0) {
					texture = tex.diffuse.push(id) - 1;
					tex.height.push(0);
					tex.params.push({ repeats: 8, heightScale: 0, heightOffset: 1 });
				}
				return { texture, flags: i ? 0x100 : 0, effect: own.get(texture)?.effect ?? effects.get(texture) ?? 0 };
			});
			tex.chunks[chunk] = {
				layers,
				alpha: layers.slice(1).map((_, i) => paint.alpha.slice(i * PAINT_TEXELS, (i + 1) * PAINT_TEXELS)),
			};
		}
	}
	if (edits.water) {
		for (const [key, water] of Object.entries(edits.water)) {
			const chunk = Number(key);
			root.liquids = root.liquids.filter((l) => l.chunk !== chunk);
			if (!water.type || !water.cells.some((c) => c)) continue;
			const liquid: LiquidInstance = {
				chunk, type: water.type, minHeight: water.level, maxHeight: water.level, x: 0, y: 0, width: 8, height: 8,
				exists: water.cells.slice(), heights: new Float32Array(81).fill(water.level),
			};
			root.liquids.push(liquid);
		}
		root.hasWater = root.liquids.length > 0;
	}
}

/** Each chunk's layers and water as the tile now has them (after any edits). */
export function surfaceState(root: AdtRoot, tex: AdtTex | null, names: TextureNames, kindOf: (type: number) => LiquidKind): SurfaceState {
	const textures = Array.from({ length: 256 }, (_, i) => (tex?.chunks[i]?.layers ?? []).map((l) => names.ref(tex!.diffuse[l.texture] ?? 0)));
	const water: (ChunkWater | null)[] = new Array(256).fill(null);
	for (const l of root.liquids) {
		if (water[l.chunk] || !l.width || !l.height) continue;
		// The liquid's cells within the chunk's 8x8, and its surface at the highest point.
		const cells = new Uint8Array(64);
		for (let row = 0; row < l.height; row++) {
			for (let col = 0; col < l.width; col++) {
				if (l.exists && !l.exists[row * l.width + col]) continue;
				cells[(l.y + row) * 8 + l.x + col] = 1;
			}
		}
		// The original client leaves hidden cells' corners at the largest float: only real heights count.
		const real = (h: number) => Number.isFinite(h) && Math.abs(h) < 1e20;
		let level = -Infinity;
		for (const h of l.heights ?? []) if (real(h)) level = Math.max(level, h);
		if (level === -Infinity) level = real(l.maxHeight) ? l.maxHeight : real(l.minHeight) ? l.minHeight : 0;
		water[l.chunk] = { type: TYPE_OF_KIND[kindOf(l.type)], level, cells };
	}
	return { textures, water };
}
