import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeSource } from '../tools/nodeSource';

const VANILLA = process.env.IRONFORGE_VANILLA ?? 'C:/Servers/Software/SoloCraft 1.12.1';

describe('MPQ writer', () => {
	it('writes archives the reader opens, marked as Ironforge\'s own', async () => {
		const { writeMpq, isIronforgeArchive, IRONFORGE_MARKER } = await import('../src/mpq/writer');
		const { MpqArchive } = await import('../src/mpq/archive');
		const files = Array.from({ length: 40 }, (_, i) => ({ name: `World\\Maps\\Azeroth\\Azeroth_${i}_48.adt`, data: new Uint8Array(5000 + i).fill(i) }));
		const bytes = writeMpq(files);
		const archive = await MpqArchive.open({ size: bytes.length, read: async (at: number, n: number) => bytes.slice(at, at + n) });
		for (const f of files) expect(await archive.read(f.name.replace(/\\/g, '/'))).toEqual(f.data);
		expect(archive.has(IRONFORGE_MARKER)).toBe(true);
		// The 40 files and the marker (the list doesn't name itself).
		expect((await archive.listFiles()).length).toBe(41);
		expect(isIronforgeArchive(bytes)).toBe(true);
		expect(isIronforgeArchive(new Uint8Array(100))).toBe(false);
	});
});

