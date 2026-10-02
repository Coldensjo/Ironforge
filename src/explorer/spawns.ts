import type { GameStorage } from '../casc/storage';
import { TILE_SIZE } from '../formats/adt';
import type { Db2 } from '../formats/db2';
import { loadTable } from './clientDb';
import { compose, fromQuaternion, identity, rotationZ, scaling, translation, type Mat4 } from './mat4';
import type { GearAttachment, M2Options, ObjectKind, Placement } from './objects';
import { ATTACH_HAND_LEFT, ATTACH_HAND_RIGHT, ATTACH_HELM, ATTACH_SHIELD, ATTACH_SHOULDER_LEFT, ATTACH_SHOULDER_RIGHT } from '../formats/m2Pose';

const MAP_ORIGIN = 32 * TILE_SIZE;
/** creature_template npcflag bits (patch 1.12). */
const NPC_FLAG_SPIRIT_HEALER = 0x20;
const NPC_FLAG_SPIRIT_GUIDE = 0x40;

/** Shown when a spawn is clicked. */
export interface SpawnInfo {
	/** NPC, VMaNGOS game object, or one of the map's own models (a prop, or a building) placed by the ADT. */
	type: SpawnType;
	guid: number;
	/** creature_template / gameobject_template entry: the ID Wowhead uses. */
	entry: number;
	name: string;
	subname?: string;
	level?: string;
	/** Creature type or game object type, as a label. */
	kind?: string;
	rank?: string;
	/** Readable objects: their pages of text. */
	pages?: string[];
	/** NPCs: how they react to Alliance and Horde players (name plate colour). */
	reaction?: { alliance: Reaction; horde: Reaction };
	/** Spirit healers and battleground spirit guides, which can be hidden on their own. */
	spiritHealer?: true;
	/** Made in the editor (a copy), not in the spawn data. */
	created?: true;
	/** Deleted in the editor (kept so it can still be named and restored). */
	deleted?: true;
	/** Where and how it stands, for the editor; an edited spawn is drawn from this alone. */
	place: SpawnPlace;
}

/** A spawn's position and look, close to VMaNGOS's creature and gameobject rows. */
export interface SpawnPlace {
	/** Map.db2 ID. */
	map: number;
	/** WoW world coordinates: x north, y west, z up. */
	x: number;
	y: number;
	z: number;
	/** Facing, radians anticlockwise from north. */
	o: number;
	/** Game objects that are tilted: their full rotation (x, y, z, w) about world axes. */
	rotation?: [number, number, number, number];
	/** Final model scale (template and display scale together). */
	scale: number;
	/** Creature or game object display ID; for the map's own models, the model file. */
	display: number;
	/** Held weapons, as for Placement.variant. */
	variant?: string;
	/** NPCs: the animation (AnimationData ID) they hold in place of Stand: sitting, sleeping, an emote. */
	pose?: number;
	/** Buildings: the doodad set (furniture) shown besides the default one, and the name set. */
	doodadSet?: number;
	nameSet?: number;
}

export type Reaction = 'hostile' | 'neutral' | 'friendly';

export type SpawnType = 'npc' | 'object' | 'm2' | 'wmo';

/** The object manager's kind for a spawn type. */
export const spawnKind = (type: SpawnType): ObjectKind => (type === 'npc' ? 'creature' : type);

/** public/spawns/map<id>.json, written by tools/buildSpawns.ts. */
export interface SpawnFile {
	pages: Record<number, string[]>;
	creatures: {
		/** entry -> [name, subname, levelMin, levelMax, type, rank, npcFlags, displayIds, scales, factionTemplate, weapons, walkSpeed] */
		templates: Record<number, [string, string, number, number, number, number, number, number[], number[], number, Weapons | 0, number?]>;
		/**
		 * [guid, entry, x, y, z, orientation, movement] in world coordinates. movement: a wander
		 * radius (> 0), a waypoint path (-1: in paths by guid, -2: in templatePaths by entry), or 0.
		 */
		spawns: [number, number, number, number, number, number, number?][];
		/** Waypoints, [x, y, z, wait seconds, ...] in world coordinates, looping. */
		paths?: Record<number, number[]>;
		templatePaths?: Record<number, number[]>;
	};
	objects: {
		/** entry -> [name, type, displayId, size, data0] */
		templates: Record<number, [string, number, number, number, number]>;
		/** [guid, entry, x, y, z, orientation, rotation quaternion x, y, z, w] */
		spawns: [number, number, number, number, number, number, number, number, number, number][];
	};
}

