import { signal } from '@preact/signals';
import type * as THREE from 'three';
import { CHUNKS_PER_TILE, TILE_SIZE } from '../formats/adt';
import { copyPaint, copyWater, MAX_LAYERS, PAINT_SIZE, PAINT_TEXELS, WATER_TYPES, type ChunkPaint, type ChunkWater, type WaterType } from '../formats/surfaceEdits';
import type { SurfaceTarget } from '../viewer/terrain';
import { BrushRing, falloff } from './brushRing';
import type { EditDocument, SurfacePatch } from './document';

/** What the paint and water brushes need from the viewer: the detailed tiles under them. */
export interface SurfaceHost {
	scene: THREE.Scene;
	surfaceTargetsIn(minX: number, minZ: number, maxX: number, maxZ: number): SurfaceTarget[];
	/** Builds a tile again with its paint and water. */
	refreshSurface(tile: string): void;
}

const CHUNK_SIZE = TILE_SIZE / CHUNKS_PER_TILE;
const TEXEL = CHUNK_SIZE / PAINT_SIZE;
const CELL = CHUNK_SIZE / 8;
const ATLAS = PAINT_SIZE * CHUNKS_PER_TILE;
/** How often (ms) a tile is built again mid-stroke, when the brush changed what it's built from. */
const REBUILD_EVERY = 350;
/** Share per second paint moves towards the texture at full strength. */
const PAINT_RATE = 6;

/** The chunks (by tile-local index) a circle reaches, with each one's corner. */
function chunksIn(target: SurfaceTarget, x: number, z: number, r: number): { chunk: number; cx: number; cy: number; x0: number; z0: number }[] {
	const out: { chunk: number; cx: number; cy: number; x0: number; z0: number }[] = [];
	const first = (v: number) => Math.max(0, Math.floor(v / CHUNK_SIZE));
	const last = (v: number) => Math.min(CHUNKS_PER_TILE - 1, Math.floor(v / CHUNK_SIZE));
	for (let cy = first(z - r - target.originZ); cy <= last(z + r - target.originZ); cy++) {
		for (let cx = first(x - r - target.originX); cx <= last(x + r - target.originX); cx++) {
			out.push({ chunk: cy * CHUNKS_PER_TILE + cx, cx, cy, x0: target.originX + cx * CHUNK_SIZE, z0: target.originZ + cy * CHUNK_SIZE });
		}
	}
	return out;
}

/** Common to both: the stroke's chunks as they were before it, and the tiles to build again. */
abstract class SurfaceStroke<T> {
	readonly size = signal(12);
	readonly softness = signal(0.5);

	protected stroke: { before: Map<string, Map<number, T | undefined>>; dirty: Set<string>; lastRebuild: number; last: number } | null = null;
	protected readonly ring: BrushRing;

	constructor(protected readonly host: SurfaceHost, protected readonly doc: EditDocument) {
		this.ring = new BrushRing(host.scene);
	}

	get active(): boolean {
		return this.stroke !== null;
	}

	protected abstract readonly kind: 'paint' | 'water';
	protected abstract current(tile: string, chunk: number): T | undefined;
	protected abstract set(tile: string, chunk: number, value: T | undefined): void;
	protected abstract copy(value: T): T;
	protected abstract color(invert: boolean): number;
	protected abstract work(center: THREE.Vector3, dt: number, invert: boolean): void;

	/** Call every frame with where the mouse meets the ground (or null), and whether Shift is held. */
	update(center: THREE.Vector3 | null, groundAt: (x: number, z: number) => number, invert: boolean): void {
		this.ring.show(center, this.size.value, this.softness.value, this.color(invert), groundAt);
		const stroke = this.stroke;
		if (!stroke || !center) return;
		const now = performance.now();
		const dt = Math.min(0.1, (now - stroke.last) / 1000);
		stroke.last = now;
		if (dt > 0) this.work(center, dt, invert);
		if (stroke.dirty.size && now - stroke.lastRebuild > REBUILD_EVERY) {
			stroke.lastRebuild = now;
			for (const tile of stroke.dirty) this.host.refreshSurface(tile);
			stroke.dirty.clear();
		}
	}