describe.skipIf(!existsSync(join(VANILLA, 'Data', 'terrain.MPQ')))('ADT writer', () => {
	const load = async () => {
		const { MpqStorage } = await import('../src/mpq/storage');
		const { VanillaStorage } = await import('../src/mpq/vanillaStorage');
		const { adtPath } = await import('../src/formats/vanilla');
		const storage = new VanillaStorage(await MpqStorage.open(new NodeSource(VANILLA)));
		return { storage, bytes: await storage.readFile(storage.idOf(adtPath('Azeroth', 32, 48))) };
	};

	it('keeps a tile as it is when nothing changes', async () => {
		const { storage, bytes } = await load();
		const { rewriteVanillaAdt } = await import('../src/formats/adtWriter');
		const { parseVanillaAdt, vanillaModelNames } = await import('../src/formats/vanilla');
		const { parsePlacements } = await import('../src/explorer/objects');
		const idOf = (p: string) => storage.idOf(p);
		const out = rewriteVanillaAdt(bytes, 32, 48, { remove: new Set(), add: [] });
		const a = parseVanillaAdt(bytes, idOf), b = parseVanillaAdt(out, idOf);
		expect(b.root.chunks.map((c) => [...c.heights])).toEqual(a.root.chunks.map((c) => [...c.heights]));
		expect(b.tex).toEqual(a.tex);
		expect(b.root.liquids).toEqual(a.root.liquids);
		const pa = parsePlacements(bytes, vanillaModelNames(bytes, idOf));
		const pb = parsePlacements(out, vanillaModelNames(out, idOf));
		expect(pb.map((p) => [p.uid, p.fdid, p.kind])).toEqual(pa.map((p) => [p.uid, p.fdid, p.kind]));
		// MCIN points at every chunk, and MHDR at every list.
		const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
		const mcin = 0x14 + v.getUint32(0x14 + 4, true) + 8;
		for (let i = 0; i < 256; i++) expect(String.fromCharCode(...out.subarray(v.getUint32(mcin + i * 16, true), v.getUint32(mcin + i * 16, true) + 4))).toBe('KNCM');
		for (let k = 1; k <= 8; k++) expect(String.fromCharCode(...out.subarray(0x14 + v.getUint32(0x14 + k * 4, true), 0x14 + v.getUint32(0x14 + k * 4, true) + 4))).toMatch(/^[A-Z]{4}$/);
	}, 60000);

	it('moves heights, takes models out and puts new ones in', async () => {
		const { storage, bytes } = await load();
		const { rewriteVanillaAdt } = await import('../src/formats/adtWriter');
		const { parseVanillaAdt, vanillaModelNames } = await import('../src/formats/vanilla');
		const { parsePlacements } = await import('../src/explorer/objects');
		const { LATTICE_POINTS } = await import('../src/viewer/terrainEdit');
		const idOf = (p: string) => storage.idOf(p);
		const before = parsePlacements(bytes, vanillaModelNames(bytes, idOf));
		const gone = before.find((p) => p.kind === 'm2')!.uid;
		const heights = new Float32Array(LATTICE_POINTS);
		// Raise outer point (row 8, column 8): chunk 0,0's last outer corner and its neighbours' shared corners.
		heights[8 * 129 + 8] = 10;
		const tree = 'World\\Azeroth\\Elwynn\\PassiveDoodads\\Trees\\ElwynnTreeMid01.mdx';
		const out = rewriteVanillaAdt(bytes, 32, 48, {
			heights,
			remove: new Set([gone]),
			add: [{ kind: 'm2', name: tree, uid: 1_000_000_001, position: [32 * 533.3333 + 20, 100, 48 * 533.3333 + 20], rotation: [0, 45, 0], scale: 1.5, min: [32 * 533.3333 + 15, 90, 48 * 533.3333 + 15], max: [32 * 533.3333 + 25, 120, 48 * 533.3333 + 25], doodadSet: 0, nameSet: 0 }],
		});
		const a = parseVanillaAdt(bytes, idOf).root.chunks, b = parseVanillaAdt(out, idOf).root.chunks;
		const at = (chunks: typeof a, cx: number, cy: number, i: number) => chunks.find((c) => c.indexX === cx && c.indexY === cy)!.heights[i];
		expect(at(b, 0, 0, 8 * 17) - at(a, 0, 0, 8 * 17)).toBeCloseTo(0, 4);
		expect(at(b, 0, 0, 8 * 17 + 8) - at(a, 0, 0, 8 * 17 + 8)).toBeCloseTo(10, 4);
		expect(at(b, 1, 1, 0) - at(a, 1, 1, 0)).toBeCloseTo(10, 4);
		const after = parsePlacements(out, vanillaModelNames(out, idOf));
		expect(after.some((p) => p.uid === gone)).toBe(false);
		const added = after.find((p) => p.uid === 1_000_000_001)!;
		expect(storage.pathOf(added.fdid)!.toLowerCase()).toBe(tree.replace(/\.mdx$/i, '.m2').toLowerCase());
		expect(after.length).toBe(before.length);
		// Chunk 0,0 lists the new tree last among its M2s.
		const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
		const mcin = 0x14 + v.getUint32(0x14 + 4, true) + 8;
		const h = v.getUint32(mcin, true) + 8;
		const nDoodads = v.getUint32(h + 0x10, true);
		const refs = h + v.getUint32(h + 0x20, true);
		expect(v.getUint32(refs + (nDoodads - 1) * 4, true)).toBe(after.filter((p) => p.kind === 'm2').length - 1);
	}, 60000);
});

describe('model placement', () => {
	it('takes a placement matrix back apart into what the map file stores', async () => {
		const { placementMatrix } = await import('../src/explorer/objects');
		const { filePlacement } = await import('../src/explorer/mapExport');
		for (const [rx, ry, rz, scale] of [[0, 0, 0, 1], [10, 200, -30, 1.5], [-45, 90, 120, 0.7], [5, 359, 0, 2], [90, 30, 0, 1]]) {
			const m = placementMatrix(17000, 50, 25000, rx, ry, rz, scale);
			const p = filePlacement(m);
			const again = placementMatrix(...p.position, ...p.rotation, p.scale);
			for (let k = 0; k < 16; k++) expect(again[k]).toBeCloseTo(m[k], 4);
		}
	});
});

