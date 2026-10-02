import { parseAdtRoot, TILE_CELLS, TILE_SIZE, tileGrids } from '../formats/adt';
import { parseAdtTex } from '../formats/adtTex';
import { blpTexture, decodeBlp, type Image, type TextureData } from '../formats/blp';
import type { LiquidKind } from '../formats/mh2o';
import { parseWdl, WDL_CELLS } from '../formats/wdl';
import { DB2_FILES, liquidKinds, liquidLooks, loadTable, lockKinds, type LiquidLooks, type LockKind } from './clientDb';
import { loadAreas, loadLighting, type AreaInfo, type LightingData } from './lighting';
import { buildLiquidMeshes, type LiquidMesh } from './liquidMesh';
import { MusicTables, type MusicData, type WmoArea } from './music';
import type { MapExplorer } from './maps';
import { loadPlaces, type Place } from './places';
import { KNOWN_MAPS } from './maps';
import { globalWmoPlacement, globalWmoTiles, loadM2, loadWmo, parsePlacements, type ModelData, type ObjectKind, type Placement } from './objects';
import { GroundEffects, type ClutterSource } from './groundEffects';
import { PortalSource } from './portals';
import {
	creatureSpawn, creatureTypeName, DisplayResolver, objectSpawn, objectTypeName, parsePose, parseWeapons, spawnFile, SpawnSource,
	type SpawnFile, type SpawnInfo, type SpawnLookups,
} from './spawns';

/** public/spawns/templates.json (see tools/buildSpawns.ts). */
interface TemplateFile {
	creatures: SpawnFile['creatures']['templates'];
	objects: SpawnFile['objects']['templates'];
}

/** Templates to choose from when placing: [entry, name, what it is]. */
export interface TemplateListing {
	/** [entry, name, what it is, creature type name] */
	npcs: [number, string, string, string][];
	objects: [number, string, string][];
}
import { buildSplatTerrain, type SplatTerrain } from './splatMesh';
import {
	isSandbox, SANDBOX_MAP_ID, sandboxFarTile, sandboxHasTile, sandboxRoot, sandboxTex, sandboxTileTexture, sandboxTiles,
} from './sandbox';
import { buildTerrainMesh, type TerrainGeometry } from './terrainMesh';

/** MPHD flags that switch alpha maps from 4-bit to 8-bit. */
const MPHD_BIG_ALPHA = 0x4 | 0x80;
/** MCNK flag: 4-bit alpha maps are already 64x64 and need no fix-up. */
const MCNK_DO_NOT_FIX_ALPHA = 0x8000;

