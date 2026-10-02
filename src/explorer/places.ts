import type { GameStorage } from '../casc/storage';
import { DB2_FILES, loadTable } from './clientDb';

/** A place to go to by name: a zone with its extent, or a town or landmark on the world map. */
export interface Place {
	name: string;
	kind: 'zone' | 'place';
	mapId: number;
	/** WoW world coordinates (x north, y west) of the middle of a zone, or of the place. */
	x: number;
	y: number;
	/** Yards across a zone at its widest; 0 for a place, and for a city, which is gone to at its gate. */
	size: number;
	/** The zone a place lies in, when known. */
	zone: string | null;
}

/** UiMap fields: 0 name, 5 type (3 zone, 6 battleground). */
const UI_MAP_NAME = 0;
const UI_MAP_TYPE = 5;
const UI_MAP_ZONE = 3;
const UI_MAP_BATTLEGROUND = 6;
/** UiMapAssignment fields: 2 region [min x, y, z, max x, y, z], 4 UiMap, 6 map, 7 area. */
const ASSIGN_REGION = 2;
const ASSIGN_UI_MAP = 4;
const ASSIGN_MAP = 6;
const ASSIGN_AREA = 7;
/** AreaPOI fields: 0 name, 1 player condition, 3 position, 5 world state, 8 flags, 13 map. */
const POI_NAME = 0;
const POI_CONDITION = 1;
const POI_POSITION = 3;
const POI_WORLD_STATE = 5;
const POI_FLAGS = 8;
const POI_MAP = 13;
/** Shown on the world map at all times (towns and landmarks, not battleground objectives). */
const POI_SHOWN = 0x4;

/** Zones from the world map's layout (UiMapAssignment) and towns and landmarks from AreaPOI. */
export async function loadPlaces(storage: GameStorage): Promise<Place[]> {
	const [uiMaps, assignments, pois] = await Promise.all([
		loadTable(storage, DB2_FILES.UiMap),
		loadTable(storage, DB2_FILES.UiMapAssignment),
		loadTable(storage, DB2_FILES.AreaPOI),
	]);
	const zones: (Place & { min: [number, number]; max: [number, number] })[] = [];
	const seen = new Set<string>();
	for (const id of assignments.ids()) {
		const uiMap = assignments.getInt(id, ASSIGN_UI_MAP) ?? 0;
		const type = uiMaps.getInt(uiMap, UI_MAP_TYPE);
		const name = uiMaps.getString(uiMap, UI_MAP_NAME);
		if (!name || !assignments.getInt(id, ASSIGN_AREA) || (type !== UI_MAP_ZONE && type !== UI_MAP_BATTLEGROUND)) continue;
		const mapId = assignments.getInt(id, ASSIGN_MAP) ?? 0;
		if (seen.has(`${mapId}:${name}`)) continue;
		seen.add(`${mapId}:${name}`);
		const r = (k: number) => assignments.getFloat(id, ASSIGN_REGION, k) ?? 0;
		const min: [number, number] = [r(0), r(1)];
		const max: [number, number] = [r(3), r(4)];
		const size = Math.max(max[0] - min[0], max[1] - min[1]);
		zones.push({ name, kind: 'zone', mapId, x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, size, zone: null, min, max });
	}
	/** The smallest zone around a point: a city before the zone it's in. */
	const zoneAt = (mapId: number, x: number, y: number) => {
		let best: (typeof zones)[number] | null = null;
		for (const z of zones) {
			if (z.mapId !== mapId || x < z.min[0] || x > z.max[0] || y < z.min[1] || y > z.max[1]) continue;
			if (!best || z.size < best.size) best = z;
		}
		return best?.name ?? null;
	};
	/** "The Undercity" and "Undercity", "Stormwind" and "Stormwind City". */
	const sameName = (a: string, b: string) => {
		const plain = (n: string) => n.toLowerCase().replace(/^the /, '').replace(/ city$/, '');
		return plain(a) === plain(b);
	};

	const places: Place[] = zones.map(({ min: _min, max: _max, ...zone }) => zone);
	for (const id of pois.ids()) {
		const name = pois.getString(id, POI_NAME)?.trim();
		const flags = pois.getInt(id, POI_FLAGS) ?? 0;
		if (!name || !(flags & POI_SHOWN) || pois.getInt(id, POI_CONDITION) || pois.getInt(id, POI_WORLD_STATE)) continue;
		const mapId = pois.getInt(id, POI_MAP) ?? 0;
		const x = pois.getFloat(id, POI_POSITION, 0) ?? 0;
		const y = pois.getFloat(id, POI_POSITION, 1) ?? 0;
		// A city's own marker is at its gate (the middle of Ironforge's zone is the mountain it's in).
		const city = places.find((z) => z.kind === 'zone' && z.size && z.mapId === mapId && sameName(z.name, name));
		if (city) {
			Object.assign(city, { x, y, size: 0 });
			continue;
		}
		if (seen.has(`${mapId}:${name}`)) continue;
		seen.add(`${mapId}:${name}`);
		places.push({ name, kind: 'place', mapId, x, y, size: 0, zone: zoneAt(mapId, x, y) });
	}
	return places;
}