const CREATURE_TYPES = ['', 'Beast', 'Dragonkin', 'Demon', 'Elemental', 'Giant', 'Undead', 'Humanoid', 'Critter', 'Mechanical', 'Not specified', 'Totem'];
const RANKS = ['', 'Elite', 'Rare Elite', 'Boss', 'Rare'];
const OBJECT_TYPES: Record<number, string> = {
	0: 'Door', 1: 'Button', 2: 'Quest giver', 3: 'Chest', 5: 'Object', 6: 'Trap', 7: 'Chair', 8: 'Spell focus',
	9: 'Text', 10: 'Interactive', 11: 'Transport', 13: 'Camera', 15: 'Transport', 17: 'Fishing node', 18: 'Summoning ritual',
	19: 'Mailbox', 20: 'Auction house', 22: 'Spellcaster', 23: 'Meeting stone', 24: 'Flag stand', 25: 'Fishing hole', 26: 'Flag drop',
};

/**
 * World -> continent space (x east, y up, z south): x = origin - worldY, y = worldZ, z = origin - worldX.
 * Models use WoW's own axes (x forward, y left, z up), so a world rotation is conjugated into this basis.
 */
const WORLD_BASIS: Mat4 = (() => {
	const m = identity();
	// Columns: world x (north) -> -z, world y (west) -> -x, world z (up) -> +y.
	m[0] = 0; m[1] = 0; m[2] = -1;
	m[4] = -1; m[5] = 0; m[6] = 0;
	m[8] = 0; m[9] = 1; m[10] = 0;
	return m;
})();

/** A model placed at WoW world coordinates (x north, y west, z up), turned by a rotation about its own axes. */
export function spawnMatrix(x: number, y: number, z: number, rotation: Mat4, scale: number): Mat4 {
	return compose(translation(MAP_ORIGIN - y, z, MAP_ORIGIN - x), WORLD_BASIS, rotation, scaling(scale));
}

/** A spawn placed as its info says, standing still (edited spawns don't walk their old paths). */
export function spawnPlacement(info: SpawnInfo): Placement {
	const { x, y, z, o, rotation, scale, display, variant, pose, doodadSet = 0, nameSet } = info.place;
	const turn = rotation ? fromQuaternion(...rotation) : rotationZ((o * 180) / Math.PI);
	return {
		kind: spawnKind(info.type),
		uid: info.guid,
		fdid: display,
		matrix: spawnMatrix(x, y, z, turn, scale),
		doodadSet,
		nameSet,
		// The pose loads as its own look, so it goes in the variant too.
		variant: pose ? `${variant ?? ''}@${pose}` : variant,
		spawn: info,
	};
}

type CreatureRow = SpawnFile['creatures']['templates'][number];
type ObjectRow = SpawnFile['objects']['templates'][number];

/** Lookups a creature's look and name colour need, from the client's tables. */
export interface SpawnLookups {
	scaleOf: (displayId: number) => number;
	reactionOf: ReactionLookup;
}

/** An NPC from its template, at a place (WoW world coordinates); null without a look. */
export function creatureSpawn(map: number, guid: number, entry: number, t: CreatureRow, x: number, y: number, z: number, o: number, lookups: SpawnLookups): SpawnInfo | null {
	const [name, subname, levelMin, levelMax, type, rank, npcFlags, displays, scales, faction, weapons] = t;
	if (!displays.length) return null;
	// Templates with several looks pick one per spawn; keep it stable per guid.
	const pick = guid % displays.length;
	const displayId = displays[pick];
	return {
		type: 'npc', guid, entry, name,
		subname: subname || undefined,
		level: levelMin === levelMax ? `${levelMin}` : `${levelMin}-${levelMax}`,
		kind: CREATURE_TYPES[type] || undefined,
		rank: RANKS[rank] || undefined,
		reaction: lookups.reactionOf(faction),
		spiritHealer: npcFlags & (NPC_FLAG_SPIRIT_HEALER | NPC_FLAG_SPIRIT_GUIDE) ? true : undefined,
		place: { map, x, y, z, o, scale: (scales[pick] || 1) * lookups.scaleOf(displayId), display: displayId, variant: weapons ? weapons.join('_') : undefined },
	};
}

