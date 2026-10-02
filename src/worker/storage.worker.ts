import { FileListSource, DirectoryHandleSource, HttpSource, type FileSource } from '../casc/source';
import { CascStorage } from '../casc/storage';
import { describeError, MapExplorer } from '../explorer/maps';
import { setPageUrl } from '../explorer/spawns';
import { WorldLoader } from '../explorer/world';
import { isVanillaClient, openVanilla, VANILLA_PRODUCT, vanillaProduct } from '../mpq/client';
import type { AsyncStorageApi, Request, Response, SourceInit } from './protocol';

let source: FileSource | null = null;
let explorer: MapExplorer | null = null;
let world: WorldLoader | null = null;

function requireExplorer(): MapExplorer {
	if (!explorer) throw new Error('Storage is not open');
	return explorer;
}

function requireWorld(): WorldLoader {
	world ??= new WorldLoader(requireExplorer());
	return world;
}

function send(message: Response, transfer: Transferable[] = []): void {
	postMessage(message, { transfer });
}

const api: AsyncStorageApi = {
	async setPageUrl(url) {
		setPageUrl(url);
	},
	async setSource(init: SourceInit) {
		source = init.kind === 'handle' ? new DirectoryHandleSource(init.handle) : init.kind === 'http' ? new HttpSource(init.base) : new FileListSource(init.files);
		explorer = null;
		world = null;
		// The original (1.12) client has no .build.info, just MPQs in Data.
		if (await isVanillaClient(source)) return [vanillaProduct];
		return CascStorage.listProducts(source);
	},
	async open(product) {
		if (!source) throw new Error('No folder selected');
		if (product === VANILLA_PRODUCT) {
			send({ id: -1, progress: 'Reading the archives' });
			const storage = await openVanilla(source);
			explorer = new MapExplorer(storage);
			world = null;
			return { product, version: '1.12', buildName: 'World of Warcraft 1.12', indexEntries: 0, encodingPages: 0, rootFiles: 0, rootNamedFiles: 0, timings: {} };
		}
		const storage = await CascStorage.open(source, product, (progress) => send({ id: -1, progress }));
		explorer = new MapExplorer(storage);
		world = null;
		return storage.stats;
	},
	async knownMaps() {
		return requireExplorer().knownMaps();
	},
	async loadMap(wdtFdid) {
		return requireExplorer().loadMap(wdtFdid);
	},
	async loadTile(wdtFdid, x, y) {
		return requireExplorer().loadTile(wdtFdid, x, y);
	},
	async minimapThumbnails(wdtFdid, coords, size) {
		return requireExplorer().minimapThumbnails(wdtFdid, coords, size);
	},
	async loadFarTiles(wdtFdid, wdlFdid) {
		return requireWorld().loadFarTiles(wdtFdid, wdlFdid);
	},
	async loadTileTextures(wdtFdid, coords, maxSize, compressed) {
		return requireWorld().loadTileTextures(wdtFdid, coords, maxSize, compressed);
	},
	async loadNearTile(wdtFdid, x, y, compressed) {
		return requireWorld().loadNearTile(wdtFdid, x, y, compressed);
	},
	async loadTextures(fdids, compressed) {
		return requireWorld().loadTextures(fdids, compressed);
	},
	async loadTileObjects(wdtFdid, x, y) {
		return requireWorld().loadTileObjects(wdtFdid, x, y);
	},
	async loadModels(models) {
		return requireWorld().loadModels(models);
	},
	async loadLighting(mapIds) {
		return requireWorld().loadLighting(mapIds);
	},
	async loadAreas() {
		return requireWorld().loadAreas();
	},
	async loadInstance(mapId) {
		return requireWorld().loadInstance(mapId);
	},
	async listMaps() {
		return requireWorld().listMaps();
	},
	async loadLiquidLooks() {
		return requireWorld().loadLiquidLooks();
	},
	async loadLockKinds() {
		return requireWorld().loadLockKinds();
	},
	async loadPlaces() {
		return requireWorld().loadPlaces();
	},
	async loadMusic() {
		return requireWorld().loadMusic();
	},
	async wmoArea(wmoId, nameSet, groupId) {
		return requireWorld().wmoArea(wmoId, nameSet, groupId);
	},
	async loadFont(fdid) {
		return requireWorld().loadFont(fdid);
	},
	async loadSound(fdid) {
		return requireWorld().loadSound(fdid);
	},
	async loadImages(fdids) {
		return requireWorld().loadImages(fdids);
	},
	async listTemplates() {
		return requireWorld().listTemplates();
	},
	async templateSpawn(type, entry, mapId, guid) {
		return requireWorld().templateSpawn(type, entry, mapId, guid);
	},
	async exportMapPatch(models, terrain) {
		return requireWorld().exportMapPatch(models, terrain);
	},
};

/** Collects typed-array buffers in a result so they move to the main thread instead of being copied. */
function transferables(value: unknown, out: Set<ArrayBuffer> = new Set(), depth = 0): Set<ArrayBuffer> {
	if (depth > 8 || value === null || typeof value !== 'object') return out;
	if (value instanceof ArrayBuffer) {
		out.add(value);
		return out;
	}
	if (ArrayBuffer.isView(value)) {
		if (value.buffer instanceof ArrayBuffer && value.byteLength === value.buffer.byteLength) out.add(value.buffer);
		return out;
	}
	for (const v of Array.isArray(value) ? value : Object.values(value)) transferables(v, out, depth + 1);
	return out;
}

onmessage = async (event: MessageEvent<Request>) => {
	const { id, method, args } = event.data;
	try {
		const result = await (api[method] as (...a: unknown[]) => Promise<unknown>)(...args);
		send({ id, result }, [...transferables(result)]);
	} catch (e) {
		console.error(e);
		send({ id, error: describeError(e) });
	}
};
