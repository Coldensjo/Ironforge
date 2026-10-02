import * as THREE from 'three';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import type { ModelData, ObjectKind, Placement } from '../explorer/objects';
import type { SpawnInfo } from '../explorer/spawns';
import type { AsyncStorageApi } from '../worker/protocol';
import { createModelMaterial, createSkinnedDepthMaterial, type SkinUniforms } from './modelMaterials';
import { Mover, type GroundAt } from './movers';
import { perf } from './perf';
import { PARTICLE_RANGE, SHOT_PARTICLE_RANGE, ParticleSystem, type EmitterSource, type LoadedEmitter } from './particles';
import { useShadows, type ShadowRole } from './shadows';
import { liquidMaterial } from './terrainMaterials';
import { TextureCache } from './textureCache';

/** Yards above a creature's head its name sits. */
const NAME_CLEARANCE = 0.35;

/** Where a creature's name goes: model space is z-up, so its head is at (0, 0, height), then a little above. */
export function headPosition(matrix: THREE.Matrix4, height: number, out: THREE.Vector3): THREE.Vector3 {
	out.set(0, 0, height).applyMatrix4(matrix);
	out.y += NAME_CLEARANCE;
	return out;
}

type Kind = ObjectKind;
/** What the View panel can hide: kinds of spawn, or spirit healers among the creatures. */
export type Hideable = 'creature' | 'object' | 'spiritHealer';

// Ray casts use a model's BVH when it has one (buildings); InstancedMesh casts go through this too.
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** Models per worker request; small batches let the nearest models show up sooner. */
const MODEL_BATCH = 8;
const MAX_MODEL_REQUESTS = 4;
/** Unused models stay cached this long, so flying back and forth doesn't reload them. */
const UNUSED_MODEL_TTL = 15000;
/** How often (ms) instance visibility is re-checked against the camera. */
const CULL_INTERVAL = 250;
/** Models smaller than this (radius in yards: crates, fences, people) cast shadows only in the near cascade. */
const SMALL_CASTER = 3;
/** Creatures further than this (yards) from the camera stand still. */
const MOVE_RANGE = 300;

/**
 * View distance for a doodad of a given (scaled) radius, like the game's doodad LOD: small props
 * vanish within a few hundred yards, big trees stay visible much further.
 */
function viewDistance(radius: number): number {
	return THREE.MathUtils.clamp(radius * 80, 150, 1600);
}

/** One model's geometry, drawn with a single InstancedMesh for every placed copy. */
class ModelEntry {
	state: 'queued' | 'loading' | 'ready' | 'failed' = 'queued';
	data: ModelData | null = null;
	mesh: THREE.InstancedMesh | null = null;
	geometry: THREE.BufferGeometry | null = null;
	materials: THREE.Material[] = [];
	/** For GPU-skinned models: the shadow pass's material, skinned the same way. */
	depthMaterial: THREE.Material | null = null;
	/** For GPU-skinned models: the bone texture and loops their materials share. */
	skin: SkinUniforms | null = null;
	textures: number[] = [];
	/** WMO liquid surfaces, instanced with the same matrices as the model. */
	liquids: { geometry: THREE.BufferGeometry; material: THREE.Material; type: number; mesh: THREE.InstancedMesh | null }[] = [];
	readonly instances = new Map<string, THREE.Matrix4>();
	/** Keys of the instances currently in the instance buffer (those within view distance). */
	visible = new Set<string>();
	/** Set for models animated on the GPU: their shared bone texture and loop length. */
	animation: { key: string; duration: number } | null = null;
	/** Particle emitters (fire, smoke), with their textures. */
	emitters: LoadedEmitter[] = [];
	/** Instance key for each slot in the instance buffer, for picking. */
	drawnKeys: string[] = [];
	/** Slot in the instance buffer by instance key, for moving creatures. */
	slots = new Map<string, number>();
	radius = 0;
	dirty = false;
	unusedSince = 0;
	readonly onReady: ((entry: ModelEntry) => void)[] = [];

	constructor(readonly kind: Kind, readonly fdid: number, readonly variant?: string) {}
}

/** A placed object; objects crossing tile borders are listed by several tiles. */
interface PlacedObject {
	refs: number;
	/** How many of those tiles are at full detail; WMO doodads show only while this is > 0. */
	detailRefs: number;
	placement: Placement;
	matrix: THREE.Matrix4;
	/** Model entries and instance keys this object contributed. */
	parts: { entry: ModelEntry; key: string }[];
	/** WMO doodad instances, kept apart so they can come and go with detail. */
	doodadParts: { entry: ModelEntry; key: string; local: THREE.Matrix4 }[];
	/** Creatures that walk (waypoints or wandering); moves matrix in place. */
	mover?: Mover;
}

export type ObjectLevel = 'none' | 'wmo' | 'all';

/** One model of a placed thing as it's drawn now (see shapeOf). */
export interface ModelShape {
	/** The instance's key, the same while it stays this model. */
	key: string;
	geometry: THREE.BufferGeometry;
	/** One per geometry group. */
	materials: THREE.Material[];
	skin: SkinUniforms | null;
	matrix: THREE.Matrix4;
	/** The model's bounding radius, before the placement's scale. */
	radius: number;
	/** Seconds into its loop it's offset by. */
	phase: number;
	walking: boolean;
}

/**
 * A copy's point in its animation loop, stable per placement (hashed from its key), so a crowd
 * of the same NPC doesn't move in lockstep.
 */
function loopPhase(key: string, duration: number): number {
	let h = 2166136261;
	for (let c = 0; c < key.length; c++) h = Math.imul(h ^ key.charCodeAt(c), 16777619);
	return ((h >>> 0) / 4294967296) * duration;
}