	/** Hides the outline (another tool is in use). */
	hide(): void {
		this.ring.show(null, 0, 0, 0, () => 0);
	}

	start(center: THREE.Vector3): void {
		this.stroke = { before: new Map(), dirty: new Set(), lastRebuild: performance.now(), last: performance.now() };
		this.began(center);
	}

	protected began(_center: THREE.Vector3): void {}

	/** Notes a chunk's state before the stroke first touches it. */
	protected touch(tile: string, chunk: number): void {
		const stroke = this.stroke!;
		let chunks = stroke.before.get(tile);
		if (!chunks) stroke.before.set(tile, (chunks = new Map()));
		if (!chunks.has(chunk)) {
			const now = this.current(tile, chunk);
			chunks.set(chunk, now && this.copy(now));
		}
	}

	/** Ends the stroke: one step to undo, with every chunk it changed. */
	end(): void {
		const stroke = this.stroke;
		if (!stroke) return;
		this.stroke = null;
		const patches: SurfacePatch[] = [];
		for (const [tile, chunks] of stroke.before) {
			for (const [chunk, before] of chunks) {
				const after = this.current(tile, chunk);
				patches.push({ tile, chunk, kind: this.kind, before, after: after && this.copy(after) } as SurfacePatch);
			}
			this.host.refreshSurface(tile);
		}
		this.doc.commitSurface(patches);
	}

	/** Drops the stroke unfinished, putting the chunks back as they were. */
	cancel(): void {
		const stroke = this.stroke;
		if (!stroke) return;
		this.stroke = null;
		for (const [tile, chunks] of stroke.before) {
			for (const [chunk, before] of chunks) this.set(tile, chunk, before);
			this.host.refreshSurface(tile);
		}
	}
}

/**
 * The paint brush: blends a texture into the ground. Each chunk shows up to four textures, a
 * base and three blended over it by their shares (64x64 per chunk); painting raises the
 * texture's share and lowers the others'. A texture new to a chunk takes a free layer; in a chunk
 * with four already, the layer that shows least gives its share to whichever texture is strongest
 * at each point, and its place to the new one.
 */
export class PaintBrush extends SurfaceStroke<ChunkPaint> {
	protected readonly kind = 'paint';
	/** The texture to paint, by reference; null for none chosen yet. */
	readonly texture = signal<string | null>(null);
	readonly strength = signal(0.5);

	/** Per chunk touched, its shares as floats, so slow strokes don't round away. */
	private shares = new Map<string, Float32Array>();

	protected current(tile: string, chunk: number): ChunkPaint | undefined {
		return this.doc.paintOf(tile, chunk);
	}

	protected set(tile: string, chunk: number, value: ChunkPaint | undefined): void {
		this.doc.setPaint(tile, chunk, value);
	}

	protected copy(value: ChunkPaint): ChunkPaint {
		return copyPaint(value);
	}

	protected color(invert: boolean): number {
		return invert ? 0xff8a5c : 0x8cff6b;
	}

	protected began(): void {
		this.shares.clear();
	}

	/** A chunk's layers as they are now: its paint, or as the tile was built (from the atlas). */
	private layersOf(target: SurfaceTarget, chunk: number, cx: number, cy: number): ChunkPaint | null {
		const own = this.doc.paintOf(target.key, chunk);
		if (own) return own;
		const textures = target.surface.textures[chunk];
		if (!textures?.length) return null;
		const alpha = new Uint8Array(PAINT_TEXELS * 3);
		for (let y = 0; y < PAINT_SIZE; y++) {
			for (let x = 0; x < PAINT_SIZE; x++) {
				const at = ((cy * PAINT_SIZE + y) * ATLAS + cx * PAINT_SIZE + x) * 4;
				for (let l = 0; l < 3; l++) alpha[l * PAINT_TEXELS + y * PAINT_SIZE + x] = l + 1 < textures.length ? target.atlas[at + l] : 0;
			}
		}
		return { textures: [...textures], alpha };
	}