/** A map entered through an area trigger (a dungeon, mostly): what to lay out in the world. */
export interface InstanceMap {
	mapId: number;
	name: string;
	wdt: number;
	/** Terrain tiles (from the WDL), for maps built from ADTs. */
	farTiles: FarTile[];
	/** Terrain tiles of maps without a WDL (newer ones): no distant view, only full detail up close. */
	terrainTiles: [number, number][];
	/** Tiles a WMO-only map's building covers, for streaming its objects and spawns. */
	wmoTiles: [number, number][];
	/** A WMO-only map's building bounds, relative to the map's centre in placement space (x, height, z). */
	wmoBounds: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** Map.db2 instance types. */
export type MapCategory = 'continent' | 'dungeon' | 'raid' | 'battleground' | 'other';

/** A map the install has files for. */
export interface MapListing {
	id: number;
	name: string;
	category: MapCategory;
}

/** Map.db2 fields. */
const MAP_NAME = 1;
const MAP_INSTANCE_TYPE = 8;
const MAP_WDT = 21;
const CATEGORIES: MapCategory[] = ['other', 'dungeon', 'raid', 'battleground'];

export interface FarTile {
	x: number;
	y: number;
	/** False for WDL-only tiles (open sea floor) that have no ADT or textures. */
	hasAdt: boolean;
	geometry: TerrainGeometry;
	/** 17x17 outer heights, for height queries. */
	heights: Float32Array;
}

export interface NearTile {
	x: number;
	y: number;
	/** Texture-layered terrain, or null if the tile's _tex0 file couldn't be read. */
	terrain: SplatTerrain | null;
	/** Plain mesh with the baked map texture, used when terrain is null. */
	fallback: { geometry: TerrainGeometry; texture: TextureData | null } | null;
	/** 129x129 outer heights, for height queries. */
	heights: Float32Array;
	/** 128x128 cells, 1 where the terrain has a hole (cave and mine entrances). */
	holes: Uint8Array;
	liquids: LiquidMesh[];
	/** 1 per chunk (y * 16 + x) the sea covers: where the tile has an ocean surface. */
	sea: Uint8Array;
	/** AreaTable ID per chunk (y * 16 + x). */
	areaIds: Uint32Array;
	/** What grows on the ground (grass, flowers, pebbles), or null for none. */
	clutter: ClutterSource | null;
	/** Which way the rivers flow (see WdtTile.flowMap), or null where the tile has none. */
	flow: TextureData | null;
}

export interface LoadedTexture {
	fdid: number;
	texture: TextureData | null;
}

export interface TileTexture {
	x: number;
	y: number;
	texture: TextureData | null;
}

/** Builds renderable terrain for the viewer, on top of the map explorer's WDT cache. */
export class WorldLoader {
	constructor(private readonly maps: MapExplorer) {}

	private get storage() {
		return this.maps.storage;
	}

	private mapIds: Promise<Map<number, number>> | null = null;

	/** The Map.db2 ID of a map's WDT, or null for a WDT no map uses. */
	private async mapIdOf(wdtFdid: number): Promise<number | null> {
		if (isSandbox(wdtFdid)) return SANDBOX_MAP_ID;
		const known = KNOWN_MAPS.find((m) => m.wdt === wdtFdid);
		if (known) return known.mapId;
		this.mapIds ??= loadTable(this.storage, DB2_FILES.Map).then((table) => {
			const byWdt = new Map<number, number>();
			for (const id of table.ids()) byWdt.set(table.getInt(id, MAP_WDT) ?? 0, id);
			return byWdt;
		});
		return (await this.mapIds).get(wdtFdid) ?? null;
	}

	/**
	 * A map other than the continents (a dungeon), by Map.db2 ID: its name and layout. Maps built
	 * from ADTs have a WDL next to their WDT; WMO-only maps are one building.
	 */
	async loadInstance(mapId: number): Promise<InstanceMap | null> {
		const table = await loadTable(this.storage, DB2_FILES.Map);
		const wdtFdid = table.getInt(mapId, MAP_WDT) ?? 0;
		if (!wdtFdid || this.storage.status(wdtFdid) !== 'ok') return null;
		const wdt = await this.maps.wdt(wdtFdid);
		const name = table.getString(mapId, MAP_NAME) ?? `Map ${mapId}`;
		const tiles = wdt.tiles.filter((t) => t !== null);
		// Older maps keep their WDL right before the WDT; newer ones' can't be found (unnamed).
		let farTiles: FarTile[] = [];
		if (tiles.length && this.storage.status(wdtFdid - 1) === 'ok') {
			try {
				const far = await this.loadFarTiles(wdtFdid, wdtFdid - 1);
				if (tiles.every((t) => far.some((f) => f.x === t.x && f.y === t.y))) farTiles = far;
			} catch {
				// Not a WDL after all.
			}
		}
		const terrainTiles: [number, number][] = farTiles.length ? [] : tiles.map((t) => [t.x, t.y]);
		const g = wdt.globalWmo;
		return {
			mapId, name, wdt: wdtFdid, farTiles, terrainTiles,
			wmoTiles: g ? globalWmoTiles(g) : [],
			wmoBounds: g ? { min: [g.position[0] + g.min[0], g.min[1], g.position[2] + g.min[2]], max: [g.position[0] + g.max[0], g.max[1], g.position[2] + g.max[2]] } : null,
		};
	}

