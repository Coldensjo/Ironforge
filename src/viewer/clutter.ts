import * as THREE from 'three';
import { CHUNKS_PER_TILE, CHUNK_SIZE, TILE_CELLS } from '../formats/adt';
import type { ClutterSource } from '../explorer/groundEffects';
import type { ModelData, ModelMaterial } from '../explorer/objects';
import type { AsyncStorageApi } from '../worker/protocol';
import { createModelMaterial } from './modelMaterials';
import { perf } from './perf';
import { useShadows } from './shadows';
import { liquidTime } from './terrainMaterials';
import { TextureCache } from './textureCache';

/** Ground clutter shows within this distance (yards) of the camera, fading out over its last part. */
const RANGE = 100;
/** Instances are re-picked after the camera moves this far. */
const REBUILD_MOVE = 4;
/** Generated chunks are forgotten beyond this distance. */
const KEEP_RANGE = RANGE + 80;
const CELL = CHUNK_SIZE / 8;
const MODEL_BATCH = 8;
/** Unused clutter models stay loaded this long. */
const UNUSED_MODEL_TTL = 30000;
/** Floats per generated copy: x, y, z (world), yaw (radians), scale. */
const STRIDE = 5;
/**
 * Screenshots: clutter covers every held tile in view, at full density within this distance
 * (yards) and thinning beyond it as the square of the distance, so about as many copies show per
 * pixel of screen however far off, and the count stays bounded.
 */
const SHOT_FULL_RANGE = 300;
/** Screenshots: most chunks scattered per frame, so the page keeps showing progress. */
const SHOT_CHUNKS_PER_FRAME = 300;

const clutterRange = { value: RANGE };

interface ClutterTile {
	originX: number;
	originZ: number;
	source: ClutterSource;
	seed: number;
	/** Generated copies per chunk (y * 16 + x), by model. */
	chunks: Map<number, Map<number, Float32Array>>;
}

class ClutterModel {
	state: 'queued' | 'loading' | 'ready' | 'failed' = 'queued';
	geometry: THREE.BufferGeometry | null = null;
	materials: THREE.Material[] = [];
	mesh: THREE.InstancedMesh | null = null;
	textures: number[] = [];
	unusedSince = 0;

	constructor(readonly fdid: number, readonly sway: number) {}
}

/** Small, fast hash for seeding each cell's random numbers. */
function hash(a: number, b: number): number {
	let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ b;
	h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
	return (h ^ (h >>> 13)) >>> 0;
}