	protected work(center: THREE.Vector3, dt: number, invert: boolean): void {
		const texture = this.texture.value;
		if (!texture) return;
		const r = this.size.value;
		const amount = 1 - Math.exp(-PAINT_RATE * this.strength.value * this.strength.value * dt);
		for (const target of this.host.surfaceTargetsIn(center.x - r, center.z - r, center.x + r, center.z + r)) {
			let atlasChanged = false;
			for (const { chunk, cx, cy, x0, z0 } of chunksIn(target, center.x, center.z, r)) {
				const now = this.layersOf(target, chunk, cx, cy);
				if (!now) continue;
				const key = `${target.key}:${chunk}`;
				let shares = this.shares.get(key);
				if (!shares) this.shares.set(key, (shares = Float32Array.from(now.alpha)));
				let paint = now;
				let layer = paint.textures.indexOf(texture);
				// Shift erases: the texture's share goes to the others (nothing to do where it isn't).
				if (layer < 0 && invert) continue;
				if (layer < 0) {
					if (paint.textures.length < MAX_LAYERS) {
						layer = paint.textures.length;
					} else {
						layer = giveWay(shares);
					}
					this.touch(target.key, chunk);
					const textures = [...paint.textures];
					textures[layer] = texture;
					paint = { textures, alpha: paint.alpha };
				}
				let changed = false;
				for (let y = 0; y < PAINT_SIZE; y++) {
					const tz = z0 + (y + 0.5) * TEXEL;
					for (let x = 0; x < PAINT_SIZE; x++) {
						const f = falloff(Math.hypot(x0 + (x + 0.5) * TEXEL - center.x, tz - center.z), r, this.softness.value);
						if (!f) continue;
						const a = amount * f;
						const t = y * PAINT_SIZE + x;
						// Shares of layers 1-3; the base's is what's left. Painting a layer moves its share
						// towards all and the others' towards none; erasing it moves its share to the base.
						for (let l = 1; l < MAX_LAYERS; l++) {
							const i = (l - 1) * PAINT_TEXELS + t;
							if (l === layer && !invert) shares[i] += (255 - shares[i]) * a;
							else if (l === layer || (!invert && l !== layer)) shares[i] *= 1 - a;
						}
						changed = true;
					}
				}
				if (!changed) continue;
				this.touch(target.key, chunk);
				const alpha = new Uint8Array(PAINT_TEXELS * 3);
				for (let i = 0; i < alpha.length; i++) alpha[i] = Math.round(shares[i]);
				this.doc.setPaint(target.key, chunk, { textures: paint.textures, alpha });
				// The same layers as the tile was built with: shown at once. Else built again.
				const built = target.surface.textures[chunk];
				if (built.length === paint.textures.length && built.every((b, i) => b === paint.textures[i])) {
					for (let y = 0; y < PAINT_SIZE; y++) {
						for (let x = 0; x < PAINT_SIZE; x++) {
							const at = ((cy * PAINT_SIZE + y) * ATLAS + cx * PAINT_SIZE + x) * 4;
							for (let l = 0; l < 3; l++) target.atlas[at + l] = alpha[l * PAINT_TEXELS + y * PAINT_SIZE + x];
						}
					}
					atlasChanged = true;
				} else {
					this.stroke!.dirty.add(target.key);
				}
			}
			if (atlasChanged) target.atlasChanged();
		}
	}
}

/**
 * The water brush: floods the ground's cells (8x8 per chunk) with water, ocean, magma or slime at
 * a level, or dries them (Shift, or the remove mode). A chunk holds one flat liquid: flooding
 * part of one sets the whole of its liquid to the brush's type and level.
 */
export class WaterBrush extends SurfaceStroke<ChunkWater> {
	protected readonly kind = 'water';
	readonly type = signal<Exclude<WaterType, 'none'>>('water');
	readonly mode = signal<'add' | 'remove'>('add');
	/** A fixed surface level; null to take it from where each stroke starts. */
	readonly level = signal<number | null>(null);
	/** Yards above the ground a stroke started on dry land floods to. */
	readonly depth = signal(1.5);

	private strokeLevel = 0;

	/** The level the last stroke flooded at (a start for a fixed level). */
	get lastLevel(): number {
		return this.strokeLevel;
	}

	protected current(tile: string, chunk: number): ChunkWater | undefined {
		return this.doc.waterOf(tile, chunk);
	}