/** A game object from its template; null without a model. */
export function objectSpawn(
	map: number, guid: number, entry: number, t: ObjectRow, x: number, y: number, z: number, o: number,
	rotation?: [number, number, number, number], pages?: Record<number, string[]>,
): SpawnInfo | null {
	const [name, type, displayId, size, data0] = t;
	if (!displayId) return null;
	return {
		type: 'object', guid, entry, name,
		kind: OBJECT_TYPES[type],
		pages: type === 9 && data0 ? pages?.[data0] : undefined,
		place: { map, x, y, z, o, rotation, scale: size || 1, display: displayId },
	};
}

/** A creature template's type, as a label (Beast, Humanoid...). */
export const creatureTypeName = (type: number): string | undefined => CREATURE_TYPES[type] || undefined;

/** The type label the info card shows for a game object template's type. */
export const objectTypeName = (type: number) => OBJECT_TYPES[type];

/** Base walking speed (yd/s); creature templates scale it. */
const WALK_SPEED = 2.5;

/** How a creature moves, like the server's movement generators. */
export interface SpawnMovement {
	/** Walking speed, yd/s. */
	speed: number;
	/** Facing at the spawn point (WoW orientation, radians); the placement matrix has it built in. */
	orientation: number;
	/** Wander radius around the spawn point, or 0. */
	wander: number;
	/** Looping waypoints in continent space: [x, y, z, wait seconds] per point; empty when wandering. */
	path: number[];
}

/** World waypoints -> continent space, the same mapping as spawnMatrix. */
function continentPath(points: number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i + 3 < points.length; i += 4) out.push(MAP_ORIGIN - points[i + 1], points[i + 2], MAP_ORIGIN - points[i], points[i + 3]);
	return out;
}

export type ReactionLookup = (factionTemplate: number) => { alliance: Reaction; horde: Reaction };

/** The page's URL; the spawn files sit beside it, not beside this worker's script. */
let pageUrl = '';

export function setPageUrl(url: string): void {
	pageUrl = url;
}

export const spawnFile = (name: string) => new URL(`spawns/${name}`, pageUrl || location.href).href;

/** The ADT tile WoW world coordinates fall on. */
export const tileOf = (x: number, y: number) => ({ tx: Math.floor(32 - y / TILE_SIZE), ty: Math.floor(32 - x / TILE_SIZE) });

/**
 * Creature and game object spawns from the VMaNGOS world database, served as extra placements
 * per ADT tile, plus the client tables that turn display IDs into models.
 */
export class SpawnSource {
	private readonly byTile = new Map<string, Placement[]>();

	private constructor(private readonly mapId: number, private readonly file: SpawnFile) {}

	static async load(mapId: number): Promise<SpawnSource | null> {
		try {
			const response = await fetch(spawnFile(`map${mapId}.json`));
			if (!response.ok) return null;
			return new SpawnSource(mapId, await response.json());
		} catch {
			return null;
		}
	}

	/** Placements for one tile, built on first use. kind 'creature' and 'object' carry display IDs. */
	placements(x: number, y: number, lookups: SpawnLookups): Placement[] {
		if (this.byTile.size === 0) this.index(lookups);
		return this.byTile.get(`${x}_${y}`) ?? [];
	}

	private index(lookups: SpawnLookups): void {
		const add = (x: number, y: number, p: Placement) => {
			const { tx, ty } = tileOf(x, y);
			const key = `${tx}_${ty}`;
			const list = this.byTile.get(key) ?? [];
			list.push(p);
			this.byTile.set(key, list);
		};
		const { creatures, objects, pages } = this.file;
		for (const [guid, entry, x, y, z, o, move = 0] of creatures.spawns) {
			const t = creatures.templates[entry];
			if (!t) continue;
			const walk = t[11] ?? 1;
			const points = move === -1 ? creatures.paths?.[guid] : move === -2 ? creatures.templatePaths?.[entry] : undefined;
			const movement: SpawnMovement | undefined = move > 0 || (points && points.length >= 8)
				? { speed: WALK_SPEED * (walk || 1), orientation: o, wander: Math.max(0, move), path: points ? continentPath(points) : [] }
				: undefined;
			const spawn = creatureSpawn(this.mapId, guid, entry, t, x, y, z, o, lookups);
			if (spawn) add(x, y, { ...spawnPlacement(spawn), movement });
		}
		for (const [guid, entry, x, y, z, o, qx, qy, qz, qw] of objects.spawns) {
			const t = objects.templates[entry];
			const spawn = t && objectSpawn(this.mapId, guid, entry, t, x, y, z, o, qx || qy || qz || qw ? [qx, qy, qz, qw] : undefined, pages);
			if (spawn) add(x, y, spawnPlacement(spawn));
		}
	}
}