function random(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Height of the terrain mesh in a cell (gx, gz) at (u, v) within it: four triangles fan
 * around the cell's centre vertex, as the terrain is drawn.
 */
function surfaceHeight(source: ClutterSource, gx: number, gz: number, u: number, v: number): number {
	const n = TILE_CELLS;
	const w = n + 1;
	const { outer, inner } = source;
	const h00 = outer[gz * w + gx], h10 = outer[gz * w + gx + 1];
	const h01 = outer[(gz + 1) * w + gx], h11 = outer[(gz + 1) * w + gx + 1];
	// The triangle's two corners (a, b); the third is the centre.
	let ax: number, az: number, ah: number, bx: number, bz: number, bh: number;
	if (v <= u && v <= 1 - u) [ax, az, ah, bx, bz, bh] = [0, 0, h00, 1, 0, h10];
	else if (u >= v && u >= 1 - v) [ax, az, ah, bx, bz, bh] = [1, 0, h10, 1, 1, h11];
	else if (v >= u && v >= 1 - u) [ax, az, ah, bx, bz, bh] = [1, 1, h11, 0, 1, h01];
	else [ax, az, ah, bx, bz, bh] = [0, 1, h01, 0, 0, h00];
	const d = (bz - 0.5) * (ax - 0.5) + (0.5 - bx) * (az - 0.5);
	const wa = ((bz - 0.5) * (u - 0.5) + (0.5 - bx) * (v - 0.5)) / d;
	const wb = ((0.5 - az) * (u - 0.5) + (ax - 0.5) * (v - 0.5)) / d;
	return wa * ah + wb * bh + (1 - wa - wb) * inner[gz * n + gx];
}

/**
 * Adds wind sway and a distance fade to a clutter model's material: copies shrink away over the
 * last part of the range, and grass bends more the higher up the blade.
 */
function clutterMaterial(m: ModelMaterial, texture: THREE.Texture | null, sway: number): THREE.Material {
	const material = createModelMaterial(m, texture, false);
	const base = material.onBeforeCompile;
	const baseKey = material.customProgramCacheKey();
	material.onBeforeCompile = (shader, renderer) => {
		base.call(material, shader, renderer);
		Object.assign(shader.uniforms, { uClutterTime: liquidTime, uClutterRange: clutterRange, uClutterSway: { value: sway } });
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', '#include <common>\nuniform float uClutterTime;\nuniform float uClutterRange;\nuniform float uClutterSway;')
			.replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
				vec3 clutterOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
				float clutterFade = 1.0 - smoothstep(uClutterRange * 0.7, uClutterRange, distance(clutterOrigin, cameraPosition));
				float clutterPhase = clutterOrigin.x * 0.37 + clutterOrigin.z * 0.23;
				// Models are z-up: the higher the vertex, the more it bends.
				float clutterBend = uClutterSway * 0.06 * max(transformed.z, 0.0);
				transformed.xy += clutterBend * vec2(sin(uClutterTime * 1.7 + clutterPhase), cos(uClutterTime * 1.2 + clutterPhase * 1.6));
				transformed *= clutterFade;`);
	};
	material.customProgramCacheKey = () => `${baseKey}-clutter`;
	return material;
}

/**
 * Ground clutter (grass, flowers, pebbles) near the camera. Tiles hand over which clutter grows
 * in each terrain cell; copies are scattered per chunk only once the camera comes close, the
 * same way every time, and each model is drawn as one InstancedMesh.
 */
export class ClutterManager {
	readonly group = new THREE.Group();
	private readonly tiles = new Map<string, ClutterTile>();
	private readonly models = new Map<number, ClutterModel>();
	/** How much each model sways, from its GroundEffectDoodad row. */
	private readonly sway = new Map<number, number>();
	private readonly textures: TextureCache;
	private loading = 0;
	private readonly lastBuild = new THREE.Vector3(Infinity, Infinity, Infinity);
	private dirty = true;
	private on = true;
	/** A screenshot's view, while one is prepared (see holdInView). */
	private shot: THREE.Frustum | null = null;
	/** Thinned copies of the screenshot's far chunks, by tile key and chunk; let go after it. */
	private readonly shotChunks = new Map<string, Map<number, Map<number, Float32Array>>>();

	constructor(
		private readonly storage: AsyncStorageApi,
		compressed: boolean,
		anisotropy: number,
		private readonly prepare: (object: THREE.Object3D) => Promise<void>,
	) {
		this.textures = new TextureCache(storage, compressed, anisotropy);
	}

	get enabled(): boolean {
		return this.on;
	}

	set enabled(on: boolean) {
		this.on = on;
		this.group.visible = on;
		this.dirty = true;
	}

	/** A detailed terrain tile came in; originX/Z is its world-space north-west corner. */
	addTile(key: string, originX: number, originZ: number, source: ClutterSource | null): void {
		this.tiles.delete(key);
		if (!source) return;
		let seed = 0;
		for (let i = 0; i < key.length; i++) seed = hash(seed, key.charCodeAt(i));
		this.tiles.set(key, { originX, originZ, source, seed, chunks: new Map() });
		this.dirty = true;
	}

	/** A tile's ground was reshaped: its clutter is scattered again on the new heights. */
	heightsChanged(key: string): void {
		const tile = this.tiles.get(key);
		if (!tile) return;
		tile.chunks.clear();
		this.dirty = true;
	}

	removeTile(key: string): void {
		this.shotChunks.delete(key);
		if (this.tiles.delete(key)) this.dirty = true;
	}

	/**
	 * For a screenshot: clutter shows on everything in the camera's view, however far off (only
	 * the detailed tiles have any). Null goes back to the area around the camera.
	 */
	holdInView(camera: THREE.Camera | null): void {
		if (camera) {
			camera.updateMatrixWorld();
			this.shot = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
			clutterRange.value = Infinity;
		} else {
			this.shot = null;
			this.shotChunks.clear();
			clutterRange.value = RANGE;
			// Back to the usual few copies: let the screenshot's large buffers go.
			for (const model of this.models.values()) {
				if (!model.mesh) continue;
				this.group.remove(model.mesh);
				model.mesh.dispose();
				model.mesh = null;
			}
		}
		this.dirty = true;
	}

	/** For a screenshot: clutter still to scatter, and its models still to load. */
	get pending(): number {
		if (!this.on || !this.shot) return 0;
		let n = this.dirty ? 1 : 0;
		for (const model of this.models.values()) if (model.state === 'queued' || model.state === 'loading') n++;
		return n;
	}

	/** Call once per frame. ground gives the terrain height under the camera. */
	update(now: number, camera: THREE.Vector3, ground: number): void {
		const high = camera.y - ground > RANGE && !this.shot;
		if (this.on && !high && (this.dirty || this.lastBuild.distanceToSquared(camera) > REBUILD_MOVE ** 2)) {
			perf.time('clutter.build', () => this.build(camera));
		} else if ((!this.on || high) && this.lastBuild.x !== Infinity) {
			// Out of range: draw nothing, and pick again on coming back.
			for (const model of this.models.values()) if (model.mesh) model.mesh.count = 0;
			this.lastBuild.set(Infinity, Infinity, Infinity);
		}
		if (this.loading === 0) this.loadQueued();
		for (const [fdid, model] of this.models) {
			if (model.state !== 'ready') continue;
			if (model.mesh?.count) {
				model.unusedSince = 0;
			} else {
				model.unusedSince ||= now;
				if (now - model.unusedSince > UNUSED_MODEL_TTL) {
					this.dispose(model);
					this.models.delete(fdid);
				}
			}
		}
	}

	/** Picks the copies within range of the camera and writes them into each model's instances. */
	private build(camera: THREE.Vector3): void {
		this.dirty = false;
		this.lastBuild.copy(camera);
		const byModel = new Map<number, Float32Array[]>();
		const reach = RANGE + REBUILD_MOVE;
		const box = new THREE.Box3();
		let shotBudget = SHOT_CHUNKS_PER_FRAME;
		for (const [key, tile] of this.tiles) {
			for (let cy = 0; cy < CHUNKS_PER_TILE; cy++) {
				for (let cx = 0; cx < CHUNKS_PER_TILE; cx++) {
					const id = cy * CHUNKS_PER_TILE + cx;
					// Planar distance from the camera to the chunk's square.
					const x0 = tile.originX + cx * CHUNK_SIZE;
					const z0 = tile.originZ + cy * CHUNK_SIZE;
					const dx = Math.max(x0 - camera.x, 0, camera.x - x0 - CHUNK_SIZE);
					const dz = Math.max(z0 - camera.z, 0, camera.z - z0 - CHUNK_SIZE);
					const d2 = dx * dx + dz * dz;
					let chunk: Map<number, Float32Array> | undefined;
					if (d2 > reach ** 2) {
						if (d2 > KEEP_RANGE ** 2) tile.chunks.delete(id);
						if (!this.shot) continue;
						let held = this.shotChunks.get(key);
						if (!held) this.shotChunks.set(key, (held = new Map()));
						chunk = held.get(id);
						if (!chunk) {
							if (!this.shot.intersectsBox(this.chunkBox(tile, cx, cy, box))) continue;
							if (shotBudget-- <= 0) {
								this.dirty = true;
								continue;
							}
							const d = Math.hypot(Math.sqrt(d2), Math.max(0, camera.y - box.max.y));
							chunk = this.generate(tile, cx, cy, Math.min(1, (SHOT_FULL_RANGE / d) ** 2));
							held.set(id, chunk);
						}
					} else {
						chunk = tile.chunks.get(id);
						if (!chunk) {
							chunk = this.generate(tile, cx, cy);
							tile.chunks.set(id, chunk);
						}
					}
					for (const [fdid, copies] of chunk) {
						let list = byModel.get(fdid);
						if (!list) byModel.set(fdid, (list = []));
						list.push(copies);
					}
				}
			}
		}

		for (const [fdid, model] of this.models) if (!byModel.has(fdid) && model.mesh) model.mesh.count = 0;
		for (const [fdid, lists] of byModel) {
			let model = this.models.get(fdid);
			if (!model) this.models.set(fdid, (model = new ClutterModel(fdid, this.sway.get(fdid) ?? 0)));
			if (model.state !== 'ready') continue;
			let capacity = 0;
			for (const l of lists) capacity += l.length / STRIDE;
			const mesh = this.meshFor(model, capacity);
			const out = mesh.instanceMatrix.array as Float32Array;
			let count = 0;
			const limit = this.shot ? Infinity : reach * reach;
			for (const l of lists) {
				for (let i = 0; i < l.length; i += STRIDE) {
					const x = l[i], y = l[i + 1], z = l[i + 2];
					if ((x - camera.x) ** 2 + (y - camera.y) ** 2 + (z - camera.z) ** 2 > limit) continue;
					// Turned about the vertical, after standing the z-up model upright.
					const c = Math.cos(l[i + 3]) * l[i + 4];
					const s = Math.sin(l[i + 3]) * l[i + 4];
					const o = count++ * 16;
					out[o] = c; out[o + 1] = 0; out[o + 2] = -s; out[o + 3] = 0;
					out[o + 4] = -s; out[o + 5] = 0; out[o + 6] = -c; out[o + 7] = 0;
					out[o + 8] = 0; out[o + 9] = l[i + 4]; out[o + 10] = 0; out[o + 11] = 0;
					out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
				}
			}
			mesh.count = count;
			mesh.instanceMatrix.clearUpdateRanges();
			mesh.instanceMatrix.addUpdateRange(0, count * 16);
			mesh.instanceMatrix.needsUpdate = true;
		}
	}

	/** A chunk's bounds, from its terrain heights, with room above for the clutter on it. */
	private chunkBox(tile: ClutterTile, cx: number, cy: number, box: THREE.Box3): THREE.Box3 {
		const { outer } = tile.source;
		const w = TILE_CELLS + 1;
		let min = Infinity, max = -Infinity;
		for (let row = 0; row <= 8; row++) {
			for (let col = 0; col <= 8; col++) {
				const h = outer[(cy * 8 + row) * w + cx * 8 + col];
				min = Math.min(min, h);
				max = Math.max(max, h);
			}
		}
		box.min.set(tile.originX + cx * CHUNK_SIZE, min, tile.originZ + cy * CHUNK_SIZE);
		box.max.set(tile.originX + (cx + 1) * CHUNK_SIZE, max + 10, tile.originZ + (cy + 1) * CHUNK_SIZE);
		return box;
	}

	/**
	 * Scatters one chunk's copies: density per cell, models by weight, the same every time.
	 * keep thins them out (for a screenshot's far chunks), leaving a share of the same copies.
	 */
	private generate(tile: ClutterTile, cx: number, cy: number, keep = 1): Map<number, Float32Array> {
		const { source } = tile;
		const lists = new Map<number, number[]>();
		for (let row = 0; row < 8; row++) {
			for (let col = 0; col < 8; col++) {
				const gx = cx * 8 + col;
				const gz = cy * 8 + row;
				const effectIndex = source.cells[gz * TILE_CELLS + gx];
				if (!effectIndex) continue;
				const effect = source.effects[effectIndex - 1];
				const rand = random(hash(tile.seed, gz * TILE_CELLS + gx));
				let total = 0;
				for (const d of effect.doodads) total += d.weight;
				for (let k = 0; k < effect.density; k++) {
					const u = rand();
					const v = rand();
					let pick = rand() * total;
					const doodad = effect.doodads.find((d) => (pick -= d.weight) < 0) ?? effect.doodads[0];
					const yaw = THREE.MathUtils.degToRad(rand() * doodad.yaw);
					const scale = doodad.minScale + rand() * (doodad.maxScale - doodad.minScale);
					if (keep < 1 && rand() >= keep) continue;
					let list = lists.get(doodad.fdid);
					if (!list) {
						lists.set(doodad.fdid, (list = []));
						if (!this.sway.has(doodad.fdid)) this.sway.set(doodad.fdid, doodad.sway);
					}
					list.push(tile.originX + (gx + u) * CELL, surfaceHeight(source, gx, gz, u, v), tile.originZ + (gz + v) * CELL, yaw, scale);
				}
			}
		}
		return new Map([...lists].map(([fdid, list]) => [fdid, new Float32Array(list)]));
	}

	private meshFor(model: ClutterModel, count: number): THREE.InstancedMesh {
		let mesh = model.mesh;
		if (!mesh || mesh.instanceMatrix.count < count) {
			if (mesh) {
				this.group.remove(mesh);
				mesh.dispose();
			}
			const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
			mesh = new THREE.InstancedMesh(model.geometry!, model.materials, capacity);
			mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			mesh.matrixAutoUpdate = false;
			// The copies surround the camera; there's nothing to cull.
			mesh.frustumCulled = false;
			// Grass lies in the shade of trees and walls; too small to cast any worth the cost.
			useShadows(mesh, 'receive');
			this.group.add(mesh);
			model.mesh = mesh;
		}
		return mesh;
	}

	private loadQueued(): void {
		const batch = [...this.models.values()].filter((m) => m.state === 'queued').slice(0, MODEL_BATCH);
		if (!batch.length) return;
		for (const m of batch) m.state = 'loading';
		this.loading++;
		this.storage.loadModels(batch.map((m) => ({ fdid: m.fdid, kind: 'm2' as const })))
			.then((results) => Promise.all(batch.map((m, i) => this.buildModel(m, results[i]))))
			.catch((e) => {
				console.warn('Clutter models failed:', e);
				for (const m of batch) m.state = 'failed';
			})
			.finally(() => {
				this.loading--;
				this.dirty = true;
			});
	}

	private async buildModel(model: ClutterModel, data: ModelData | null): Promise<void> {
		if (!data || data.batches.length === 0) {
			model.state = 'failed';
			return;
		}
		model.textures = [...new Set(data.batches.map((b) => b.material.texture).filter((t) => t))];
		const textures = await this.textures.acquire(model.textures);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
		geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
		geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
		geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
		const batches = [...data.batches].sort((a, b) => a.order - b.order);
		model.materials = batches.map((b, i) => {
			geometry.addGroup(b.start, b.count, i);
			return clutterMaterial(b.material, textures.get(b.material.texture) ?? null, model.sway);
		});
		await this.prepare(new THREE.InstancedMesh(geometry, model.materials, 1));
		model.geometry = geometry;
		model.state = 'ready';
	}

	private dispose(model: ClutterModel): void {
		if (model.mesh) {
			this.group.remove(model.mesh);
			model.mesh.dispose();
		}
		model.geometry?.dispose();
		for (const m of model.materials) m.dispose();
		this.textures.release(model.textures);
	}

	/** Copies drawn, for the perf report. */
	get drawn(): number {
		let n = 0;
		for (const model of this.models.values()) n += model.mesh?.count ?? 0;
		return n;
	}
}
