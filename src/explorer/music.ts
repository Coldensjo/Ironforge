import type { GameStorage } from '../casc/storage';
import { DB2_FILES, loadTable, type Table } from './clientDb';

/** A zone's music (ZoneMusic.db2): tracks by day and night, and the quiet between them. */
export interface MusicSet {
	name: string;
	day: number[];
	night: number[];
	/** Silence between tracks, ms. */
	silence: [number, number];
}

/** A fanfare played on arriving somewhere (ZoneIntroMusicTable.db2), at most once per minDelay minutes. */
export interface MusicIntro {
	name: string;
	files: number[];
	minDelay: number;
}

export interface MusicData {
	sets: Record<number, MusicSet>;
	intros: Record<number, MusicIntro>;
	/** AreaTable ID -> ZoneMusic ID and intro ID, for areas that have either. */
	areas: Record<number, { music: number; intro: number }>;
	/** AreaTable ID -> its underwater ambience (SoundAmbience ID), where it differs from the usual one. */
	underwater: Record<number, number>;
	/** The underwater ambience most areas use. */
	underwaterDefault: number;
	/** Sounds of the underwater ambiences: a loop, and one-offs on going under and coming up. */
	ambiences: Record<number, { loop: number[]; enter: number[]; exit: number[] }>;
}

/** A room of a building (WMOAreaTable.db2): its own name, music and intro, and the area it belongs to. */
export interface WmoArea {
	name: string | null;
	music: number;
	intro: number;
	area: number;
}

// Field indices in this build.
const AREA_UNDERWATER_AMBIENCE = 8;
const AREA_MUSIC = 9;
const AREA_INTRO = 12;
const MUSIC_NAME = 0;
const MUSIC_SILENCE_MIN = 1;
const MUSIC_SILENCE_MAX = 2;
const MUSIC_SOUNDS = 3;
const INTRO_NAME = 0;
const INTRO_SOUND = 1;
const INTRO_DELAY = 3;
const AMBIENCE_LOOP = 3;
const AMBIENCE_START = 4;
const AMBIENCE_STOP = 5;
const KIT_ID = 0;
const KIT_FILE = 1;
const WMO_ID = 2;
const WMO_NAME_SET = 3;
const WMO_GROUP = 4;
const WMO_MUSIC = 9;
const WMO_INTRO = 11;
const WMO_AREA = 13;

/** Music tables, read once. Sound kits are resolved to their files (MP3s) here. */
export class MusicTables {
	private data: Promise<MusicData> | null = null;
	private wmoRows: Promise<Map<string, number>> | null = null;

	constructor(private readonly storage: GameStorage) {}

	load(): Promise<MusicData> {
		this.data ??= this.read();
		return this.data;
	}

	private async read(): Promise<MusicData> {
		const [areaTable, music, intro, kits, ambience] = await Promise.all([
			loadTable(this.storage, DB2_FILES.AreaTable),
			loadTable(this.storage, DB2_FILES.ZoneMusic),
			loadTable(this.storage, DB2_FILES.ZoneIntroMusicTable),
			loadTable(this.storage, DB2_FILES.SoundKitEntry),
			loadTable(this.storage, DB2_FILES.SoundAmbience),
		]);
		const files = new Map<number, number[]>();
		for (const id of kits.ids()) {
			const kit = kits.getInt(id, KIT_ID) ?? 0;
			const file = kits.getInt(id, KIT_FILE) ?? 0;
			if (!kit || !file) continue;
			const list = files.get(kit);
			if (list) list.push(file);
			else files.set(kit, [file]);
		}
		const filesOf = (kit: number | null) => (kit ? files.get(kit) ?? [] : []);

		const sets: MusicData['sets'] = {};
		for (const id of music.ids()) {
			sets[id] = {
				name: music.getString(id, MUSIC_NAME) ?? `Music ${id}`,
				day: filesOf(music.getInt(id, MUSIC_SOUNDS, 0)),
				night: filesOf(music.getInt(id, MUSIC_SOUNDS, 1)),
				silence: [music.getInt(id, MUSIC_SILENCE_MIN, 0) ?? 0, music.getInt(id, MUSIC_SILENCE_MAX, 0) ?? 0],
			};
		}
		const intros: MusicData['intros'] = {};
		for (const id of intro.ids()) {
			const list = filesOf(intro.getInt(id, INTRO_SOUND));
			if (list.length) intros[id] = { name: intro.getString(id, INTRO_NAME) ?? `Intro ${id}`, files: list, minDelay: intro.getInt(id, INTRO_DELAY) ?? 0 };
		}
		const areas: MusicData['areas'] = {};
		for (const id of areaTable.ids()) {
			const m = areaTable.getInt(id, AREA_MUSIC) ?? 0;
			const i = areaTable.getInt(id, AREA_INTRO) ?? 0;
			if (m || i) areas[id] = { music: m, intro: i };
		}

		// Underwater ambience per area; nearly all share one, so only the others are listed.
		const counts = new Map<number, number>();
		for (const id of areaTable.ids()) {
			const a = areaTable.getInt(id, AREA_UNDERWATER_AMBIENCE) ?? 0;
			if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
		}
		const underwaterDefault = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
		const underwater: MusicData['underwater'] = {};
		for (const id of areaTable.ids()) {
			const a = areaTable.getInt(id, AREA_UNDERWATER_AMBIENCE) ?? 0;
			if (a && a !== underwaterDefault) underwater[id] = a;
		}
		const ambiences: MusicData['ambiences'] = {};
		for (const id of counts.keys()) {
			if (!ambience.has(id)) continue;
			ambiences[id] = {
				loop: filesOf(ambience.getInt(id, AMBIENCE_LOOP, 0)),
				enter: filesOf(ambience.getInt(id, AMBIENCE_START, 0)),
				exit: filesOf(ambience.getInt(id, AMBIENCE_STOP, 0)),
			};
		}
		return { sets, intros, areas, underwater, underwaterDefault, ambiences };
	}

	/**
	 * The room of a building: its own row, with the building's default row (group -1) filling in
	 * what the room leaves unset. Null when the building has neither.
	 */
	async wmoArea(wmoId: number, nameSet: number, groupId: number): Promise<WmoArea | null> {
		const table = await loadTable(this.storage, DB2_FILES.WMOAreaTable);
		this.wmoRows ??= Promise.resolve(indexWmoRows(table));
		const rows = await this.wmoRows;
		const read = (row: number | undefined): WmoArea | null => row === undefined ? null : {
			name: table.getString(row, 0) || null,
			music: table.getInt(row, WMO_MUSIC) ?? 0,
			intro: table.getInt(row, WMO_INTRO) ?? 0,
			area: table.getInt(row, WMO_AREA) ?? 0,
		};
		const room = read(rows.get(`${wmoId}:${nameSet}:${groupId}`));
		const building = read(rows.get(`${wmoId}:${nameSet}:-1`));
		if (!room) return building;
		if (!building) return room;
		return {
			name: room.name ?? building.name,
			music: room.music || building.music,
			intro: room.intro || building.intro,
			area: room.area || building.area,
		};
	}
}

function indexWmoRows(table: Table): Map<string, number> {
	const rows = new Map<string, number>();
	for (const id of table.ids()) rows.set(`${table.getInt(id, WMO_ID)}:${table.getInt(id, WMO_NAME_SET)}:${table.getInt(id, WMO_GROUP)}`, id);
	return rows;
}