/** Resolves creature and game object display IDs to model files, textures and scale. */
export class DisplayResolver {
	private tables: Promise<{
		creatureDisplay: Awaited<ReturnType<typeof loadTable>>;
		creatureModel: Awaited<ReturnType<typeof loadTable>>;
		displayExtra: Awaited<ReturnType<typeof loadTable>>;
		objectDisplay: Awaited<ReturnType<typeof loadTable>>;
		factions: Awaited<ReturnType<typeof loadTable>>;
		materials: Map<number, number>;
	}> | null = null;

	constructor(private readonly storage: GameStorage) {}

	private load() {
		this.tables ??= (async () => {
			const [creatureDisplay, creatureModel, displayExtra, objectDisplay, textureFiles, factions] = await Promise.all([
				loadTable(this.storage, DISPLAY_FILES.CreatureDisplayInfo),
				loadTable(this.storage, DISPLAY_FILES.CreatureModelData),
				loadTable(this.storage, DISPLAY_FILES.CreatureDisplayInfoExtra),
				loadTable(this.storage, DISPLAY_FILES.GameObjectDisplayInfo),
				loadTable(this.storage, DISPLAY_FILES.TextureFileData),
				loadTable(this.storage, DISPLAY_FILES.FactionTemplate),
			]);
			// Material resources ID -> texture file (TextureFileData: ID is the file, field 2 the material).
			const materials = new Map<number, number>();
			for (const fdid of textureFiles.ids()) {
				const material = textureFiles.getInt(fdid, 2);
				if (material && !materials.has(material)) materials.set(material, fdid);
			}
			return { creatureDisplay, creatureModel, displayExtra, objectDisplay, factions, materials };
		})();
		return this.tables;
	}

	/** Model scale from CreatureDisplayInfo, needed before the model itself loads. */
	async scaleLookup(): Promise<(displayId: number) => number> {
		const { creatureDisplay } = await this.load();
		return (id) => creatureDisplay.getFloat(id, 4) || 1;
	}

	/**
	 * How a faction template reacts to each side, from FactionTemplate (field 2 FactionGroup,
	 * 3 FriendGroup, 4 EnemyGroup; group bits 1 player, 2 Alliance, 4 Horde, 8 monster).
	 */
	async reactionLookup(): Promise<ReactionLookup> {
		const { factions } = await this.load();
		const toSide = (group: number, friend: number, enemy: number, side: number): Reaction =>
			enemy & (side | FACTION_PLAYER) ? 'hostile' : (friend | group) & side ? 'friendly' : 'neutral';
		return (id) => {
			const group = factions.getInt(id, 2) ?? 0;
			const friend = factions.getInt(id, 3) ?? 0;
			const enemy = factions.getInt(id, 4) ?? 0;
			return { alliance: toSide(group, friend, enemy, FACTION_ALLIANCE), horde: toSide(group, friend, enemy, FACTION_HORDE) };
		};
	}