describe('patch marker', () => {
	it('is the same text where it is written and where it is checked', async () => {
		const { IRONFORGE_MARKER_TEXT } = await import('../src/mpq/writer');
		const { PATCH_MARKER_TEXT } = await import('../electron/wowInstall');
		expect(PATCH_MARKER_TEXT).toBe(IRONFORGE_MARKER_TEXT);
	});
});

describe.skipIf(!existsSync(join(VANILLA, 'Data', 'terrain.MPQ')))('map patch', () => {
	it('puts reshaped ground and a moved and a deleted prop into an archive the game reads', async () => {
		const { MpqStorage } = await import('../src/mpq/storage');
		const { VanillaStorage } = await import('../src/mpq/vanillaStorage');
		const { MpqArchive } = await import('../src/mpq/archive');
		const { MapExplorer } = await import('../src/explorer/maps');
		const { buildMapPatch } = await import('../src/explorer/mapExport');
		const { parsePlacements } = await import('../src/explorer/objects');
		const { parseVanillaAdt, vanillaModelNames, adtPath } = await import('../src/formats/vanilla');
		const { LATTICE_POINTS } = await import('../src/viewer/terrainEdit');
		const storage = new VanillaStorage(await MpqStorage.open(new NodeSource(VANILLA)));
		const maps = new MapExplorer(storage);
		const azeroth = maps.knownMaps()[0];
		const idOf = (p: string) => storage.idOf(p);
		const original = await storage.readFile(idOf(adtPath('Azeroth', 32, 48)));
		const props = parsePlacements(original, vanillaModelNames(original, idOf)).filter((p) => p.kind === 'm2');
		// A prop as the editor sees it: world coordinates, from its placement.
		const spawn = (p: (typeof props)[number]) => {
			const m = p.matrix;
			return {
				type: 'm2' as const, guid: p.uid, entry: p.fdid, name: 'Prop',
				origin: [32 * 533.3333 - m[14], 32 * 533.3333 - m[12]] as [number, number],
				place: { map: 0, x: 32 * 533.3333 - m[14], y: 32 * 533.3333 - m[12], z: m[13], o: 0, rotation: [0, 0, 0, 1] as [number, number, number, number], scale: 1, display: p.fdid },
			};
		};
		const moved = spawn(props[0]);
		const deleted = spawn(props[1]);
		const heights = new Float32Array(LATTICE_POINTS).fill(0);
		heights[64 * 129 + 64] = 25;
		const patch = await buildMapPatch(storage, maps, async (id) => (id === 0 ? azeroth.wdt : null), [
			{ id: `0:m2:${moved.guid}`, edit: { ...moved, place: { ...moved.place, x: moved.place.x + 3, z: moved.place.z + 1 } }, original: null },
			{ id: `0:m2:${deleted.guid}`, edit: { ...deleted, deleted: true }, original: null },
		], { '0:32_48': heights });
		expect(patch.skipped).toEqual([]);
		expect(patch.tiles).toContain('0:32_48');
		const archive = await MpqArchive.open({ size: patch.archive.length, read: async (at: number, n: number) => patch.archive.slice(at, at + n) });
		const tile = (await archive.read(adtPath('Azeroth', 32, 48)))!;
		const after = parsePlacements(tile, vanillaModelNames(tile, idOf));
		expect(after.some((p) => p.uid === deleted.guid)).toBe(false);
		const now = after.find((p) => p.uid === moved.guid)!;
		// Three yards north is three yards less of continent z; one up.
		expect(now.matrix[14]).toBeCloseTo(props[0].matrix[14] - 3, 2);
		expect(now.matrix[13]).toBeCloseTo(props[0].matrix[13] + 1, 2);
		const ground = parseVanillaAdt(tile, idOf).root.chunks.find((c) => c.indexX === 8 && c.indexY === 8)!;
		const before = parseVanillaAdt(original, idOf).root.chunks.find((c) => c.indexX === 8 && c.indexY === 8)!;
		expect(ground.heights[0] - before.heights[0]).toBeCloseTo(25, 3);
	}, 120000);
});