interface TileRecord {
	wdt: number;
	placements: Placement[] | null;
	level: ObjectLevel;
	/** Object keys this tile holds a reference to, and whether it counts toward their detail. */
	applied: Map<string, boolean>;
	toWorld: THREE.Matrix4;
}

export interface ObjectStats {
	models: number;
	instances: number;
	drawn: number;
	loading: number;
}

/**
 * Doodads (M2) and buildings (WMO) around the camera. Placements come per tile; each
 * distinct model is loaded once and drawn instanced. Distant tiles show only buildings,
 * without their interior doodads, to keep the number of distinct models (draw calls) down.
 */
export class ObjectManager {
	readonly group = new THREE.Group();
	private readonly models = new Map<string, ModelEntry>();
	private readonly objects = new Map<string, PlacedObject>();
	private readonly tiles = new Map<string, TileRecord>();
	/**
	 * Spawns changed in the editor, by their tiles' key for them (wdt:kind:uid): the placement
	 * to draw instead, or null when deleted. Tiles skip their own copies of these.
	 */
	private readonly edits = new Map<string, Placement | null>();
	private readonly queue: ModelEntry[] = [];
	private requests = 0;
	private readonly textures: TextureCache;
	readonly particles = new ParticleSystem();

	/**
	 * prepare compiles an object's shaders off the critical path (renderer.compileAsync), so a
	 * model's first frame doesn't stall on shader compilation; shadowPass for depth materials.
	 */
	constructor(
		private readonly storage: AsyncStorageApi,
		compressed: boolean,
		anisotropy: number,
		private readonly prepare: (object: THREE.Object3D, shadowPass?: boolean) => Promise<void>,
	) {
		this.textures = new TextureCache(storage, compressed, anisotropy);
		this.group.add(this.particles.group);
		this.particles.warmUp(prepare);
	}