	/**
	 * Model, textures, geosets and gear for a creature look. weapons is [main hand, off hand,
	 * off hand is a shield] as item display IDs, from the spawn data.
	 */
	async creature(displayId: number, weapons: Weapons | null = null): Promise<{ fdid: number; options: M2Options } | null> {
		const { creatureDisplay, creatureModel, displayExtra, materials } = await this.load();
		const modelId = creatureDisplay.getInt(displayId, 1);
		const fdid = modelId ? creatureModel.getInt(modelId, 2) : null;
		if (!fdid) return null;
		const extra = creatureDisplay.getInt(displayId, 7) ?? 0;
		const held = weapons ? await this.weaponAttachments(weapons) : [];
		if (extra && displayExtra.has(extra)) {
			// Humanoid NPCs: a character model with the outfit baked into one texture. Prefer the
			// original (SD) race model with its SD bake; fall back to the HD model the table names.
			const race = displayExtra.getInt(extra, 1) ?? 0;
			const sex = displayExtra.getInt(extra, 2) ?? 0;
			const sd = SD_CHARACTER_MODELS[race]?.[sex];
			const sdBake = materials.get(displayExtra.getInt(extra, 5) ?? 0);
			const [looks, gear] = await Promise.all([this.customization(extra), this.armor(extra, race, sex)]);
			// Gear geosets (gloves, boots, ...) win over appearance ones in the same group.
			const gearGroups = new Set(gear.geosets.map((g) => Math.floor(g / 100)));
			const geosets = [...gear.geosets, ...looks.geosets.filter((g) => !gearGroups.has(Math.floor(g / 100)))];
			const attachments = [...gear.attachments, ...held];
			const cape: Record<number, number> = gear.cape ? { 2: gear.cape } : {};
			if (sd && sdBake && this.storage.status(sd) === 'ok') {
				// SD hair textures are per race and colour (the HD ones don't fit SD geometry). Colours
				// beyond the old set fall back to the first.
				const hairSet = (await this.hairTextures())[race];
				const hair = hairSet?.[looks.hairColor] ?? hairSet?.[0] ?? 0;
				return { fdid: sd, options: { textures: { 1: sdBake, 6: hair, ...cape }, geosets, attachments, defaultGeosets: true, stand: true } };
			}
			const bake = materials.get(displayExtra.getInt(extra, 6) ?? 0) ?? sdBake ?? 0;
			return { fdid, options: { textures: { 1: bake, 6: looks.hdHair, ...cape }, geosets, attachments, defaultGeosets: true, stand: true } };
		}
		const skins = [0, 1, 2].map((k) => creatureDisplay.getInt(displayId, 27, k) ?? 0);
		return { fdid, options: { textures: { 11: skins[0], 12: skins[1], 13: skins[2] }, attachments: held, defaultGeosets: true, stand: true } };
	}

	private itemTables: Promise<{ items: Db2; byResource: Map<number, number[]>; components: Db2; materials: Map<number, number>; helmetHides: Map<number, [number, number][]> }> | null = null;

	private loadItems() {
		this.itemTables ??= (async () => {
			const [items, modelFiles, components, helmetData, base] = await Promise.all([
				loadTable(this.storage, DISPLAY_FILES.ItemDisplayInfo),
				loadTable(this.storage, DISPLAY_FILES.ModelFileData),
				loadTable(this.storage, DISPLAY_FILES.ComponentModelFileData),
				loadTable(this.storage, DISPLAY_FILES.HelmetGeosetData),
				this.load(),
			]);
			// HelmetGeosetData (parent = a helmet's hide rule, ItemDisplayInfo field 15): [race, geoset group it hides].
			const helmetHides = new Map<number, [number, number][]>();
			for (const id of helmetData.ids()) {
				const rule = helmetData.getParent(id) ?? 0;
				const list = helmetHides.get(rule) ?? [];
				list.push([helmetData.getInt(id, 0) ?? 0, helmetData.getInt(id, 1) ?? 0]);
				helmetHides.set(rule, list);
			}
			// ModelFileData: model resources ID (field 4) -> the files that implement it.
			const byResource = new Map<number, number[]>();
			for (const file of modelFiles.ids()) {
				const resource = modelFiles.getInt(file, 4) ?? 0;
				const list = byResource.get(resource) ?? [];
				list.push(file);
				byResource.set(resource, list);
			}
			return { items, byResource, components, materials: base.materials, helmetHides };
		})();
		return this.itemTables;
	}

	/**
	 * The file for an item model resource: the one made for this race and sex (and shoulder side)
	 * according to ComponentModelFileData (0 sex, 2 race, 3 side), else any.
	 */
	private async itemModel(resource: number, race = 0, sex = 0, side = -1): Promise<number> {
		const { byResource, components } = await this.loadItems();
		const files = (byResource.get(resource) ?? []).filter((f) => this.storage.status(f) === 'ok');
		const score = (f: number) => {
			if (!components.has(f)) return 1;
			const fSex = components.getInt(f, 0) ?? 0, fRace = components.getInt(f, 2) ?? 0, fSide = components.getInt(f, 3) ?? -1;
			if (side >= 0 && fSide !== -1 && fSide !== side) return -1;
			return (fRace === race ? 4 : fRace === 0 ? 1 : 0) + (fSex === sex ? 2 : fSex > 1 ? 1 : 0);
		};
		let best = 0;
		let bestScore = -1;
		for (const f of files) {
			const sc = score(f);
			if (sc > bestScore) {
				best = f;
				bestScore = sc;
			}
		}
		return best;
	}