	/** Every map the install has files for, by Map.db2 instance type. */
	async listMaps(): Promise<MapListing[]> {
		const table = await loadTable(this.storage, DB2_FILES.Map);
		const out: MapListing[] = [];
		for (const id of table.ids()) {
			const wdt = table.getInt(id, MAP_WDT) ?? 0;
			if (!wdt || this.storage.status(wdt) !== 'ok') continue;
			const known = KNOWN_MAPS.find((m) => m.mapId === id);
			out.push({
				id,
				name: known?.name ?? table.getString(id, MAP_NAME) ?? `Map ${id}`,
				category: known ? 'continent' : CATEGORIES[table.getInt(id, MAP_INSTANCE_TYPE) ?? 0] ?? 'other',
			});
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	async loadFarTiles(wdtFdid: number, wdlFdid: number): Promise<FarTile[]> {
		if (isSandbox(wdtFdid)) return sandboxTiles().map(([x, y]) => sandboxFarTile(x, y));
		const wdt = await this.maps.wdt(wdtFdid);
		const wdl = parseWdl(await this.storage.readFile(wdlFdid));
		return wdl.map((t) => ({
			x: t.x,
			y: t.y,
			hasAdt: wdt.tiles[t.y * 64 + t.x] !== null,
			geometry: buildTerrainMesh(t.outer, t.inner, WDL_CELLS, TILE_SIZE, null, 60),
			heights: t.outer,
		}));
	}

	/** Baked map textures, starting at the largest mip no bigger than maxSize. */
	async loadTileTextures(wdtFdid: number, coords: [number, number][], maxSize: number, compressed: boolean): Promise<TileTexture[]> {
		if (isSandbox(wdtFdid)) return coords.map(([x, y]) => ({ x, y, texture: sandboxTileTexture() }));
		const wdt = await this.maps.wdt(wdtFdid);
		return Promise.all(coords.map(async ([x, y]) => ({
			x,
			y,
			texture: await this.readTexture(wdt.tiles[y * 64 + x]?.files.mapTexture ?? 0, maxSize, compressed),
		})));
	}

	async loadNearTile(wdtFdid: number, x: number, y: number, compressed: boolean): Promise<NearTile> {
		if (isSandbox(wdtFdid)) return this.sandboxNearTile(x, y);
		const wdt = await this.maps.wdt(wdtFdid);
		const tile = wdt.tiles[y * 64 + x];
		if (!tile) throw new Error(`Map has no tile ${x}_${y}`);
		const [rootBytes, texBytes, kindOf, groundEffects] = await Promise.all([
			this.storage.readFile(tile.files.root),
			tile.files.tex0 ? this.storage.readFile(tile.files.tex0).catch(() => null) : null,
			this.liquidKind(),
			this.groundEffects(),
		]);
		const root = parseAdtRoot(rootBytes);
		const liquids = buildLiquidMeshes(root.liquids, kindOf);
		const flow = liquids.length && tile.flowMap ? await this.readTexture(tile.flowMap, Infinity, false) : null;
		const sea = new Uint8Array(256);
		for (const l of root.liquids) {
			if (kindOf(l.type) === 'ocean' && l.width && l.height && (!l.exists || l.exists.includes(1))) sea[l.chunk] = 1;
		}
		const areaIds = new Uint32Array(256);
		for (const c of root.chunks) areaIds[c.indexY * 16 + c.indexX] = c.areaId;

		if (texBytes) {
			const tex = parseAdtTex(texBytes, (wdt.flags & MPHD_BIG_ALPHA) !== 0, (i) => !(root.chunks[i]?.flags & MCNK_DO_NOT_FIX_ALPHA));
			const terrain = buildSplatTerrain(root, tex);
			const clutter = groundEffects?.source(root, tex, terrain.heights, tileGrids(root).inner, terrain.holes) ?? null;
			return { x, y, terrain, fallback: null, heights: terrain.heights, holes: terrain.holes, liquids, sea, areaIds, clutter, flow };
		}
		const grids = tileGrids(root);
		return {
			x,
			y,
			terrain: null,
			fallback: {
				geometry: buildTerrainMesh(grids.outer, grids.inner, TILE_CELLS, TILE_SIZE, grids.holes, 30),
				texture: await this.readTexture(tile.files.mapTexture, Infinity, compressed),
			},
			heights: grids.outer,
			holes: grids.holes,
			liquids,
			sea,
			areaIds,
			clutter: null,
			flow,
		};
	}

	/** A tile of the sandbox's field, built as a read ADT would be (with the grass that grows on it). */
	private async sandboxNearTile(x: number, y: number): Promise<NearTile> {
		if (!sandboxHasTile(x, y)) throw new Error(`The sandbox has no tile ${x}_${y}`);
		const root = sandboxRoot(x, y);
		const tex = sandboxTex();
		const terrain = buildSplatTerrain(root, tex);
		const groundEffects = await this.groundEffects();
		const clutter = groundEffects?.source(root, tex, terrain.heights, tileGrids(root).inner, terrain.holes) ?? null;
		return {
			x, y, terrain, fallback: null, heights: terrain.heights, holes: terrain.holes, liquids: [],
			sea: new Uint8Array(256), areaIds: new Uint32Array(256), clutter, flow: null,
		};
	}

	/** M2 and WMO placements on a tile, from its _obj0 file. */
	async loadTileObjects(wdtFdid: number, x: number, y: number): Promise<Placement[]> {
		// The sandbox starts empty: what's on it is what's placed in the editor.
		if (isSandbox(wdtFdid)) return [];
		const wdt = await this.maps.wdt(wdtFdid);
		const tile = wdt.tiles[y * 64 + x];
		const [placements, spawns, portals] = await Promise.all([
			tile?.files.obj0 ? this.storage.readFile(tile.files.obj0).then(parsePlacements) : ([] as Placement[]),
			this.tileSpawns(wdtFdid, x, y),
			this.tilePortals(wdtFdid, x, y),
		]);
		// A WMO-only map's building is listed by every tile it covers (placed once, by its key).
		const global = wdt.globalWmo;
		if (global && globalWmoTiles(global).some(([tx, ty]) => tx === x && ty === y)) placements.push(globalWmoPlacement(global));
		// Spawn placements are cached per tile; send copies of their matrices, since the
		// transfer to the main thread empties the originals.
		return placements.concat(spawns.map((p) => ({ ...p, matrix: p.matrix.slice() })), portals);
	}

	private portalSource: Promise<PortalSource> | null = null;

	/** Instance portals added at dungeon doors the map files leave without one. */
	private async tilePortals(wdtFdid: number, x: number, y: number): Promise<Placement[]> {
		const mapId = await this.mapIdOf(wdtFdid);
		if (mapId === null) return [];
		this.portalSource ??= PortalSource.load();
		return (await this.portalSource).placements(mapId, x, y);
	}

	private readonly spawnSources = new Map<number, Promise<SpawnSource | null>>();
	private displayResolver: DisplayResolver | null = null;

	/** Created on first use, so its tables only load once spawns are shown. */
	private get displays(): DisplayResolver {
		this.displayResolver ??= new DisplayResolver(this.storage);
		return this.displayResolver;
	}

	private lookups: Promise<SpawnLookups> | null = null;

	/** Display scales and faction reactions, from the client's tables. */
	private spawnLookups(): Promise<SpawnLookups> {
		this.lookups ??= Promise.all([this.displays.scaleLookup(), this.displays.reactionLookup()]).then(([scaleOf, reactionOf]) => ({ scaleOf, reactionOf }));
		this.lookups.catch(() => (this.lookups = null));
		return this.lookups;
	}

	private templates: Promise<TemplateFile | null> | null = null;

	/** public/spawns/templates.json: every creature and game object template, read on first use. */
	private templateFile(): Promise<TemplateFile | null> {
		this.templates ??= fetch(spawnFile('templates.json')).then((r) => (r.ok ? (r.json() as Promise<TemplateFile>) : null), () => null);
		return this.templates;
	}

	/** Every template, for finding one to place: [entry, name, what it is] for NPCs and for objects. */
	async listTemplates(): Promise<TemplateListing> {
		const file = await this.templateFile();
		if (!file) return { npcs: [], objects: [] };
		const npcs: TemplateListing['npcs'] = Object.entries(file.creatures).map(([entry, t]) => {
			const level = t[2] === t[3] ? `${t[2]}` : `${t[2]}-${t[3]}`;
			return [Number(entry), t[0], [t[1] && `<${t[1]}>`, `level ${level}`].filter(Boolean).join(' · '), creatureTypeName(t[4]) ?? ''];
		});
		const objects: TemplateListing['objects'] = Object.entries(file.objects).map(([entry, t]) => [Number(entry), t[0], objectTypeName(t[1]) ?? 'Object']);
		return { npcs, objects };
	}

	/** A new spawn of a template on a map, at the origin (the editor puts it down); null if unknown. */
	async templateSpawn(type: 'npc' | 'object', entry: number, mapId: number, guid: number): Promise<SpawnInfo | null> {
		const file = await this.templateFile();
		if (type === 'npc') {
			const t = file?.creatures[entry];
			return t ? creatureSpawn(mapId, guid, entry, t, 0, 0, 0, 0, await this.spawnLookups()) : null;
		}
		const t = file?.objects[entry];
		return t ? objectSpawn(mapId, guid, entry, t, 0, 0, 0, 0) : null;
	}

	/** Creatures and game objects on a tile, from public/spawns (empty if that data is absent). */
	private async tileSpawns(wdtFdid: number, x: number, y: number): Promise<Placement[]> {
		const mapId = await this.mapIdOf(wdtFdid);
		if (mapId === null) return [];
		let source = this.spawnSources.get(mapId);
		if (!source) {
			source = SpawnSource.load(mapId);
			this.spawnSources.set(mapId, source);
		}
		const spawns = await source;
		if (!spawns) return [];
		try {
			return spawns.placements(x, y, await this.spawnLookups());
		} catch (e) {
			console.warn('Display tables unavailable; skipping spawns', e);
			return [];
		}
	}

	/** Renderable geometry for models; null where a model can't be read. */
	async loadModels(models: { fdid: number; kind: ObjectKind; variant?: string }[]): Promise<(ModelData | null)[]> {
		return Promise.all(models.map(async ({ fdid, kind, variant }) => {
			try {
				if (kind === 'wmo') return await loadWmo(this.storage, fdid, await this.liquidKind());
				if (kind === 'creature') {
					const creature = await this.displays.creature(fdid, parseWeapons(variant));
					return creature ? { ...(await loadM2(this.storage, creature.fdid, { ...creature.options, pose: parsePose(variant) })), fdid } : null;
				}
				if (kind === 'object') {
					// Game objects are either M2 or WMO; the file's first chunk says which.
					const file = await this.displays.object(fdid);
					if (!file) return null;
					// Read once and handed on, rather than read (and decompressed) again by the loader.
					const bytes = await this.storage.readFile(file);
					const isWmo = bytes[0] === 0x52 && bytes[1] === 0x45 && bytes[2] === 0x56 && bytes[3] === 0x4d; // 'REVM'
					const model = isWmo ? await loadWmo(this.storage, file, await this.liquidKind(), bytes) : await loadM2(this.storage, file, {}, bytes);
					return { ...model, fdid };
				}
				return await loadM2(this.storage, fdid);
			} catch (e) {
				console.warn(`Model ${fdid}:`, e);
				return null;
			}
		}));
	}

	async loadLighting(mapIds: number[]): Promise<LightingData> {
		if (!mapIds.includes(SANDBOX_MAP_ID)) return loadLighting(this.storage, mapIds);
		// The sandbox has no lights of its own: it takes the Eastern Kingdoms' sky (its global light).
		const data = await loadLighting(this.storage, [...mapIds, 0]);
		const global = data.zones.find((z) => z.mapId === 0 && z.inner === 0 && z.outer === 0) ?? data.zones.find((z) => z.mapId === 0);
		if (global) data.zones.push({ ...global, mapId: SANDBOX_MAP_ID, x: 0, y: 0, z: 0, inner: 0, outer: 0 });
		return data;
	}

	loadAreas(): Promise<AreaInfo[]> {
		return loadAreas(this.storage);
	}

	private musicTables: MusicTables | null = null;

	private get music(): MusicTables {
		this.musicTables ??= new MusicTables(this.storage);
		return this.musicTables;
	}

	loadLiquidLooks(): Promise<LiquidLooks> {
		return liquidLooks(this.storage);
	}

	loadPlaces(): Promise<Place[]> {
		return loadPlaces(this.storage);
	}

	loadLockKinds(): Promise<Record<number, LockKind>> {
		return lockKinds(this.storage);
	}

	loadMusic(): Promise<MusicData> {
		return this.music.load();
	}

	wmoArea(wmoId: number, nameSet: number, groupId: number): Promise<WmoArea | null> {
		return this.music.wmoArea(wmoId, nameSet, groupId);
	}

	/** A sound file's bytes (the music tracks are MP3s). */
	/** A font file from the game (Fonts\*.ttf), as it is. */
	/** Interface textures (frames, buttons, icons, cursors) decoded to RGBA; null where missing. */
	async loadImages(fdids: number[]): Promise<(Image | null)[]> {
		return Promise.all(fdids.map(async (fdid) => {
			if (this.storage.status(fdid) !== 'ok') return null;
			try {
				return decodeBlp(await this.storage.readFile(fdid));
			} catch {
				return null;
			}
		}));
	}

	async loadFont(fdid: number): Promise<Uint8Array> {
		return (await this.storage.readFile(fdid)).slice();
	}

	async loadSound(fdid: number): Promise<Uint8Array> {
		// A copy: the result is transferred to the main thread, and the storage may cache what it read.
		return (await this.storage.readFile(fdid)).slice();
	}

	/** Terrain layer textures at full resolution. */
	async loadTextures(fdids: number[], compressed: boolean): Promise<LoadedTexture[]> {
		return Promise.all(fdids.map(async (fdid) => ({ fdid, texture: await this.readTexture(fdid, Infinity, compressed) })));
	}

	private groundEffectsPromise: Promise<GroundEffects | null> | null = null;

	/** Ground clutter tables; null (no clutter) if they can't be read. */
	private groundEffects(): Promise<GroundEffects | null> {
		this.groundEffectsPromise ??= GroundEffects.load(this.storage).catch((e) => {
			console.warn('Ground clutter tables unavailable:', e);
			return null;
		});
		return this.groundEffectsPromise;
	}

	private liquidKindPromise: Promise<(type: number) => LiquidKind> | null = null;

	private liquidKind(): Promise<(type: number) => LiquidKind> {
		this.liquidKindPromise ??= liquidKinds(this.storage);
		return this.liquidKindPromise;
	}
	private async readTexture(fdid: number, maxSize: number, compressed: boolean): Promise<TextureData | null> {
		if (fdid === 0 || this.storage.status(fdid) !== 'ok') return null;
		try {
			return blpTexture(await this.storage.readFile(fdid), maxSize, compressed);
		} catch {
			return null;
		}
	}
}
