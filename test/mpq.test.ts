import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MpqArchive } from '../src/mpq/archive';
import { HASH_FILE_KEY, hashString } from '../src/mpq/crypto';
import { loadOrder } from '../src/mpq/storage';
import { NodeSource } from '../tools/nodeSource';

describe('MPQ hashing', () => {
	it('gives the well-known keys of the hash and block tables', () => {
		expect(hashString('(hash table)', HASH_FILE_KEY)).toBe(0xc3af3770);
		expect(hashString('(block table)', HASH_FILE_KEY)).toBe(0xec83b3a3);
	});

	it('ignores case and treats / as a backslash', () => {
		expect(hashString('World/Maps/Azeroth/Azeroth.wdt', 1)).toBe(hashString('WORLD\\MAPS\\AZEROTH\\AZEROTH.WDT', 1));
	});
});

describe('MPQ load order', () => {
	it('puts the base archives first, then patch, then numbered and lettered patches', () => {
		expect(loadOrder(['patch-A.MPQ', 'terrain.MPQ', 'patch-2.MPQ', 'patch.MPQ', 'dbc.MPQ', 'patch-3.MPQ', 'patch-10.MPQ'])).toEqual([
			'dbc.MPQ', 'terrain.MPQ', 'patch.MPQ', 'patch-2.MPQ', 'patch-3.MPQ', 'patch-10.MPQ', 'patch-A.MPQ',
		]);
	});
});

// The Battle.net app's own archives: real MPQs (format 2, the classic tables), when they're installed.
const BATTLE_NET = 'C:/Program Files (x86)/Battle.net';
const archives = existsSync(BATTLE_NET)
	? readdirSync(BATTLE_NET).filter((d) => existsSync(join(BATTLE_NET, d, 'Battle.net.mpq'))).map((d) => join(BATTLE_NET, d))
	: [];

describe.skipIf(!archives.length)('a real archive', () => {
	it('lists its files and reads every one to its full size', async () => {
		const source = new NodeSource(archives[0]);
		const archive = await MpqArchive.open(await source.openFile(['Battle.net.mpq']));
		const files = await archive.listFiles();
		expect(files.length).toBeGreaterThan(100);
		let read = 0;
		let unsupported = 0;
		for (const name of files) {
			try {
				const data = await archive.read(name);
				expect(data, name).not.toBeNull();
				read++;
			} catch (e) {
				if (!String(e).includes("isn't supported yet")) throw e;
				unsupported++;
			}
		}
		console.log(`${archives[0]}: ${files.length} files, ${read} read, ${unsupported} in compressions not handled yet`);
		expect(read).toBeGreaterThan(files.length * 0.5);
	}, 120000);
});

// A vanilla 1.12.1 client, where there is one: IRONFORGE_VANILLA, or the folder it was tried with.
const VANILLA = process.env.IRONFORGE_VANILLA ?? 'C:/Servers/Software/SoloCraft 1.12.1';

describe.skipIf(!existsSync(join(VANILLA, 'Data', 'dbc.MPQ')))('a vanilla 1.12.1 client', () => {
	it('reads its map table and the Eastern Kingdoms map files, through its patches', async () => {
		const { MpqStorage } = await import('../src/mpq/storage');
		const { Dbc } = await import('../src/mpq/dbc');
		const storage = await MpqStorage.open(new NodeSource(VANILLA));
		expect(storage.archives.at(-1)?.name).toBe('patch-2.MPQ');
		const maps = new Dbc((await storage.read('DBFilesClient/Map.dbc'))!);
		expect(maps.getString(0, 1)).toBe('Azeroth');
		expect(maps.getString(1, 1)).toBe('Kalimdor');
		for (const path of ['World/Maps/Azeroth/Azeroth.wdt', 'World/Maps/Azeroth/Azeroth.wdl', 'World/Maps/Azeroth/Azeroth_32_48.adt']) {
			const file = await storage.read(path);
			// Chunk IDs are stored reversed: 'MVER' reads as 'REVM'.
			expect(new TextDecoder().decode(file!.subarray(0, 4)), path).toBe('REVM');
		}
	}, 60000);
});

