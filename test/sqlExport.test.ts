import { describe, expect, it } from 'vitest';
import { exportSql, type SqlEntry } from '../src/editor/sqlExport';
import type { SpawnInfo } from '../src/explorer/spawns';

const npc = (guid: number, extra: Partial<SpawnInfo> = {}, place: Partial<SpawnInfo['place']> = {}): SpawnInfo => ({
	type: 'npc', guid, entry: 197, name: 'Marshal McBride',
	place: { map: 0, x: -8902.5, y: -162.6, z: 81.9, o: 1.5, scale: 1, display: 1859, ...place },
	...extra,
});

describe('SQL export', () => {
	it('adds, moves and deletes NPCs and objects, and leaves out what the server has no place for', () => {
		const object: SpawnInfo = { type: 'object', guid: 9_000_001, entry: 1617, name: 'Peacebloom', created: true, place: { map: 0, x: 1, y: 2, z: 3, o: Math.PI, scale: 1, display: 270 } };
		const entries: SqlEntry[] = [
			{ id: '0:npc:9000000', edit: npc(9_000_000, { created: true }, { pose: 97 }), original: null },
			{ id: '0:npc:79942', edit: npc(79942, {}, { x: -8900, scale: 2 }), original: npc(79942) },
			{ id: '0:npc:79943', edit: null, original: null },
			{ id: '0:object:9000001', edit: object, original: null },
			{ id: '0:m2:1000000000', edit: { ...object, type: 'm2', guid: 1_000_000_000 }, original: null },
			{ id: '0:npc:9000002', edit: npc(9_000_002, { created: true, deleted: true }), original: null },
		];
		const out = exportSql(entries, new Date(0));
		expect([out.added, out.changed, out.deleted]).toEqual([2, 1, 1]);
		expect(out.skipped).toHaveLength(2);
		const sql = out.sql;
		expect(sql).toMatch(/^-- Ironforge/);
		// Added NPC, with its sitting pose.
		expect(sql).toContain('VALUES (9000000, 197, 0, -8902.5, -162.6, 81.9, 1.5, 300, 300,');
		expect(sql).toMatch(/SELECT 9000000, 0, 1, 0 FROM DUAL/);
		// Moved NPC: updated, stops wandering; its scale can't go.
		expect(sql).toContain('UPDATE `creature` SET `map` = 0, `position_x` = -8900,');
		expect(out.skipped.join('\n')).toContain('scale');
		// Deleted NPC, with what refers to it.
		expect(sql).toContain('DELETE FROM `creature` WHERE `guid` = 79943;');
		expect(sql).toContain('DELETE FROM `creature_movement` WHERE `id` = 79943;');
		// Added object: turned half round, as a quaternion.
		expect(sql).toMatch(/\(9000001, 1617, 0, 1, 2, 3, 3\.141593, 0, 0, 1, 0, 300/);
		// Added and deleted again: nothing.
		expect(sql).not.toContain('9000002');
	});
});
