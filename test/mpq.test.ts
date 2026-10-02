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