describe.skipIf(!existsSync(join(VANILLA, 'Data', 'terrain.MPQ')))('ADT writer: paint and water', () => {
	it('writes painted layers and edited water the parser reads back', async () => {
		const { MpqStorage } = await import('../src/mpq/storage');
		const { VanillaStorage } = await import('../src/mpq/vanillaStorage');
		const { adtPath, parseVanillaAdt } = await import('../src/formats/vanilla');
		const { rewriteVanillaAdt } = await import('../src/formats/adtWriter');
		const { PAINT_TEXELS } = await import('../src/formats/surfaceEdits');
		const storage = new VanillaStorage(await MpqStorage.open(new NodeSource(VANILLA)));
		const idOf = (p: string) => storage.idOf(p);
		const bytes = await storage.readFile(idOf(adtPath('Azeroth', 32, 48)));
		const before = parseVanillaAdt(bytes, idOf);
		const wet = before.root.liquids[0].chunk;
		const base = storage.pathOf(before.tex.diffuse[before.tex.chunks[0].layers[0].texture])!;
		const cobble = 'Tileset\Elwynn\ElwynnCobblestoneBase.blp';
		const alpha = new Uint8Array(PAINT_TEXELS * 3);
		alpha.fill(128, 0, PAINT_TEXELS);
		const out = rewriteVanillaAdt(bytes, 32, 48, {
			remove: new Set(), add: [],
			paint: { 0: { textures: [base, cobble], alpha } },
			water: { 5: { type: 1, level: 200, cells: new Uint8Array(64).fill(1) }, [wet]: { type: 0, level: 0, cells: new Uint8Array(64) } },
		});
		const after = parseVanillaAdt(out, idOf);
		// Chunk 0: the base and the new cobblestone, half and half (to 4-bit precision).
		const layers = after.tex.chunks[0].layers;
		expect(layers.map((l) => storage.pathOf(after.tex.diffuse[l.texture])!.toLowerCase())).toEqual([base.toLowerCase(), cobble.toLowerCase()]);
		expect(Math.abs(after.tex.chunks[0].alpha[0][1000] - 128)).toBeLessThan(12);
		// Other chunks keep their layers.
		expect(after.tex.chunks[1]).toEqual(before.tex.chunks[1]);
		// Chunk 5 is a lake at 200; the stream's chunk has none; the rest of the stream stays.
		const lake = after.root.liquids.filter((l) => l.chunk === 5);
		expect(lake).toHaveLength(1);
		expect(lake[0].type).toBe(1);
		expect([...lake[0].heights!].every((h) => h === 200)).toBe(true);
		expect([...lake[0].exists!].every((e) => e === 1)).toBe(true);
		expect(after.root.liquids.some((l) => l.chunk === wet)).toBe(false);
		expect(after.root.liquids.length).toBe(before.root.liquids.length);
	}, 60000);
});

describe('blend maps', () => {
	it('turn 1.12 layers drawn one over the other into shares, and back', async () => {
		const { sequentialToWeights, weightsToSequential } = await import('../src/formats/vanilla');
		const { PAINT_TEXELS } = await import('../src/formats/surfaceEdits');
		const maps = [128, 64, 200].map((v) => new Uint8Array(PAINT_TEXELS).fill(v));
		const original = maps.map((m) => m.slice());
		sequentialToWeights(maps);
		// Layer 3 shows by its own alpha; the ones below by what the ones above leave.
		expect(maps[2][0]).toBe(200);
		expect(maps[1][0]).toBe(Math.round(64 * (1 - 200 / 255)));
		expect(maps[0][0] + maps[1][0] + maps[2][0]).toBeLessThanOrEqual(255);
		const back = weightsToSequential(maps);
		for (let i = 0; i < 3; i++) expect(Math.abs(back[i][0] - original[i][0])).toBeLessThanOrEqual(3);
	});
});
