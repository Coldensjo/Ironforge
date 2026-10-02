import type { ProductInfo } from '../casc/config';
import type { StorageStats } from '../casc/storage';
import type { AreaInfo, LightingData } from '../explorer/lighting';
import type { KnownMap, MapSummary, TileDetails } from '../explorer/maps';
import type { LiquidLooks, LockKind } from '../explorer/clientDb';
import type { MusicData, WmoArea } from '../explorer/music';
import type { Place } from '../explorer/places';
import type { ModelData, ObjectKind, Placement } from '../explorer/objects';
import type { FarTile, InstanceMap, LoadedTexture, MapListing, NearTile, TemplateListing, TileTexture } from '../explorer/world';
import type { MapPatch, ModelEdit } from '../explorer/mapExport';
import type { SpawnInfo } from '../explorer/spawns';
import type { Image } from '../formats/blp';

export type SourceInit =
	| { kind: 'handle'; handle: FileSystemDirectoryHandle }
	| { kind: 'files'; files: { path: string; file: File }[] }
	/** The install the portable launcher or dev server found, served at this URL (ending in '/'). */
	| { kind: 'http'; base: string };

/** Methods the storage worker exposes; every call is async across the worker boundary. */
export interface StorageApi {
	/** Where the page is served from, for files beside it (the worker's own URL is under assets/). */
	setPageUrl(url: string): void;
	setSource(source: SourceInit): ProductInfo[];
	open(product: string): StorageStats;
	loadMap(wdtFdid: number): MapSummary;
	/** The continents, with their WDT's and WDL's numbers in the storage open. */
	knownMaps(): KnownMap[];
	loadTile(wdtFdid: number, x: number, y: number): TileDetails;
	minimapThumbnails(wdtFdid: number, coords: [number, number][], size: number): { x: number; y: number; image: Image | null }[];
	loadFarTiles(wdtFdid: number, wdlFdid: number): FarTile[];
	loadInstance(mapId: number): InstanceMap | null;
	listMaps(): MapListing[];
	loadTileTextures(wdtFdid: number, coords: [number, number][], maxSize: number, compressed: boolean): TileTexture[];
	loadNearTile(wdtFdid: number, x: number, y: number, compressed: boolean): NearTile;
	loadTextures(fdids: number[], compressed: boolean): LoadedTexture[];
	loadTileObjects(wdtFdid: number, x: number, y: number): Placement[];
	loadModels(models: { fdid: number; kind: ObjectKind; variant?: string }[]): (ModelData | null)[];
	loadLighting(mapIds: number[]): LightingData;
	loadAreas(): AreaInfo[];
	loadMusic(): MusicData;
	loadLiquidLooks(): LiquidLooks;
	loadLockKinds(): Record<number, LockKind>;
	loadPlaces(): Place[];
	wmoArea(wmoId: number, nameSet: number, groupId: number): WmoArea | null;
	loadSound(fdid: number): Uint8Array;
	loadFont(fdid: number): Uint8Array;
	/** Interface textures decoded to RGBA (null where missing). */
	loadImages(fdids: number[]): (Image | null)[];
	/** Every creature and game object template, for placing new ones. */
	listTemplates(): TemplateListing;
	/** A new spawn of a template on a map (positioned at the origin). */
	templateSpawn(type: 'npc' | 'object', entry: number, mapId: number, guid: number): SpawnInfo | null;
	/** The editor's map changes (map model edits, ground height changes by map:x_y) as a client patch. */
	exportMapPatch(models: ModelEdit[], terrain: Record<string, Float32Array>): MapPatch;
}

export type AsyncStorageApi = {
	[K in keyof StorageApi]: (...args: Parameters<StorageApi[K]>) => Promise<ReturnType<StorageApi[K]>>;
};

export type Request = { id: number; method: keyof StorageApi; args: unknown[] };

export type Response =
	| { id: number; result: unknown }
	| { id: number; error: string }
	| { id: -1; progress: string };
