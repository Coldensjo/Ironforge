import { TILE_SIZE } from '../formats/adt';
import { listedIds, rewriteVanillaAdt, type AdtModel } from '../formats/adtWriter';
import { adtPath } from '../formats/vanilla';
import { writeMpq } from '../mpq/writer';
import type { VanillaStorage } from '../mpq/vanillaStorage';
import type { MapExplorer } from './maps';
import type { Mat4 } from './mat4';
import { spawnPlacement, type SpawnInfo } from './spawns';

/**
 * The editor's map changes as a patch for the 1.12 client: every tile whose ground was reshaped,
 * or that lists a prop or building that was moved, added or deleted, rewritten (see adtWriter.ts)
 * and packed into one archive. Moved models leave the tiles that listed them and join the tiles
 * their bounds now reach, under the same unique ID; new ones use their editor IDs.
 */

/** A map model's edit, as EditDocument.entries gives it. */
export interface ModelEdit {
	id: string;
	edit: SpawnInfo | null;
	original: SpawnInfo | null;
}

export interface MapPatch {
	/** The archive: patch-3.MPQ for the client's Data folder. */
	archive: Uint8Array;
	/** Tiles rewritten, as map:x_y. */
	tiles: string[];
	/** Changes it couldn't make, one line each. */
	skipped: string[];
}

type Vec3 = [number, number, number];
const DEGREES = 180 / Math.PI;

/**
 * A placement matrix (continent space, which is the file's) taken apart into what the file stores:
 * position, rotation in degrees and scale. The inverse of placementMatrix: there the rotation is
 * Ry(ry - 90) Rz(-rx) Rx(rz - 90).
 */
export function filePlacement(m: Mat4): { position: Vec3; rotation: Vec3; scale: number } {
	const scale = Math.hypot(m[0], m[1], m[2]) || 1;
	const r = (row: number, col: number) => m[col * 4 + row] / scale;
	const b = Math.asin(Math.max(-1, Math.min(1, r(1, 0))));
	let a: number, c: number;
	if (Math.abs(r(1, 0)) < 0.99999) {
		a = Math.atan2(-r(2, 0), r(0, 0));
		c = Math.atan2(-r(1, 2), r(1, 1));
	} else {
		// Turned straight up or down: the first and last turns are about the same axis; put it all in the first.
		a = Math.atan2(r(0, 2), r(2, 2));
		c = 0;
	}
	return { position: [m[12], m[13], m[14]], rotation: [-b * DEGREES, a * DEGREES + 90, c * DEGREES + 90], scale };
}

/** A box (model space) through a matrix: the box around its corners. */
function transformBox(m: Mat4, min: Vec3, max: Vec3): { min: Vec3; max: Vec3 } {
	const out = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
	for (let i = 0; i < 8; i++) {
		const p = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
		for (let k = 0; k < 3; k++) {
			const v = m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2] + m[12 + k];
			out.min[k] = Math.min(out.min[k], v);
			out.max[k] = Math.max(out.max[k], v);
		}
	}
	return out;
}

/** The tiles (x, y) a box in continent space reaches. */
function tilesOf(min: Vec3, max: Vec3): [number, number][] {
	const out: [number, number][] = [];
	for (let y = Math.floor(min[2] / TILE_SIZE); y <= Math.floor(max[2] / TILE_SIZE); y++) {
		for (let x = Math.floor(min[0] / TILE_SIZE); x <= Math.floor(max[0] / TILE_SIZE); x++) if (x >= 0 && y >= 0 && x < 64 && y < 64) out.push([x, y]);
	}
	return out;
}

/** A model's bounding box in its own space: M2 header (1.12 layout) or WMO MOHD. */
async function modelBox(storage: VanillaStorage, fdid: number, kind: 'm2' | 'wmo'): Promise<{ min: Vec3; max: Vec3 }> {
	const bytes = await storage.readFile(fdid);
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const vec = (o: number): Vec3 => [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)];
	if (kind === 'm2') return { min: vec(0xb4), max: vec(0xc0) };
	for (let p = 0; p + 8 <= bytes.length;) {
		const size = v.getUint32(p + 4, true);
		// 'MOHD' reversed; its box is at +36.
		if (v.getUint32(p, true) === 0x4d4f4844) return { min: vec(p + 8 + 36), max: vec(p + 8 + 48) };
		p += 8 + size;
	}
	throw new Error('WMO without a header');
}

