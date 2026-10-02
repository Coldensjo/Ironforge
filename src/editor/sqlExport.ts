import type { SpawnInfo } from '../explorer/spawns';
import { isDeleted, type SpawnEdit } from './document';

/**
 * Spawn edits as SQL for a VMaNGOS world database (`mangos`): NPCs in `creature` (and their pose
 * in `creature_addon`), game objects in `gameobject`. Added spawns are inserted under the
 * editor's own guids, moved ones updated, deleted ones removed with the rows that refer to them.
 * Running the file again gives the same result. VMaNGOS's world tables are MyISAM, which has
 * no transactions: a file can't be rolled back once imported, only the database restored.
 *
 * What VMaNGOS has no place for is left out and listed at the top: a spawn's own scale (it
 * comes from the creature or object template), poses 1.12 has no emote for, and the map's own
 * models (props and buildings), which live in the map files rather than the database.
 */

/** Editor poses (AnimationData IDs) as a creature_addon stand state (UnitStandStateType). */
const STAND_STATES: Record<number, number> = { 97: 1, 100: 3, 102: 4, 103: 5, 104: 6, 6: 7, 115: 8 };
/** Editor poses as a looping emote (1.12 Emotes.dbc IDs, a state emote where there's one). */
const EMOTE_STATES: Record<number, number> = {
	60: 1, 64: 5, 65: 6, 67: 3, 66: 2, 113: 66, 68: 4, 80: 21, 70: 11, 69: 10, 84: 29, 82: 23, 81: 22, 74: 15, 77: 18, 79: 20,
	83: 24, 76: 17, 73: 14, 78: 19, 62: 28, 25: 27, 26: 333, 27: 375, 29: 376, 48: 214, 16: 35, 17: 36, 18: 37, 24: 43, 32: 51,
	55: 53, 14: 64,
};
/** Rows elsewhere that name a spawn by its guid, removed with it. */
const CREATURE_LINKS = ['creature_addon', 'creature_battleground', 'game_event_creature', 'game_event_creature_data', 'pool_creature'];
const OBJECT_LINKS = ['gameobject_battleground', 'gameobject_requirement', 'game_event_gameobject', 'pool_gameobject'];
/** New spawns: back five minutes after they die or are used. */
const RESPAWN_SECONDS = 300;
/** Maps a 1.12 server has: the continents and instances, not the editor's sandbox. */
const MAX_GAME_MAP = 99999;

export interface SqlEntry {
	id: string;
	edit: SpawnEdit;
	original: SpawnInfo | null;
}

export interface SqlExport {
	sql: string;
	/** Spawns written: added, changed and deleted. */
	added: number;
	changed: number;
	deleted: number;
	/** What couldn't be written, one line each. */
	skipped: string[];
}

/** A number as SQL: finite, without exponent noise. */
const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0');