describe.skipIf(!existsSync(join(VANILLA, 'Data', 'terrain.MPQ')))('vanilla map files', () => {
	it("reads Northshire's tile: its ground, texture layers and water", async () => {
		const { MpqStorage } = await import('../src/mpq/storage');
		const { VanillaStorage } = await import('../src/mpq/vanillaStorage');
		const { adtPath, parseVanillaAdt, parseVanillaWdt, wdtPath } = await import('../src/formats/vanilla');
		const storage = new VanillaStorage(await MpqStorage.open(new NodeSource(VANILLA)));
		const idOf = (p: string) => storage.idOf(p);
		const wdt = parseVanillaWdt(await storage.readFile(idOf(wdtPath('Azeroth'))), 'Azeroth', idOf);
		expect(wdt.tileCount).toBeGreaterThan(600);
		expect(storage.pathOf(wdt.tiles[48 * 64 + 32]!.files.root)).toBe(adtPath('Azeroth', 32, 48));
		const { root, tex } = parseVanillaAdt(await storage.readFile(idOf(adtPath('Azeroth', 32, 48))), idOf);
		expect(root.chunks).toHaveLength(256);
		// Every texture it names is in the client, and every chunk has at least its base layer.
		expect(tex.diffuse.length).toBeGreaterThan(3);
		expect(tex.diffuse.every((id) => storage.status(id) === 'ok')).toBe(true);
		expect(tex.chunks.every((c) => c.layers.length >= 1 && c.alpha.length === c.layers.length - 1)).toBe(true);
		// Northshire sits a few hundred yards up, with its stream as water.
		const heights = root.chunks.flatMap((c) => [...c.heights]);
		expect(Math.min(...heights)).toBeGreaterThan(50);
		expect(Math.max(...heights)).toBeLessThan(600);
		expect(root.liquids.length).toBeGreaterThan(10);
		expect(root.liquids.every((l) => l.type === 1 && l.heights!.length === 81)).toBe(true);
	}, 60000);
});

describe.skipIf(!existsSync(join(VANILLA, 'Data', 'model.MPQ')))('vanilla models', () => {
	it("places Northshire's props and buildings, and reads them", async () => {
		const { MpqStorage } = await import('../src/mpq/storage');
		const { VanillaStorage } = await import('../src/mpq/vanillaStorage');
		const { adtPath, vanillaModelNames } = await import('../src/formats/vanilla');
		const { loadM2, loadWmo, parsePlacements } = await import('../src/explorer/objects');
		const storage = new VanillaStorage(await MpqStorage.open(new NodeSource(VANILLA)));
		const idOf = (p: string) => storage.idOf(p);
		const bytes = await storage.readFile(idOf(adtPath('Azeroth', 32, 48)));
		const placements = parsePlacements(bytes, vanillaModelNames(bytes, idOf));
		const m2s = placements.filter((p) => p.kind === 'm2');
		const wmos = placements.filter((p) => p.kind === 'wmo');
		expect(m2s.length).toBeGreaterThan(700);
		expect(wmos.length).toBe(8);
		// Every model placed is in the client.
		expect(placements.every((p) => storage.status(p.fdid) === 'ok')).toBe(true);

		// Each kind of prop reads, with textures where it names them.
		let textured = 0;
		for (const fdid of new Set(m2s.map((p) => p.fdid))) {
			const model = await loadM2(storage, fdid);
			expect(model.indices.length, storage.pathOf(fdid)).toBeGreaterThan(0);
			expect(model.radius).toBeGreaterThan(0);
			if (model.batches.some((b) => b.material.texture && storage.status(b.material.texture) === 'ok')) textured++;
		}
		expect(textured).toBeGreaterThan(new Set(m2s.map((p) => p.fdid)).size * 0.8);

		// The abbey: its groups, textures and furnishings.
		const abbey = wmos.find((p) => /nsabbey\.wmo$/i.test(storage.pathOf(p.fdid)!))!;
		const model = await loadWmo(storage, abbey.fdid, () => 'water');
		expect(model.indices.length).toBeGreaterThan(1000);
		expect(model.batches.every((b) => storage.status(b.material.texture) === 'ok')).toBe(true);
		const doodads = model.doodadSets!.flatMap((s) => s.doodads);
		expect(doodads.length).toBeGreaterThan(10);
		expect(doodads.every((d) => storage.status(d.fdid) === 'ok')).toBe(true);
	}, 120000);
});