export async function buildMapPatch(
	storage: VanillaStorage,
	maps: MapExplorer,
	wdtOfMap: (mapId: number) => Promise<number | null>,
	models: ModelEdit[],
	terrain: Record<string, Float32Array>,
): Promise<MapPatch> {
	const skipped: string[] = [];
	/** Per tile (map:x_y): what to change there. */
	const tiles = new Map<string, { remove: Set<number>; add: AdtModel[]; heights?: Float32Array }>();
	const tile = (map: number, x: number, y: number) => {
		const key = `${map}:${x}_${y}`;
		let t = tiles.get(key);
		if (!t) tiles.set(key, (t = { remove: new Set(), add: [] }));
		return t;
	};
	for (const [key, heights] of Object.entries(terrain)) {
		const [map, xy] = key.split(':');
		const [x, y] = xy.split('_').map(Number);
		tile(Number(map), x, y).heights = heights;
	}

	const boxes = new Map<string, Promise<{ min: Vec3; max: Vec3 }>>();
	const boxOf = (fdid: number, kind: 'm2' | 'wmo') => {
		const key = `${kind}:${fdid}`;
		let box = boxes.get(key);
		if (!box) boxes.set(key, (box = modelBox(storage, fdid, kind)));
		return box;
	};
	for (const { id, edit, original } of models) {
		const [mapText, kind, guidText] = id.split(':') as [string, 'm2' | 'wmo', string];
		const map = Number(mapText);
		const uid = Number(guidText);
		const info = edit ?? original;
		const name = `${kind === 'wmo' ? 'Building' : 'Model'} ${info ? storage.pathOf(info.place.display)?.split('\\').pop() ?? info.place.display : uid}`;
		try {
			// Where it was: the tiles to take it out of (none for one added in the editor).
			const isNew = !!(edit?.created ?? original?.created);
			if (!isNew) {
				const from = original ?? edit;
				const box = from && storage.pathOf(from.place.display) ? await boxOf(from.place.display, kind) : null;
				let reach: [number, number][];
				if (original && box) {
					const placed = transformBox(spawnPlacement(original).matrix, box.min, box.max);
					reach = tilesOf(placed.min, placed.max);
				} else {
					// Where the map file put it, give or take its size; failing that, around where it is now.
					const [wx, wy] = edit?.origin ?? [info?.place.x ?? 0, info?.place.y ?? 0];
					const radius = box ? Math.hypot(...box.max.map((v, k) => Math.max(Math.abs(v), Math.abs(box.min[k])))) * (info?.place.scale ?? 1) : TILE_SIZE;
					const margin = edit?.origin ? radius : radius + TILE_SIZE;
					reach = tilesOf([32 * TILE_SIZE - wy - margin, 0, 32 * TILE_SIZE - wx - margin], [32 * TILE_SIZE - wy + margin, 0, 32 * TILE_SIZE - wx + margin]);
				}
				for (const [x, y] of reach) tile(map, x, y).remove.add(uid);
			}
			if (!edit || edit.deleted) continue;
			// Where it is now: the tiles its bounds reach, each listing it.
			const path = storage.pathOf(edit.place.display);
			if (!path) {
				skipped.push(`${name}: not one of the 1.12 client's models (edited on another client?)`);
				continue;
			}
			const matrix = spawnPlacement(edit).matrix;
			const box = await boxOf(edit.place.display, kind);
			const placed = transformBox(matrix, box.min, box.max);
			const { position, rotation, scale } = filePlacement(matrix);
			if (kind === 'wmo' && Math.abs(scale - 1) > 1e-3) skipped.push(`${name}: its scale (${scale.toFixed(2)}); 1.12 draws buildings full size`);
			const model: AdtModel = {
				kind, uid, position, rotation, scale, min: placed.min, max: placed.max,
				// The file names M2s as .mdx, as the game's own maps do.
				name: kind === 'm2' ? path.replace(/\.m2$/i, '.mdx') : path,
				doodadSet: edit.place.doodadSet ?? 0,
				nameSet: edit.place.nameSet ?? 0,
			};
			for (const [x, y] of tilesOf(placed.min, placed.max)) tile(map, x, y).add.push(model);
		} catch (e) {
			skipped.push(`${name}: ${(e as Error).message}`);
		}
	}

	// Each tile read, rewritten and packed.
	const files: { name: string; data: Uint8Array }[] = [];
	const written: string[] = [];
	for (const [key, change] of tiles) {
		if (!change.heights && !change.remove.size && !change.add.length) continue;
		const [mapText, xy] = key.split(':');
		const [x, y] = xy.split('_').map(Number);
		const wdtFdid = await wdtOfMap(Number(mapText));
		const root = wdtFdid !== null ? (await maps.wdt(wdtFdid)).tiles[y * 64 + x]?.files.root : 0;
		if (!wdtFdid || !root) {
			if (change.heights || change.add.length) skipped.push(`Tile ${key}: the map has no such tile`);
			continue;
		}
		const folder = storage.pathOf(wdtFdid)!.split('\\')[2];
		try {
			const bytes = await storage.readFile(root);
			// A tile that might have listed a moved model, and doesn't, stays as it is.
			if (!change.heights && !change.add.length) {
				const listed = listedIds(bytes);
				if (![...change.remove].some((uid) => listed.has(uid))) continue;
			}
			const rewritten = rewriteVanillaAdt(bytes, x, y, change);
			files.push({ name: adtPath(folder, x, y), data: rewritten });
			written.push(key);
		} catch (e) {
			skipped.push(`Tile ${key}: ${(e as Error).message}`);
		}
	}
	return { archive: writeMpq(files), tiles: written, skipped };
}
