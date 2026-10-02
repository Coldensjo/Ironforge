import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSource } from '../tools/nodeSource';

// A vanilla 1.12.1 client, where there is one: IRONFORGE_VANILLA, or the folder it was tried with.
const VANILLA = process.env.IRONFORGE_VANILLA ?? 'C:/Servers/Software/SoloCraft 1.12.1';

describe.skipIf(!existsSync(join(VANILLA, 'Data', 'dbc.MPQ')))("the vanilla client's tables", async () => {
	const open = async () => {
		const { MpqStorage } = await import('../src/mpq/storage');
		const { VanillaStorage } = await import('../src/mpq/vanillaStorage');
		return new VanillaStorage(await MpqStorage.open(new NodeSource(VANILLA)));
	};

	it('lights the Eastern Kingdoms through the day, with Elwynn as its own zone', async () => {
		const { loadLighting } = await import('../src/explorer/lighting');
		const lighting = await loadLighting(await open(), [0]);
		const global = lighting.zones.find((z) => z.outer === 0);
		expect(global).toBeDefined();
		// Light 3 is at (-10358, -2789) with a 387-536 yard falloff, as the modern table has it.
		const zone = lighting.zones.find((z) => Math.abs(z.x + 10358.4) < 1 && Math.abs(z.y + 2789.2) < 1);
		expect(zone?.inner).toBeCloseTo(386.8, 0);
		expect(zone?.outer).toBeCloseTo(536.1, 0);
		const keys = lighting.keys[global!.params];
		expect(keys.length).toBeGreaterThan(3);
		// Noon is brighter than midnight, and the fog reaches a few hundred yards.
		const brightness = (c: number) => (c >> 16) + ((c >> 8) & 0xff) + (c & 0xff);
		const noon = keys.reduce((a, b) => (Math.abs(b.time - 1440) < Math.abs(a.time - 1440) ? b : a));
		const night = keys.reduce((a, b) => (Math.min(b.time, 2880 - b.time) < Math.min(a.time, 2880 - a.time) ? b : a));
		expect(brightness(noon.colors[0])).toBeGreaterThan(brightness(night.colors[0]));
		expect(noon.fogEnd / 36).toBeGreaterThan(100);
		expect(noon.fogEnd / 36).toBeLessThan(2000);
	}, 60000);

	it('names areas, lists dungeons and finds zones and towns to go to', async () => {
		const storage = await open();
		const { loadAreas } = await import('../src/explorer/lighting');
		const { loadPlaces } = await import('../src/explorer/places');
		const { DB2_FILES, loadTable } = await import('../src/explorer/clientDb');
		const areas = await loadAreas(storage);
		expect(areas.find((a) => a.id === 12)?.name).toBe('Elwynn Forest');
		expect(areas.find((a) => a.name === 'Northshire Valley')?.parent).toBe(12);
		const maps = await loadTable(storage, DB2_FILES.Map);
		// The Deadmines (36), as 1.12 names it: its WDT is in the client.
		expect(maps.getString(36, 1)).toBe('Deadmines');
		expect(storage.status(maps.getInt(36, 21)!)).toBe('ok');
		const places = await loadPlaces(storage);
		const elwynn = places.find((p) => p.name === 'Elwynn Forest');
		expect(elwynn?.kind).toBe('zone');
		expect(elwynn?.mapId).toBe(0);
		// Goldshire is around (-9460, 60).
		expect(elwynn!.x).toBeLessThan(-8000);
		expect(places.filter((p) => p.kind === 'place').length).toBeGreaterThan(50);
	}, 60000);

	it('plays zone music from its files, and finds clutter, locks and liquids', async () => {
		const storage = await open();
		const { MusicTables } = await import('../src/explorer/music');
		const { GroundEffects } = await import('../src/explorer/groundEffects');
		const { liquidKinds, lockKinds } = await import('../src/explorer/clientDb');
		const music = await new MusicTables(storage).load();
		const elwynn = music.sets[music.areas[12].music];
		expect(elwynn.day.length).toBeGreaterThan(0);
		expect(elwynn.day.every((f) => storage.status(f) === 'ok')).toBe(true);
		const kinds = await liquidKinds(storage);
		expect([1, 2, 3, 4].map(kinds)).toEqual(['water', 'ocean', 'magma', 'slime']);
		const locks = await lockKinds(storage);
		expect(Object.values(locks)).toContain('herb');
		expect(Object.values(locks)).toContain('ore');
		const effects = await GroundEffects.load(storage);
		expect(effects).toBeDefined();
	}, 60000);

	it('dresses NPCs and creatures, and poses them standing', async () => {
		const storage = await open();
		const { DisplayResolver } = await import('../src/explorer/spawns');
		const { loadM2 } = await import('../src/explorer/objects');
		const displays = new DisplayResolver(storage);
		const ok = (id: number | undefined) => !!id && storage.status(id) === 'ok';
		// A Stormwind guard (display 3167): baked outfit, helmet, shoulders, sword and shield.
		const guard = (await displays.creature(3167, [7483, 2080, 1]))!;
		expect(storage.pathOf(guard.fdid)).toMatch(/HumanMale\.m2$/);
		expect(ok(guard.options.textures?.[1])).toBe(true);
		expect(guard.options.attachments!.map((a) => a.point).sort((a, b) => a - b)).toEqual([0, 1, 5, 6, 11]);
		expect(guard.options.attachments!.every((a) => ok(a.fdid) && ok(a.texture))).toBe(true);
		// Brother Paxton (3253): his hair, in its colour.
		const paxton = (await displays.creature(3253))!;
		expect(storage.pathOf(paxton.options.textures![6])).toMatch(/Hair.*\.blp$/i);
		expect(ok(paxton.options.textures![6])).toBe(true);
		const model = await loadM2(storage, paxton.fdid, paxton.options);
		expect(model.animation?.clips.length).toBe(2);
		// A kobold (10913): its skin, from the model's folder.
		const kobold = (await displays.creature(10913))!;
		expect(ok(kobold.options.textures?.[11])).toBe(true);
		expect((await displays.reactionLookup())(12)).toEqual({ alliance: 'friendly', horde: 'hostile' });
		expect(ok((await displays.object(1))!)).toBe(true);
	}, 60000);

	it('has minimaps for the continents, and the interface art and fonts', async () => {
		const storage = await open();
		const { MapExplorer } = await import('../src/explorer/maps');
		const { KNOWN_FILE_PATHS } = await import('../src/mpq/knownFiles');
		const maps = new MapExplorer(storage);
		const azeroth = maps.knownMaps()[0];
		const wdt = await maps.wdt(azeroth.wdt);
		const minimap = wdt.tiles[48 * 64 + 32]!.files.minimap;
		expect(storage.status(minimap)).toBe('ok');
		const tiles = wdt.tiles.filter((t) => t);
		expect(tiles.filter((t) => storage.status(t!.files.minimap) === 'ok').length).toBeGreaterThan(tiles.length * 0.9);
		const missing = Object.keys(KNOWN_FILE_PATHS).map(Number).filter((id) => storage.status(id) !== 'ok').map((id) => KNOWN_FILE_PATHS[id]);
		// Two pieces are newer than 1.12; the skin does without them.
		expect(missing.sort()).toEqual(['interface/cursor/openhand.blp', 'interface/framegeneral/ui-background-marble.blp']);
	}, 60000);
});