	protected set(tile: string, chunk: number, value: ChunkWater | undefined): void {
		this.doc.setWater(tile, chunk, value);
	}

	protected copy(value: ChunkWater): ChunkWater {
		return copyWater(value);
	}

	protected color(invert: boolean): number {
		return (this.mode.value === 'remove') !== invert ? 0xc08040 : 0x5cb8ff;
	}

	/** The surface where the mouse is: water there already, or the ground plus the depth. */
	protected began(center: THREE.Vector3): void {
		if (this.level.value !== null) {
			this.strokeLevel = this.level.value;
			return;
		}
		for (const target of this.host.surfaceTargetsIn(center.x, center.z, center.x, center.z)) {
			for (const { chunk, x0, z0 } of chunksIn(target, center.x, center.z, 0)) {
				const water = this.doc.waterOf(target.key, chunk) ?? target.surface.water[chunk];
				const cell = Math.min(7, Math.floor((center.z - z0) / CELL)) * 8 + Math.min(7, Math.floor((center.x - x0) / CELL));
				if (water?.type && water.cells[cell]) {
					this.strokeLevel = water.level;
					return;
				}
			}
		}
		this.strokeLevel = center.y + this.depth.value;
	}

	protected work(center: THREE.Vector3, _dt: number, invert: boolean): void {
		const r = this.size.value;
		const remove = (this.mode.value === 'remove') !== invert;
		const type = WATER_TYPES[this.type.value];
		for (const target of this.host.surfaceTargetsIn(center.x - r, center.z - r, center.x + r, center.z + r)) {
			for (const { chunk, x0, z0 } of chunksIn(target, center.x, center.z, r)) {
				const now = this.doc.waterOf(target.key, chunk) ?? target.surface.water[chunk] ?? { type: 0, level: this.strokeLevel, cells: new Uint8Array(64) };
				const cells = now.cells.slice();
				let changed = false;
				for (let i = 0; i < 64; i++) {
					const cx = x0 + ((i % 8) + 0.5) * CELL, cz = z0 + (Math.floor(i / 8) + 0.5) * CELL;
					if (Math.hypot(cx - center.x, cz - center.z) > r) continue;
					const value = remove ? 0 : 1;
					if (cells[i] !== value) {
						cells[i] = value;
						changed = true;
					}
				}
				// Flooding also brings the chunk's liquid to the brush's type and level.
				const next: ChunkWater = remove
					? { type: cells.some((c) => c) ? now.type : 0, level: now.level, cells }
					: { type, level: this.strokeLevel, cells };
				if (!changed && (remove || (now.type === type && now.level === this.strokeLevel))) continue;
				this.touch(target.key, chunk);
				this.doc.setWater(target.key, chunk, next);
				this.stroke!.dirty.add(target.key);
			}
		}
	}
}

/**
 * Frees a layer of a full chunk (shares of layers 1-3) for a new texture: the one that shows
 * least gives its share at each point to whichever texture is strongest there (the base when
 * none of the others is), so the ground looks much as it did. Returns the freed layer (1-3).
 */
function giveWay(shares: Float32Array): number {
	let weakest = 1, least = Infinity;
	for (let l = 1; l < MAX_LAYERS; l++) {
		let sum = 0;
		for (let t = 0; t < PAINT_TEXELS; t++) sum += shares[(l - 1) * PAINT_TEXELS + t];
		if (sum < least) {
			weakest = l;
			least = sum;
		}
	}
	const from = (weakest - 1) * PAINT_TEXELS;
	for (let t = 0; t < PAINT_TEXELS; t++) {
		const share = shares[from + t];
		if (!share) continue;
		// The strongest of the others here: a layer, or the base (what all the layers leave).
		let best = -1, bestShare = 255;
		for (let l = 1; l < MAX_LAYERS; l++) bestShare -= shares[(l - 1) * PAINT_TEXELS + t];
		for (let l = 1; l < MAX_LAYERS; l++) {
			const s = shares[(l - 1) * PAINT_TEXELS + t];
			if (l !== weakest && s > bestShare) {
				best = l;
				bestShare = s;
			}
		}
		if (best > 0) shares[(best - 1) * PAINT_TEXELS + t] += share;
		shares[from + t] = 0;
	}
	return weakest;
}