	/** Weapons held in the hands (or a shield on the arm). */
	private async weaponAttachments([mainHand, offHand, offHandIsShield]: Weapons): Promise<GearAttachment[]> {
		const { items, materials } = await this.loadItems();
		const out: GearAttachment[] = [];
		const add = async (display: number, point: number) => {
			if (!display || !items.has(display)) return;
			const fdid = await this.itemModel(items.getInt(display, 10, 0) ?? 0);
			if (fdid) out.push({ point, fdid, texture: materials.get(items.getInt(display, 11, 0) ?? 0) ?? 0 });
		};
		await add(mainHand, ATTACH_HAND_RIGHT);
		await add(offHand, offHandIsShield ? ATTACH_SHIELD : ATTACH_HAND_LEFT);
		return out;
	}

	/**
	 * A humanoid NPC's armour (NPCModelItemSlotDisplayInfo, parent = display extra): helmet and
	 * shoulder models at their attachment points, and the geosets other gear switches on
	 * (ItemDisplayInfo.GeosetGroup, field 13). A helmet hides what its own rule says for the
	 * race (HelmetGeosetData): a hood the hair, a mask only the beard, a bandana nothing.
	 */
	private async armor(extra: number, race: number, sex: number): Promise<{ attachments: GearAttachment[]; geosets: number[]; cape: number }> {
		const { items, materials, helmetHides } = await this.loadItems();
		const slots = await this.itemSlots();
		const attachments: GearAttachment[] = [];
		const geosets: number[] = [];
		let cape = 0;
		for (const [display, slot] of slots.get(extra) ?? []) {
			if (!items.has(display)) continue;
			const group = (k: number) => items.getInt(display, 13, k) ?? 0;
			const texture = (k: number) => materials.get(items.getInt(display, 11, k) ?? 0) ?? 0;
			const setGeoset = (base: number, value: number) => {
				if (value > 0) geosets.push(base + 1 + value);
			};
			switch (slot) {
				case SLOT_HEAD: {
					const fdid = await this.itemModel(items.getInt(display, 10, 0) ?? 0, race, sex);
					if (fdid) {
						attachments.push({ point: ATTACH_HELM, fdid, texture: texture(0) });
						// Field 15: the hide rule for each sex. Hidden, a group shows its bare default
						// (variant 1: no beard, no ears); the hair has none, so it gets no variant at all.
						const rule = items.getInt(display, HELMET_RULE, sex) ?? 0;
						for (const [r, group] of helmetHides.get(rule) ?? []) {
							if (r === race) geosets.push(group === 0 ? HIDE_HAIR : group * 100 + 1);
						}
					}
					break;
				}
				case SLOT_SHOULDER: {
					// Two models (or one resource with a left and a right file); side 0 left, 1 right.
					const left = await this.itemModel(items.getInt(display, 10, 0) ?? 0, race, sex, 0);
					const right = await this.itemModel(items.getInt(display, 10, 1) || (items.getInt(display, 10, 0) ?? 0), race, sex, 1);
					if (left) attachments.push({ point: ATTACH_SHOULDER_LEFT, fdid: left, texture: texture(0) });
					if (right) attachments.push({ point: ATTACH_SHOULDER_RIGHT, fdid: right, texture: texture(1) || texture(0) });
					break;
				}
				case SLOT_SHIRT:
				case SLOT_CHEST:
					setGeoset(800, group(0)); // sleeves
					setGeoset(1000, group(1)); // chest
					setGeoset(1300, group(2)); // robe skirt
					break;
				case SLOT_BELT:
					setGeoset(1800, group(0));
					break;
				case SLOT_LEGS:
					setGeoset(900, group(0)); // knee pads
					setGeoset(1300, group(2));
					break;
				case SLOT_FEET:
					setGeoset(500, group(0));
					break;
				case SLOT_HANDS:
					setGeoset(400, group(0));
					break;
				case SLOT_TABARD:
					setGeoset(1200, group(0));
					break;
				case SLOT_BACK:
					geosets.push(1500 + 1 + Math.max(1, group(0)));
					cape = texture(0);
					break;
			}
		}
		return { attachments, geosets, cape };
	}