/** A spawn's description for comments and messages (no line breaks, no comment ends). */
const label = (s: SpawnInfo | null, guid: number) => `${s?.name ?? 'spawn'} (guid ${guid}${s ? `, entry ${s.entry}` : ''})`.replace(/[\r\n]|\*\//g, ' ');

/** Turns a facing into the rotation quaternion game objects carry, for those that only turn. */
function facing(o: number): [number, number, number, number] {
	return [0, 0, Math.sin(o / 2), Math.cos(o / 2)];
}

export function exportSql(entries: SqlEntry[], now = new Date()): SqlExport {
	const out: string[] = [];
	const skipped: string[] = [];
	let added = 0, changed = 0, deleted = 0;

	for (const { id, edit, original } of entries.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))) {
		const [mapText, type, guidText] = id.split(':');
		const guid = Number(guidText);
		const map = Number(mapText);
		const info = edit ?? original;
		const name = label(info, guid);
		if (type === 'm2' || type === 'wmo') {
			skipped.push(`${name}: a map model; it goes in the map files, not the database`);
			continue;
		}
		if ((type !== 'npc' && type !== 'object') || !Number.isInteger(guid) || map > MAX_GAME_MAP) {
			skipped.push(`${name}: not on a map the server has`);
			continue;
		}
		const table = type === 'npc' ? 'creature' : 'gameobject';
		const links = type === 'npc' ? CREATURE_LINKS : OBJECT_LINKS;

		if (isDeleted(edit)) {
			// Spawns added in the editor and deleted again were never in the database.
			if (edit?.created) continue;
			out.push(`-- Delete ${name}`);
			out.push(`DELETE FROM \`${table}\` WHERE \`guid\` = ${guid};`);
			for (const link of links) out.push(`DELETE FROM \`${link}\` WHERE \`guid\` = ${guid};`);
			if (type === 'npc') {
				out.push(`DELETE FROM \`creature_movement\` WHERE \`id\` = ${guid};`);
				out.push(`DELETE FROM \`creature_linking\` WHERE \`guid\` = ${guid} OR \`master_guid\` = ${guid};`);
			}
			deleted++;
			continue;
		}
		const s = edit!;
		const p = s.place;
		if (original && Math.abs(original.place.scale - p.scale) > 1e-3) skipped.push(`${name}: its scale (${num(p.scale)}); VMaNGOS takes scale from the template`);

		if (s.created) {
			out.push(`-- Add ${name}`);
			out.push(`DELETE FROM \`${table}\` WHERE \`guid\` = ${guid};`);
			if (type === 'npc') {
				out.push(
					'INSERT INTO `creature` (`guid`, `id`, `map`, `position_x`, `position_y`, `position_z`, `orientation`, `spawntimesecsmin`, `spawntimesecsmax`, ' +
					'`wander_distance`, `health_percent`, `mana_percent`, `movement_type`, `spawn_flags`, `visibility_mod`, `patch_min`, `patch_max`) VALUES ' +
					`(${guid}, ${s.entry}, ${map}, ${num(p.x)}, ${num(p.y)}, ${num(p.z)}, ${num(p.o)}, ${RESPAWN_SECONDS}, ${RESPAWN_SECONDS}, 0, 100, 100, 0, 0, 0, 0, 10);`,
				);
			} else {
				const [qx, qy, qz, qw] = p.rotation ?? facing(p.o);
				out.push(
					'INSERT INTO `gameobject` (`guid`, `id`, `map`, `position_x`, `position_y`, `position_z`, `orientation`, `rotation0`, `rotation1`, `rotation2`, `rotation3`, ' +
					'`spawntimesecsmin`, `spawntimesecsmax`, `animprogress`, `state`, `spawn_flags`, `visibility_mod`, `patch_min`, `patch_max`) VALUES ' +
					`(${guid}, ${s.entry}, ${map}, ${num(p.x)}, ${num(p.y)}, ${num(p.z)}, ${num(p.o)}, ${num(qx)}, ${num(qy)}, ${num(qz)}, ${num(qw)}, ` +
					`${RESPAWN_SECONDS}, ${RESPAWN_SECONDS}, 100, 1, 0, 0, 0, 10);`,
				);
			}
			added++;
		} else {
			out.push(`-- Change ${name}`);
			if (type === 'npc') {
				// The editor shows edited NPCs standing still, so they stop wandering and walking paths.
				out.push(
					`UPDATE \`creature\` SET \`map\` = ${map}, \`position_x\` = ${num(p.x)}, \`position_y\` = ${num(p.y)}, \`position_z\` = ${num(p.z)}, ` +
					`\`orientation\` = ${num(p.o)}, \`wander_distance\` = 0, \`movement_type\` = 0 WHERE \`guid\` = ${guid};`,
				);
			} else {
				const [qx, qy, qz, qw] = p.rotation ?? facing(p.o);
				out.push(
					`UPDATE \`gameobject\` SET \`map\` = ${map}, \`position_x\` = ${num(p.x)}, \`position_y\` = ${num(p.y)}, \`position_z\` = ${num(p.z)}, ` +
					`\`orientation\` = ${num(p.o)}, \`rotation0\` = ${num(qx)}, \`rotation1\` = ${num(qy)}, \`rotation2\` = ${num(qz)}, \`rotation3\` = ${num(qw)} WHERE \`guid\` = ${guid};`,
				);
			}
			changed++;
		}

		// The pose, when it's set or was changed: a stand state or a looping emote.
		const pose = p.pose ?? 0;
		if (type === 'npc' && (pose || (original?.place.pose ?? 0) !== pose)) {
			const stand = STAND_STATES[pose] ?? 0;
			const emote = EMOTE_STATES[pose] ?? 0;
			if (pose && !stand && !emote) skipped.push(`${name}: its pose (animation ${pose}) has no 1.12 emote; it stands`);
			out.push(
				`INSERT INTO \`creature_addon\` (\`guid\`, \`patch\`, \`stand_state\`, \`emote_state\`) SELECT ${guid}, 0, ${stand}, ${emote} FROM DUAL ` +
				`WHERE NOT EXISTS (SELECT 1 FROM \`creature_addon\` WHERE \`guid\` = ${guid});`,
			);
			out.push(`UPDATE \`creature_addon\` SET \`stand_state\` = ${stand}, \`emote_state\` = ${emote} WHERE \`guid\` = ${guid};`);
		}
	}

	const header = [
		'-- Ironforge spawn edits for a VMaNGOS world database (`mangos`).',
		`-- Exported ${now.toISOString()}: ${added} added, ${changed} changed, ${deleted} deleted.`,
		'-- Import it into the world database, then restart the world server (mangosd).',
		'-- The world tables keep no undo: to go back, restore the world database from its dump.',
		...(skipped.length ? ['--', '-- Not exported:', ...skipped.map((s) => `--   ${s.replace(/[\r\n]/g, ' ')}`)] : []),
		'',
	];
	return { sql: [...header, ...out, ''].join('\n'), added, changed, deleted, skipped };
}