	/**
	 * Sets how much of a tile's objects to show: 'wmo' shows bare buildings for the distance,
	 * 'all' adds scattered doodads and the buildings' own doodads. offset moves continent
	 * space into the shared world.
	 */
	setTileLevel(tileKey: string, wdt: number, x: number, y: number, offset: THREE.Vector3, level: ObjectLevel): void {
		let tile = this.tiles.get(tileKey);
		if (!tile) {
			if (level === 'none') return;
			tile = { wdt, placements: null, level, applied: new Map(), toWorld: new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z) };
			this.tiles.set(tileKey, tile);
			const record = tile;
			this.storage.loadTileObjects(wdt, x, y).then((placements) => {
				record.placements = placements;
				this.apply(tileKey, record);
			}, (e) => {
				console.warn(`Objects for ${tileKey}:`, e);
				record.placements = [];
			});
			return;
		}
		tile.level = level;
		this.apply(tileKey, tile);
	}

	private apply(tileKey: string, tile: TileRecord): void {
		if (this.tiles.get(tileKey) !== tile) return;
		const detail = tile.level === 'all';
		const wanted = new Map<string, Placement>();
		if (tile.placements && tile.level !== 'none') {
			for (const p of tile.placements) {
				const key = `${tile.wdt}:${p.kind}:${p.uid}`;
				if ((detail || p.kind === 'wmo') && !this.edits.has(key)) wanted.set(key, p);
			}
		}
		for (const [key, p] of wanted) {
			const had = tile.applied.get(key);
			if (had === undefined) this.acquire(key, p, tile.toWorld);
			if (had !== detail) {
				if (had !== undefined || detail) this.changeDetail(key, detail ? 1 : had ? -1 : 0);
				tile.applied.set(key, detail);
			}
		}
		for (const [key, hadDetail] of tile.applied) {
			if (wanted.has(key)) continue;
			tile.applied.delete(key);
			if (hadDetail) this.changeDetail(key, -1);
			this.release(key);
		}
		if (tile.level === 'none' && tile.placements) this.tiles.delete(tileKey);
	}

	/**
	 * Draws an edited spawn from its new placement (null: not at all), in place of the tile's
	 * copy, or (undefined) hands it back to its tile. offset moves continent space into the world.
	 */
	setEdit(wdt: number, offset: THREE.Vector3, kind: Kind, uid: number, placement: Placement | null | undefined): void {
		const key = `${wdt}:${kind}:${uid}`;
		const editKey = `edit:${key}`;
		const before = this.edits.get(key);
		const object = this.objects.get(editKey);
		const toWorld = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
		const part = object?.parts[0];
		if (object && part && placement && part.entry === this.models.get(`${kind}:${placement.fdid}:${placement.variant ?? ''}`)) {
			// The same model: just move it (every frame while it's dragged).
			object.placement = placement;
			object.matrix.copy(toWorld).multiply(new THREE.Matrix4().fromArray(placement.matrix));
			part.entry.dirty = true;
			// A building's furniture goes with it.
			for (const d of object.doodadParts) {
				d.entry.instances.get(d.key)?.copy(object.matrix).multiply(d.local);
				d.entry.dirty = true;
			}
			this.edits.set(key, placement);
			return;
		}
		if (object) this.release(editKey);
		if (placement === undefined) this.edits.delete(key);
		else this.edits.set(key, placement);
		if (placement) {
			this.acquire(editKey, placement, toWorld);
			// Edited buildings always show their furniture, however far their tile is.
			if (kind === 'wmo') this.changeDetail(editKey, 1);
		}
		// Tiles drop or take back their own copy.
		if ((before === undefined) !== (placement === undefined)) {
			for (const [tileKey, tile] of this.tiles) if (tile.wdt === wdt) this.apply(tileKey, tile);
		}
	}

	/** Where an NPC, object or model is drawn (edited or not) and its model's radius and height, if it's placed. */
	/**
	 * What a placed thing is drawn with, model by model, for drawing its shape again (the
	 * editor's selection outline). Empty while it's out of view or still loading.
	 */
	shapeOf(wdt: number, kind: Kind, uid: number): ModelShape[] {
		const key = `${wdt}:${kind}:${uid}`;
		const object = this.objects.get(`edit:${key}`) ?? this.objects.get(key);
		if (!object) return [];
		return object.parts.flatMap(({ entry, key }) => {
			const matrix = entry.instances.get(key);
			if (entry.state !== 'ready' || !entry.geometry || !matrix || !entry.visible.has(key)) return [];
			return [{
				key,
				geometry: entry.geometry,
				materials: entry.materials,
				skin: entry.skin,
				matrix,
				radius: entry.radius,
				phase: entry.animation ? loopPhase(key, entry.animation.duration) : 0,
				walking: !!object.mover?.walking,
			}];
		});
	}

	spawnAt(wdt: number, kind: Kind, uid: number): { matrix: THREE.Matrix4; radius: number; height: number; animations?: number[] } | null {
		const key = `${wdt}:${kind}:${uid}`;
		const object = this.objects.get(`edit:${key}`) ?? this.objects.get(key);
		const entry = object?.parts[0]?.entry;
		if (!object || !entry) return null;
		const ready = entry.state === 'ready' && entry.data;
		return { matrix: object.matrix, radius: ready ? entry.radius : 1, height: ready ? entry.data!.height : 2, animations: ready ? entry.data!.animations : undefined };
	}

	private acquire(key: string, p: Placement, toWorld: THREE.Matrix4): void {
		const existing = this.objects.get(key);
		if (existing) {
			existing.refs++;
			return;
		}
		const object: PlacedObject = {
			refs: 1,
			detailRefs: 0,
			placement: p,
			matrix: toWorld.clone().multiply(new THREE.Matrix4().fromArray(p.matrix)),
			parts: [],
			doodadParts: [],
		};
		if (p.movement) object.mover = new Mover(p.movement, object.matrix, new THREE.Vector3().setFromMatrixPosition(toWorld));
		this.objects.set(key, object);
		object.parts.push(this.addInstance(p.kind, p.fdid, key, object.matrix, p.variant));
	}

	private release(key: string): void {
		const object = this.objects.get(key);
		if (!object || --object.refs > 0) return;
		this.objects.delete(key);
		for (const part of [...object.parts, ...object.doodadParts]) this.removeInstance(part);
	}

	private changeDetail(key: string, delta: number): void {
		const object = this.objects.get(key);
		if (!object || delta === 0) return;
		object.detailRefs += delta;
		if (object.placement.kind !== 'wmo') return;
		if (object.detailRefs > 0 && object.doodadParts.length === 0) {
			this.whenReady('wmo', object.placement.fdid, (entry) => this.addWmoDoodads(key, object, entry));
		} else if (object.detailRefs <= 0) {
			for (const part of object.doodadParts) this.removeInstance(part);
			object.doodadParts = [];
		}
	}

	private addWmoDoodads(key: string, object: PlacedObject, entry: ModelEntry): void {
		// The WMO may have been removed, or lost detail, before it finished loading.
		if (this.objects.get(key) !== object || object.detailRefs <= 0 || object.doodadParts.length || !entry.data?.doodadSets) return;
		const sets = entry.data.doodadSets;
		// Set 0 is always shown; the placement can add one more.
		const chosen = new Set([0, object.placement.doodadSet]);
		let i = 0;
		for (const s of chosen) {
			for (const d of sets[s]?.doodads ?? []) {
				const local = new THREE.Matrix4().fromArray(d.matrix);
				const matrix = object.matrix.clone().multiply(local);
				object.doodadParts.push({ ...this.addInstance('m2', d.fdid, `${key}:${i++}`, matrix), local });
			}
		}
	}

	private addInstance(kind: Kind, fdid: number, key: string, matrix: THREE.Matrix4, variant?: string): { entry: ModelEntry; key: string } {
		const entry = this.entry(kind, fdid, variant);
		entry.instances.set(key, matrix);
		entry.dirty = true;
		return { entry, key };
	}

	private removeInstance(part: { entry: ModelEntry; key: string }): void {
		part.entry.instances.delete(part.key);
		// Until the next flush, collision and the movers walk the visible set: it mustn't name it.
		part.entry.visible.delete(part.key);
		part.entry.dirty = true;
	}
	private entry(kind: Kind, fdid: number, variant?: string): ModelEntry {
		const id = `${kind}:${fdid}:${variant ?? ''}`;
		let entry = this.models.get(id);
		if (!entry) {
			entry = new ModelEntry(kind, fdid, variant);
			this.models.set(id, entry);
			this.queue.push(entry);
		}
		return entry;
	}

	private whenReady(kind: Kind, fdid: number, fn: (entry: ModelEntry) => void): void {
		const entry = this.entry(kind, fdid);
		if (entry.state === 'ready') fn(entry);
		else entry.onReady.push(fn);
	}

	private lastCull = 0;
	private readonly camera = new THREE.Vector3();

	private lastUpdate = 0;
	private readonly emitterSources: EmitterSource[] = [];

	/** Call once per frame: starts model loads, culls by view distance and applies instance changes. */
	update(now: number, camera: THREE.Vector3): void {
		this.camera.copy(camera);
		const dt = this.lastUpdate ? (now - this.lastUpdate) / 1000 : 0;
		this.lastUpdate = now;
		const cull = now - this.lastCull > CULL_INTERVAL;
		if (cull) this.lastCull = now;
		if (this.requests < MAX_MODEL_REQUESTS && this.queue.length) this.prioritize();
		while (this.requests < MAX_MODEL_REQUESTS && this.queue.length) {
			const batch = this.queue.splice(0, MODEL_BATCH).filter((e) => e.state === 'queued');
			if (batch.length) void this.load(batch);
		}
		for (const [id, entry] of this.models) {
			if (entry.state === 'ready' && (entry.dirty || (cull && this.visibilityChanged(entry)))) this.flush(entry);
			if (entry.instances.size === 0 && entry.state !== 'loading' && entry.state !== 'queued') {
				entry.unusedSince ||= now;
				if (now - entry.unusedSince > UNUSED_MODEL_TTL) {
					this.dispose(entry);
					this.models.delete(id);
				}
			} else {
				entry.unusedSince = 0;
			}
		}
		perf.time('movers', () => this.moveCreatures(dt, cull));
		perf.time('particles', () => this.particles.update(dt, this.nearbyEmitters()));
		// Not a time: the live particle count, averaged the same way.
		perf.record('particles.alive', this.particles.count);
	}

	/** Ground height for walking creatures; the viewer supplies the terrain's. */
	groundAt: GroundAt = () => NaN;

	/** Walks the creatures near the camera and writes their new places into the instance buffers. */
	private moveCreatures(dt: number, cull: boolean): void {
		if (dt <= 0) return;
		for (const entry of this.models.values()) {
			const mesh = entry.mesh;
			if (entry.kind !== 'creature' || !mesh || !entry.visible.size) continue;
			const anim = entry.geometry?.getAttribute('instanceAnim') as THREE.InstancedBufferAttribute | undefined;
			let moved = false;
			for (const key of entry.visible) {
				const mover = this.objects.get(key)?.mover;
				const slot = entry.slots.get(key);
				if (!mover || slot === undefined) continue;
				const m = entry.instances.get(key)!;
				const e = m.elements;
				if ((e[12] - this.camera.x) ** 2 + (e[13] - this.camera.y) ** 2 + (e[14] - this.camera.z) ** 2 > MOVE_RANGE ** 2) continue;
				if (mover.update(dt, this.groundAt)) {
					mesh.setMatrixAt(slot, m);
					moved = true;
				}
				const walking = mover.walking ? 1 : 0;
				if (anim && anim.getX(slot) !== walking) {
					anim.setX(slot, walking);
					anim.needsUpdate = true;
				}
			}
			if (moved) {
				mesh.instanceMatrix.needsUpdate = true;
				// Walkers can leave the bounds the mesh was culled by.
				if (cull) mesh.computeBoundingSphere();
			}
		}
	}

	/** Placed copies of models with particle emitters, near enough for their particles to show. */
	private nearbyEmitters(): EmitterSource[] {
		const out = this.emitterSources;
		out.length = 0;
		const range = this.showAll ? SHOT_PARTICLE_RANGE : PARTICLE_RANGE;
		for (const [id, entry] of this.models) {
			if (!entry.emitters.length || entry.state !== 'ready') continue;
			for (const key of entry.visible) {
				const m = entry.instances.get(key);
				if (!m) continue;
				const e = m.elements;
				if ((e[12] - this.camera.x) ** 2 + (e[13] - this.camera.y) ** 2 + (e[14] - this.camera.z) ** 2 > range ** 2) continue;
				out.push({ key: `${id}|${key}`, matrix: m, emitters: entry.emitters });
			}
		}
		return out;
	}

	/** Orders the load queue by each model's nearest placed copy, so the area around you fills in first. */
	private prioritize(): void {
		const distance = new Map<ModelEntry, number>();
		for (const entry of this.queue) {
			let best = Infinity;
			for (const m of entry.instances.values()) {
				const e = m.elements;
				best = Math.min(best, (e[12] - this.camera.x) ** 2 + (e[13] - this.camera.y) ** 2 + (e[14] - this.camera.z) ** 2);
			}
			distance.set(entry, best);
		}
		this.queue.sort((a, b) => distance.get(a)! - distance.get(b)!);
	}

	private async load(batch: ModelEntry[]): Promise<void> {
		this.requests++;
		for (const e of batch) e.state = 'loading';
		try {
			const results = await this.storage.loadModels(batch.map((e) => ({ fdid: e.fdid, kind: e.kind, variant: e.variant })));
			await Promise.all(batch.map((entry, i) => this.build(entry, results[i])));
		} catch (e) {
			console.warn('Model batch failed:', e);
			for (const entry of batch) entry.state = 'failed';
		} finally {
			this.requests--;
		}
	}

	private async build(entry: ModelEntry, data: ModelData | null): Promise<void> {
		// Some models are only their particles (instance portals: a hidden quad and the swirl).
		if (!data || (data.batches.length === 0 && !data.emitters?.length)) {
			entry.state = 'failed';
			return;
		}
		entry.textures = [...new Set([...data.batches.map((b) => b.material.texture), ...(data.emitters ?? []).map((e) => e.texture)].filter((t) => t))];
		const textures = await this.textures.acquire(entry.textures);
		entry.emitters = (data.emitters ?? []).flatMap((def) => {
			const texture = textures.get(def.texture);
			return texture ? [{ def, texture }] : [];
		});

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
		geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
		geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
		if (data.baked) geometry.setAttribute('baked', new THREE.BufferAttribute(data.baked, 4));
		let skin: SkinUniforms | null = null;
		if (data.animation) {
			const a = data.animation;
			geometry.setAttribute('boneIndex', new THREE.BufferAttribute(a.boneIndex, 4));
			geometry.setAttribute('boneWeight', new THREE.BufferAttribute(a.boneWeight, 4, true));
			const frames = a.clips.reduce((n, c) => Math.max(n, c.row + c.frames), 0);
			skin = {
				uBoneTex: { value: this.acquireBones(a.key, a.data, a.bones, frames) },
				uClips: { value: a.clips.map((c) => new THREE.Vector3(c.row, c.frames, c.duration)) },
			};
			entry.animation = { key: a.key, duration: a.clips[0].duration };
			entry.skin = skin;
			entry.depthMaterial = createSkinnedDepthMaterial(skin);
		}
		geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
		const batches = [...data.batches].sort((a, b) => a.order - b.order);
		entry.materials = batches.map((b, i) => {
			geometry.addGroup(b.start, b.count, i);
			return createModelMaterial(b.material, textures.get(b.material.texture) ?? null, !!data.baked, skin);
		});
		geometry.computeBoundingSphere();
		if (data.bvh) {
			geometry.boundsTree = MeshBVH.deserialize({ ...data.bvh, index: data.indices } as Parameters<typeof MeshBVH.deserialize>[0], geometry, { setIndex: false });
		}
		entry.liquids = (data.liquids ?? []).map((l) => ({ geometry: liquidGeometry(l.positions, l.indices), material: liquidMaterial(l.kind, l.type), type: l.type, mesh: null }));
		// Warm the instanced shader variants, which are what the model and its liquids will be drawn with.
		const warm = new THREE.Group().add(new THREE.InstancedMesh(geometry, entry.materials, 1), ...entry.liquids.map((l) => new THREE.InstancedMesh(l.geometry, l.material, 1)));
		const warming = [this.prepare(warm)];
		if (entry.depthMaterial) {
			// The shadow pass draws the depth material with each batch's texture and alpha test,
			// flipped to the faces away from the sun (WebGLShadowMap's getDepthMaterial).
			const depth = entry.depthMaterial as THREE.MeshDepthMaterial;
			const variants = new Set<string>();
			for (const m of entry.materials) {
				const map = (m as THREE.MeshLambertMaterial).map ?? null;
				const side = m.side === THREE.DoubleSide ? THREE.DoubleSide : m.side === THREE.BackSide ? THREE.FrontSide : THREE.BackSide;
				const variant = `${!!map} ${m.alphaTest > 0} ${side}`;
				if (variants.has(variant)) continue;
				variants.add(variant);
				depth.map = map;
				depth.alphaTest = m.alphaTest;
				depth.side = side;
				warming.push(this.prepare(new THREE.InstancedMesh(geometry, depth, 1), true));
			}
		}
		await Promise.all(warming);
		entry.geometry = geometry;
		entry.radius = data.radius;
		entry.data = { ...data, positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), baked: null, indices: new Uint32Array(0), liquids: [], animation: undefined };
		entry.state = 'ready';
		entry.dirty = true;
		for (const fn of entry.onReady.splice(0)) fn(entry);
	}

	private showAll = false;

	/**
	 * For a screenshot: every placed copy shows, however far off (tiles still limit what's placed),
	 * and particles run further out.
	 */
	set unlimited(on: boolean) {
		if (on === this.showAll) return;
		this.showAll = on;
		for (const entry of this.models.values()) entry.dirty = true;
	}

	private readonly hiddenKinds = new Set<Hideable>();

	/** Shows or hides every creature (NPCs and monsters), game object (chests, herbs, doors...) or spirit healer. */
	setKindShown(kind: Hideable, shown: boolean): void {
		if (shown !== this.hiddenKinds.has(kind)) return;
		if (shown) this.hiddenKinds.delete(kind);
		else this.hiddenKinds.add(kind);
		const modelKind = kind === 'spiritHealer' ? 'creature' : kind;
		for (const entry of this.models.values()) if (entry.kind === modelKind) entry.dirty = true;
	}

	kindShown(kind: Hideable): boolean {
		return !this.hiddenKinds.has(kind);
	}

	/** Models and tiles' placements still to load. */
	get pending(): number {
		let n = this.queue.length + this.requests;
		for (const tile of this.tiles.values()) if (!tile.placements && tile.level !== 'none') n++;
		return n;
	}

	private isVisible(entry: ModelEntry, key: string, m: THREE.Matrix4): boolean {
		if ((entry.kind === 'creature' || entry.kind === 'object') && this.hiddenKinds.has(entry.kind)) return false;
		if (entry.kind === 'creature' && this.hiddenKinds.has('spiritHealer') && this.objects.get(key)?.placement.spawn?.spiritHealer) return false;
		// Buildings are already limited by tile distance.
		if (entry.kind === 'wmo' || this.showAll) return true;
		const e = m.elements;
		const scale = Math.hypot(e[0], e[1], e[2]);
		const dx = e[12] - this.camera.x, dy = e[13] - this.camera.y, dz = e[14] - this.camera.z;
		return dx * dx + dy * dy + dz * dz < viewDistance(entry.radius * scale) ** 2;
	}

	private visibilityChanged(entry: ModelEntry): boolean {
		let count = 0;
		for (const [key, m] of entry.instances) {
			if (this.isVisible(entry, key, m) !== entry.visible.has(key)) return true;
			count++;
		}
		return count === 0 && entry.visible.size > 0;
	}

	/** Rewrites a model's instance buffer with its placed copies that are within view distance. */
	private flush(entry: ModelEntry): void {
		entry.dirty = false;
		if (!entry.geometry) return;
		entry.visible = new Set();
		for (const [key, m] of entry.instances) if (this.isVisible(entry, key, m)) entry.visible.add(key);
		entry.drawnKeys = [...entry.visible];
		entry.slots = new Map(entry.drawnKeys.map((key, i) => [key, i]));
		const matrices = entry.drawnKeys.map((key) => entry.instances.get(key)!);
		// People and creatures are small however big their model's bounds.
		const role: ShadowRole = entry.kind === 'wmo' || (entry.kind !== 'creature' && entry.radius >= SMALL_CASTER) ? 'cast' : 'near';
		entry.mesh = this.syncMesh(entry.mesh, entry.geometry, entry.materials, matrices, entry.kind === 'wmo' ? -1 : 0, role);
		if (entry.depthMaterial) entry.mesh.customDepthMaterial = entry.depthMaterial;
		if (entry.animation) this.writePhases(entry.mesh, entry.geometry, entry.drawnKeys, entry.animation.duration);
		for (const liquid of entry.liquids) {
			// Liquids draw after the building so it shows through the surface.
			liquid.mesh = this.syncMesh(liquid.mesh, liquid.geometry, liquid.material, matrices, 1, 'receive');
			liquid.mesh.userData.liquidType = liquid.type;
		}
	}

	/** Creates or grows an InstancedMesh as needed and writes the instance matrices into it. */
	private syncMesh(
		mesh: THREE.InstancedMesh | null,
		geometry: THREE.BufferGeometry,
		material: THREE.Material | THREE.Material[],
		matrices: THREE.Matrix4[],
		renderOrder: number,
		shadow: ShadowRole,
	): THREE.InstancedMesh {
		const count = matrices.length;
		if (!mesh || mesh.instanceMatrix.count < count) {
			if (mesh) {
				this.group.remove(mesh);
				mesh.dispose();
			}
			const capacity = Math.max(4, 2 ** Math.ceil(Math.log2(Math.max(1, count))));
			mesh = new THREE.InstancedMesh(geometry, material, capacity);
			mesh.matrixAutoUpdate = false;
			mesh.renderOrder = renderOrder;
			useShadows(mesh, shadow);
			this.group.add(mesh);
		}
		matrices.forEach((m, i) => mesh!.setMatrixAt(i, m));
		mesh.count = count;
		mesh.instanceMatrix.needsUpdate = true;
		mesh.visible = count > 0;
		if (count > 0) mesh.computeBoundingSphere();
		return mesh;
	}
	/**
	 * Each copy's point in its animation loop, stable per placement (hashed from its key), so
	 * a crowd of the same NPC doesn't move in lockstep.
	 */
	private writePhases(mesh: THREE.InstancedMesh, geometry: THREE.BufferGeometry, keys: string[], duration: number): void {
		const capacity = mesh.instanceMatrix.count;
		let attribute = geometry.getAttribute('instancePhase') as THREE.InstancedBufferAttribute | undefined;
		if (!attribute || attribute.count !== capacity) {
			attribute = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
			geometry.setAttribute('instancePhase', attribute);
		}
		let anim = geometry.getAttribute('instanceAnim') as THREE.InstancedBufferAttribute | undefined;
		if (!anim || anim.count !== capacity) {
			anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
			geometry.setAttribute('instanceAnim', anim);
		}
		keys.forEach((key, i) => {
			attribute!.setX(i, loopPhase(key, duration));
			// Standing or walking (see moveCreatures).
			anim!.setX(i, this.objects.get(key)?.mover?.walking ? 1 : 0);
		});
		attribute.needsUpdate = true;
		anim.needsUpdate = true;
	}

	/** Bone textures by skeleton, shared by every look (display, gear) that uses the model. */
	private readonly boneTextures = new Map<string, { texture: THREE.DataTexture; refs: number }>();

	private acquireBones(key: string, data: Float32Array, bones: number, frames: number): THREE.DataTexture {
		let entry = this.boneTextures.get(key);
		if (!entry) {
			// Three RGBA texels per bone (the rows of its 3x4 matrix), one texel row per frame.
			const texture = new THREE.DataTexture(data, bones * 3, frames, THREE.RGBAFormat, THREE.FloatType);
			texture.magFilter = texture.minFilter = THREE.NearestFilter;
			texture.needsUpdate = true;
			entry = { texture, refs: 0 };
			this.boneTextures.set(key, entry);
		}
		entry.refs++;
		return entry.texture;
	}

	private releaseBones(key: string): void {
		const entry = this.boneTextures.get(key);
		if (!entry || --entry.refs > 0) return;
		entry.texture.dispose();
		this.boneTextures.delete(key);
	}

	private dispose(entry: ModelEntry): void {
		if (entry.mesh) {
			this.group.remove(entry.mesh);
			entry.mesh.dispose();
		}
		entry.geometry?.dispose();
		for (const m of entry.materials) m.dispose();
		entry.depthMaterial?.dispose();
		for (const l of entry.liquids) {
			if (l.mesh) {
				this.group.remove(l.mesh);
				l.mesh.dispose();
			}
			// Liquid materials are shared; only the geometry belongs to this model.
			l.geometry.dispose();
		}
		this.textures.release(entry.textures);
		if (entry.animation) this.releaseBones(entry.animation.key);
	}

	/** Buildings' liquid surfaces in view (canals, pools, cave water), for telling if a point is under water. */
	liquidMeshes(out: THREE.Object3D[] = []): THREE.Object3D[] {
		for (const entry of this.models.values()) {
			for (const l of entry.liquids) if (l.mesh?.visible) out.push(l.mesh);
		}
		return out;
	}

	/**
	 * NPCs within range of the camera, with the world position just above their heads, and
	 * the live placement it comes from (walkers' change every frame; see headPosition).
	 */
	nameplates(camera: THREE.Vector3, range: number, out: { info: SpawnInfo; position: THREE.Vector3; distance: number; matrix: THREE.Matrix4; height: number }[] = []) {
		out.length = 0;
		for (const entry of this.models.values()) {
			if (entry.kind !== 'creature' || entry.state !== 'ready' || !entry.data) continue;
			const top = entry.data.height;
			for (const key of entry.visible) {
				const m = entry.instances.get(key);
				const info = m && this.objects.get(key)?.placement.spawn;
				if (!m || !info) continue;
				const e = m.elements;
				const dx = e[12] - camera.x, dy = e[13] - camera.y, dz = e[14] - camera.z;
				if (dx * dx + dy * dy + dz * dz > range * range) continue;
				const position = headPosition(m, top, new THREE.Vector3());
				out.push({ info, position, distance: position.distanceTo(camera), matrix: m, height: top });
			}
		}
		return out;
	}

	private readonly sightRay = new THREE.Raycaster();

	/** Whether a building (any model with a BVH) blocks the straight line between two points. */
	blocksSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
		const direction = to.clone().sub(from);
		const distance = direction.length();
		if (distance < 1e-3) return false;
		this.sightRay.set(from, direction.divideScalar(distance));
		// Stop just short of the target so its own surroundings (a doorway, the floor) don't count.
		this.sightRay.far = distance - 0.5;
		this.sightRay.firstHitOnly = true;
		for (const entry of this.models.values()) {
			if (!entry.mesh?.visible || !entry.geometry?.boundsTree) continue;
			if (this.sightRay.intersectObject(entry.mesh, false).length) return true;
		}
		return false;
	}

	private readonly sweepRay = new THREE.Raycaster();
	private readonly hitNormal = new THREE.Vector3();

	/** Nearest building surface along a ray (within far), with its world-space normal. */
	private castBuildings(from: THREE.Vector3, direction: THREE.Vector3, far: number): { distance: number; normal: THREE.Vector3 } | null {
		this.sweepRay.set(from, direction);
		this.sweepRay.far = far;
		this.sweepRay.firstHitOnly = true;
		let best: { distance: number; normal: THREE.Vector3 } | null = null;
		for (const entry of this.models.values()) {
			if (!entry.mesh?.visible || !entry.geometry?.boundsTree) continue;
			const hit = this.sweepRay.intersectObject(entry.mesh, false)[0];
			if (!hit?.face || (best && hit.distance >= best.distance)) continue;
			// The face normal is in model space; carry it through the instance's placement.
			const instance = new THREE.Matrix4();
			if (hit.instanceId !== undefined) entry.mesh.getMatrixAt(hit.instanceId, instance);
			this.hitNormal.copy(hit.face.normal).transformDirection(instance);
			best = { distance: hit.distance, normal: this.hitNormal.clone() };
		}
		return best;
	}

	/**
	 * Limits a camera move so it can't pass through buildings (caves, mines, walls): slides along
	 * a surface it would cross, keeping `radius` away from it. Returns the allowed move.
	 */
	sweep(from: THREE.Vector3, move: THREE.Vector3, radius: number): THREE.Vector3 {
		let allowed = move.clone();
		for (let pass = 0; pass < 3; pass++) {
			const length = allowed.length();
			if (length < 1e-5) break;
			const direction = allowed.clone().divideScalar(length);
			const hit = this.castBuildings(from, direction, length + radius);
			if (!hit) break;
			// Facing away from the move (we're behind it): not a wall for this move.
			const into = allowed.dot(hit.normal);
			if (into >= 0) break;
			if (pass < 2) {
				// Slide: drop the part of the move that goes into the surface, then check again.
				allowed.addScaledVector(hit.normal, -into);
			} else {
				// Still blocked (a corner): stop short of the surface.
				allowed = direction.multiplyScalar(Math.min(Math.max(0, hit.distance - radius), length));
			}
		}
		return allowed;
	}

	/** Whether any building's bounds come within `margin` of a point: collision is only needed then. */
	nearBuilding(at: THREE.Vector3, margin: number): boolean {
		for (const entry of this.models.values()) {
			const sphere = entry.geometry?.boundingSphere;
			if (!entry.mesh?.visible || !entry.geometry?.boundsTree || !sphere) continue;
			for (const key of entry.visible) {
				const m = entry.instances.get(key)!;
				const e = m.elements;
				const scale = Math.hypot(e[0], e[1], e[2]);
				const cx = e[0] * sphere.center.x + e[4] * sphere.center.y + e[8] * sphere.center.z + e[12];
				const cy = e[1] * sphere.center.x + e[5] * sphere.center.y + e[9] * sphere.center.z + e[13];
				const cz = e[2] * sphere.center.x + e[6] * sphere.center.y + e[10] * sphere.center.z + e[14];
				const reach = sphere.radius * scale + margin;
				if ((cx - at.x) ** 2 + (cy - at.y) ** 2 + (cz - at.z) ** 2 < reach * reach) return true;
			}
		}
		return false;
	}

	private readonly inverses = new WeakMap<THREE.Matrix4, THREE.Matrix4>();

	/**
	 * The indoor room (WMO interior group) around a point, for its WMOAreaTable name and music.
	 * Rooms are matched by bounding box; where several hold the point, the smallest wins.
	 */
	roomAt(at: THREE.Vector3): { wmoId: number; nameSet: number; groupId: number } | null {
		let best: { wmoId: number; nameSet: number; groupId: number } | null = null;
		let bestVolume = Infinity;
		const local = new THREE.Vector3();
		for (const entry of this.models.values()) {
			const areas = entry.data?.areas;
			const sphere = entry.geometry?.boundingSphere;
			if (entry.kind !== 'wmo' || !areas || !sphere) continue;
			for (const key of entry.visible) {
				const m = entry.instances.get(key)!;
				const e = m.elements;
				const scale = Math.hypot(e[0], e[1], e[2]);
				local.copy(sphere.center).applyMatrix4(m);
				if (local.distanceToSquared(at) > (sphere.radius * scale) ** 2) continue;
				let inverse = this.inverses.get(m);
				if (!inverse) {
					inverse = m.clone().invert();
					this.inverses.set(m, inverse);
				}
				local.copy(at).applyMatrix4(inverse);
				for (const g of areas.groups) {
					if (!g.interior) continue;
					if (local.x < g.min[0] || local.y < g.min[1] || local.z < g.min[2] || local.x > g.max[0] || local.y > g.max[1] || local.z > g.max[2]) continue;
					const volume = (g.max[0] - g.min[0]) * (g.max[1] - g.min[1]) * (g.max[2] - g.min[2]);
					if (volume >= bestVolume) continue;
					bestVolume = volume;
					best = { wmoId: areas.wmoId, nameSet: this.objects.get(key)?.placement.nameSet ?? 0, groupId: g.id };
				}
			}
		}
		return best;
	}

	private static readonly AXES = [
		new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0),
		new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
		new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
	];

	/**
	 * How far to move a point so no building surface is within `radius` of it along the six axes
	 * (floors, ceilings, walls). Keeps the camera's view from clipping into a surface it slid along.
	 */
	pushOut(at: THREE.Vector3, radius: number): THREE.Vector3 {
		const offset = new THREE.Vector3();
		for (const axis of ObjectManager.AXES) {
			const hit = this.castBuildings(at, axis, radius);
			if (hit && axis.dot(hit.normal) < 0) offset.addScaledVector(axis, -(radius - hit.distance));
		}
		return offset;
	}

	/**
	 * Every placed NPC and game object (and with props the map's own models within propRange of
	 * the camera, with buildings its buildings) whose place passes a test, for box selection.
	 */
	placedWhere(test: (matrix: THREE.Matrix4) => boolean, props: boolean, buildings: boolean, propRange: number, camera: THREE.Vector3): { placement: Placement; wdt: number }[] {
		const out: { placement: Placement; wdt: number }[] = [];
		const range = propRange * propRange;
		for (const [key, object] of this.objects) {
			const kind = object.placement.kind;
			if (kind === 'creature' || kind === 'object') {
				if (!object.placement.spawn) continue;
			} else if (kind === 'm2') {
				if (!props) continue;
				const e = object.matrix.elements;
				if ((e[12] - camera.x) ** 2 + (e[13] - camera.y) ** 2 + (e[14] - camera.z) ** 2 > range) continue;
			} else if (kind !== 'wmo' || !buildings) continue;
			if (!test(object.matrix)) continue;
			out.push({ placement: object.placement, wdt: Number(key.replace(/^edit:/, '').split(':')[0]) });
		}
		return out;
	}

	/** How far along a ray it first meets a building (WMO), or null. */
	raycastBuildings(from: THREE.Vector3, direction: THREE.Vector3, far: number): number | null {
		return this.castBuildings(from, direction, far)?.distance ?? null;
	}

	/** The creature or game object spawn nearest along a ray, if any. */
	pick(raycaster: THREE.Raycaster): { info: SpawnInfo; distance: number } | null {
		const hit = this.pickPlaced(raycaster);
		return hit?.placement.spawn ? { info: hit.placement.spawn, distance: hit.distance } : null;
	}

	/**
	 * The placed thing nearest along a ray: NPCs and game objects, and with props the map's own
	 * models (closer than propRange), with buildings its buildings too. A building's furniture
	 * isn't placed on its own, so it can't be picked. skip: keys (wdt:kind:uid) to see through.
	 */
	pickPlaced(raycaster: THREE.Raycaster, props = false, buildings = false, propRange = Infinity, skip?: Set<string>): { placement: Placement; wdt: number; distance: number } | null {
		let best: { placement: Placement; wdt: number; distance: number } | null = null;
		const far = raycaster.far;
		for (const entry of this.models.values()) {
			if (!entry.mesh?.visible) continue;
			const spawn = entry.kind === 'creature' || entry.kind === 'object';
			if (!spawn && !(entry.kind === 'm2' ? props : buildings)) continue;
			raycaster.far = spawn ? far : Math.min(far, propRange);
			for (const hit of raycaster.intersectObject(entry.mesh, false)) {
				if (hit.instanceId === undefined || (best && hit.distance >= best.distance)) break;
				const key = entry.drawnKeys[hit.instanceId];
				const object = this.objects.get(key);
				if (!object || (spawn && !object.placement.spawn)) continue;
				// Keys are wdt:kind:uid, or edit:wdt:kind:uid.
				if (skip?.has(key.replace(/^edit:/, ''))) continue;
				best = { placement: object.placement, wdt: Number(key.replace(/^edit:/, '').split(':')[0]), distance: hit.distance };
				break; // hits are sorted; the first placed one is this model's nearest
			}
		}
		raycaster.far = far;
		return best;
	}

	stats(): ObjectStats {
		let instances = 0;
		let drawn = 0;
		let models = 0;
		for (const e of this.models.values()) {
			if (e.state === 'ready') models++;
			instances += e.instances.size;
			drawn += e.visible.size;
		}
		return { models, instances, drawn, loading: this.queue.length + this.requests * MODEL_BATCH };
	}
}

function liquidGeometry(positions: Float32Array, indices: Uint32Array): THREE.BufferGeometry {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	// Model space is z-up.
	const normals = new Float32Array(positions.length);
	for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
	geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
	geometry.setIndex(new THREE.BufferAttribute(indices, 1));
	geometry.computeBoundingSphere();
	return geometry;
}