	private slotIndex: Promise<Map<number, [number, number][]>> | null = null;

	/** NPCModelItemSlotDisplayInfo by display extra: [item display, slot]. */
	private itemSlots(): Promise<Map<number, [number, number][]>> {
		this.slotIndex ??= loadTable(this.storage, DISPLAY_FILES.NPCModelItemSlotDisplayInfo).then((table) => {
			const byExtra = new Map<number, [number, number][]>();
			for (const id of table.ids()) {
				const extra = table.getParent(id);
				if (extra === null) continue;
				const list = byExtra.get(extra) ?? [];
				list.push([table.getInt(id, 0) ?? 0, table.getInt(id, 1) ?? 0]);
				byExtra.set(extra, list);
			}
			return byExtra;
		});
		return this.slotIndex;
	}
	private customizationTables: Promise<{
		optionsByExtra: Map<number, [number, number][]>;
		elementsByChoice: Map<number, number[]>;
		element: Db2;
		geoset: Db2;
		choice: Db2;
		option: Db2;
		material: Db2;
	}> | null = null;

	private loadCustomization() {
		this.customizationTables ??= (async () => {
			const [displayOption, option, choice, element, geoset, material] = await Promise.all([
				DISPLAY_FILES.CreatureDisplayInfoOption, DISPLAY_FILES.ChrCustomizationOption, DISPLAY_FILES.ChrCustomizationChoice,
				DISPLAY_FILES.ChrCustomizationElement, DISPLAY_FILES.ChrCustomizationGeoset, DISPLAY_FILES.ChrCustomizationMaterial,
			].map((f) => loadTable(this.storage, f)));
			// CreatureDisplayInfoOption: (option, choice) rows whose parent is the display extra.
			const optionsByExtra = new Map<number, [number, number][]>();
			for (const id of displayOption.ids()) {
				const extra = displayOption.getParent(id);
				if (extra === null) continue;
				const list = optionsByExtra.get(extra) ?? [];
				list.push([displayOption.getInt(id, 0) ?? 0, displayOption.getInt(id, 1) ?? 0]);
				optionsByExtra.set(extra, list);
			}
			// ChrCustomizationElement field 0 is the choice it belongs to.
			const elementsByChoice = new Map<number, number[]>();
			for (const id of element.ids()) {
				const c = element.getInt(id, 0) ?? 0;
				const list = elementsByChoice.get(c) ?? [];
				list.push(id);
				elementsByChoice.set(c, list);
			}
			return { optionsByExtra, elementsByChoice, element, geoset, choice, option, material };
		})();
		return this.customizationTables;
	}

	/**
	 * An NPC's appearance choices (CreatureDisplayInfoOption -> ChrCustomizationChoice ->
	 * ChrCustomizationElement): the geosets they turn on (group * 100 + variant: hairstyle,
	 * facial hair, ears, ...) and the hair colour's index in its option.
	 */
	private async customization(extra: number): Promise<{ geosets: number[]; hairColor: number; hdHair: number }> {
		const [{ optionsByExtra, elementsByChoice, element, geoset, choice, option, material }, { materials }] = await Promise.all([this.loadCustomization(), this.load()]);
		const picks = optionsByExtra.get(extra) ?? [];
		const chosen = new Set(picks.map(([, c]) => c));
		const geosets: number[] = [];
		let hairColor = 0;
		let hdHair = 0;
		for (const [optionId, choiceId] of picks) {
			// Choice field 5 is its order within the option, which matches the old colour index.
			const optionName = option.getString(optionId, 0);
			if (optionName === 'Hair Color') hairColor = choice.getInt(choiceId, 5) ?? 0;
			for (const e of elementsByChoice.get(choiceId) ?? []) {
				// Some elements only apply together with another choice (field 1).
				const related = element.getInt(e, 1) ?? 0;
				if (related && !chosen.has(related)) continue;
				// HD models: the hairstyle's material for the chosen colour is the hair texture.
				const materialId = element.getInt(e, 4) ?? 0;
				if (optionName === 'Hair Style' && related && material.has(materialId)) {
					hdHair = materials.get(material.getInt(materialId, 1) ?? 0) ?? hdHair;
				}
				const geosetId = element.getInt(e, 2) ?? 0;
				if (!geosetId || !geoset.has(geosetId)) continue;
				geosets.push((geoset.getInt(geosetId, 0) ?? 0) * 100 + (geoset.getInt(geosetId, 1) ?? 0));
			}
		}
		return { geosets, hairColor, hdHair };
	}

	private hair: Promise<Record<number, number[]>> | null = null;

	/** SD hair textures by race and colour, from public/spawns/hair.json (built from the listfile). */
	private hairTextures(): Promise<Record<number, number[]>> {
		this.hair ??= fetch(spawnFile('hair.json')).then((r) => (r.ok ? r.json() : {}), () => ({}));
		return this.hair;
	}

	async object(displayId: number): Promise<number | null> {
		const { objectDisplay } = await this.load();
		return objectDisplay.getInt(displayId, 1) || null;
	}
}

/**
 * Original (pre-HD) character models by ChrRaces ID, [male, female] (file IDs from the community
 * listfile: character/<race>/<sex>/<race><sex>.m2). The display tables point at the HD models.
 */
const SD_CHARACTER_MODELS: Record<number, [number, number]> = {
	1: [119940, 119563], // human
	2: [121287, 121087], // orc
	3: [118355, 118135], // dwarf
	4: [120791, 120590], // night elf
	5: [121768, 121608], // undead
	6: [122055, 121961], // tauren
	7: [119159, 119063], // gnome
	8: [122560, 122414], // troll
	9: [119376, 119369], // goblin
	10: [117170, 116921], // blood elf
	11: [117721, 117437], // draenei
	12: [118653, 118652], // fel orc
	14: [117412, 117400], // broken
	15: [121942, 121941], // skeleton
	18: [118798, 118798], // forest troll
};

/** Client tables for display lookups (file IDs from the community listfile). */
export const DISPLAY_FILES = {
	CreatureDisplayInfo: 1108759,
	CreatureDisplayInfoExtra: 1264997,
	CreatureModelData: 1365368,
	GameObjectDisplayInfo: 1266277,
	TextureFileData: 982459,
	FactionTemplate: 1361579,
	CreatureDisplayInfoOption: 3692043,
	ChrCustomizationOption: 3384247,
	ChrCustomizationChoice: 3450554,
	ChrCustomizationElement: 3512765,
	ChrCustomizationGeoset: 3456171,
	ChrCustomizationMaterial: 3459652,
	NPCModelItemSlotDisplayInfo: 1340661,
	ItemDisplayInfo: 1266429,
	HelmetGeosetData: 2821752,
	ModelFileData: 1337833,
	ComponentModelFileData: 1349053,
} as const;

/** NPCModelItemSlotDisplayInfo slots. */
const SLOT_HEAD = 0;
const SLOT_SHOULDER = 1;
const SLOT_SHIRT = 2;
const SLOT_CHEST = 3;
const SLOT_BELT = 4;
const SLOT_LEGS = 5;
const SLOT_FEET = 6;
const SLOT_HANDS = 8;
const SLOT_TABARD = 9;
const SLOT_BACK = 10;
/** A group-0 geoset no model has: choosing it hides every hairstyle (under a hood or helm). */
const HIDE_HAIR = 99;
/** ItemDisplayInfo field 15: a helmet's HelmetGeosetData rule for male and female wearers. */
const HELMET_RULE = 15;

/** [main hand, off hand, off hand is a shield] as item display IDs. */
export type Weapons = [number, number, number];

/** The weapons encoded in a placement variant (see SpawnSource and spawnPlacement). */
export function parseWeapons(variant: string | undefined): Weapons | null {
	const parts = variant?.split('@')[0].split('_').map(Number);
	return parts?.length === 3 && parts.every(Number.isFinite) ? (parts as Weapons) : null;
}

/** The pose encoded in a placement variant (weapons@pose), or 0 for Stand. */
export function parsePose(variant: string | undefined): number {
	return Number(variant?.split('@')[1]) || 0;
}

const FACTION_PLAYER = 1;
const FACTION_ALLIANCE = 2;
const FACTION_HORDE = 4;

