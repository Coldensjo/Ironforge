import type { GearAttachment, M2Options } from '../explorer/objects';
import type { Reaction, ReactionLookup, Weapons } from '../explorer/spawns';
import { modelPath } from '../formats/vanilla';
import { ATTACH_HAND_LEFT, ATTACH_HAND_RIGHT, ATTACH_HELM, ATTACH_SHIELD, ATTACH_SHOULDER_LEFT, ATTACH_SHOULDER_RIGHT } from '../formats/m2Pose';
import type { Dbc } from './dbc';
import { readDbc } from './vanillaTables';
import type { VanillaStorage } from './vanillaStorage';

/**
 * Creature and game object looks from the original client's (1.12) tables, as the modern
 * DisplayResolver gives them. Models, textures and gear are named there, not numbered:
 *
 * - CreatureDisplayInfo: 1 model (CreatureModelData), 3 humanoid extra, 4 scale, 6-8 skins
 *   (names in the model's folder).
 * - CreatureModelData: 2 model path.
 * - CreatureDisplayInfoExtra: 1 race, 2 sex, 5 hair style, 6 hair colour, 7 facial hair, 8-17
 *   gear (item displays: head, shoulder, shirt, chest, belt, legs, feet, wrist, hands, tabard),
 *   18 the outfit baked into one texture (Textures\BakedNpcTextures).
 * - CharSections: 1 race, 2 sex, 3 kind (3 hair), 4 variation, 5 colour, 6 texture.
 * - CharHairGeosets: 1 race, 2 sex, 3 style, 4 geoset. CharacterFacialHairStyles (no ID column):
 *   0 race, 1 sex, 2 style, 6-8 geosets of groups 1, 3 and 2.
 * - ItemDisplayInfo: 1-2 models, 3-4 their textures, 7-9 geoset groups.
 * - GameObjectDisplayInfo: 1 model path. FactionTemplate: 3 group, 4 friends, 5 enemies.
 */

const GEAR_SLOTS = 10;
const [SLOT_HEAD, SLOT_SHOULDER, SLOT_SHIRT, SLOT_CHEST, SLOT_BELT, SLOT_LEGS, SLOT_FEET, , SLOT_HANDS, SLOT_TABARD] = Array.from({ length: GEAR_SLOTS }, (_, i) => i);
/** A group-0 geoset no model has: choosing it hides every hairstyle (bald). */
const HIDE_HAIR = 99;
const HAIR_SECTION = 3;
/** Item models' race and sex suffixes (helmets are made per head): ChrRaces ID -> code. */
const RACE_CODES: Record<number, string> = { 1: 'Hu', 2: 'Or', 3: 'Dw', 4: 'Ni', 5: 'Sc', 6: 'Ta', 7: 'Gn', 8: 'Tr' };
const ITEMS = 'Item\\ObjectComponents';

const FACTION_PLAYER = 1;
const FACTION_ALLIANCE = 2;
const FACTION_HORDE = 4;

interface Tables {
	display: Dbc;
	model: Dbc;
	extra: Dbc;
	object: Dbc;
	faction: Dbc;
	items: Dbc;
	/** "race:sex:variation:colour" -> hair texture path. */
	hair: Map<string, string>;
	/** "race:sex:style" -> hair geoset (0 bald). */
	hairGeosets: Map<string, number>;
	/** "race:sex:style" -> facial hair geosets. */
	facialHair: Map<string, number[]>;
}

export class VanillaDisplays {
	private tables: Promise<Tables> | null = null;

	constructor(private readonly storage: VanillaStorage) {}

	private load(): Promise<Tables> {
		this.tables ??= (async () => {
			const s = this.storage;
			const [display, model, extra, object, faction, items, sections, hairGeosets, facialHair] = await Promise.all([
				'CreatureDisplayInfo', 'CreatureModelData', 'CreatureDisplayInfoExtra', 'GameObjectDisplayInfo', 'FactionTemplate',
				'ItemDisplayInfo', 'CharSections', 'CharHairGeosets', 'CharacterFacialHairStyles',
			].map((name) => readDbc(s, name)));
			const hair = new Map<string, string>();
			for (const id of sections.ids()) {
				if (sections.getInt(id, 3) !== HAIR_SECTION) continue;
				const key = [1, 2, 4, 5].map((f) => sections.getInt(id, f)).join(':');
				hair.set(key, sections.getString(id, 6) ?? '');
			}
			const geosets = new Map<string, number>();
			for (const id of hairGeosets.ids()) geosets.set([1, 2, 3].map((f) => hairGeosets.getInt(id, f)).join(':'), hairGeosets.getInt(id, 4) ?? 0);
			// Its first column isn't an ID, so its rows are read in order.
			const beards = new Map<string, number[]>();
			for (const row of facialHair.rows()) {
				const value = (f: number) => facialHair.rowInt(row, f);
				beards.set(`${value(0)}:${value(1)}:${value(2)}`, [100 + Math.max(1, value(6)), 300 + Math.max(1, value(7)), 200 + Math.max(1, value(8))]);
			}
			return { display, model, extra, object, faction, items, hair, hairGeosets: geosets, facialHair: beards };
		})();
		return this.tables;
	}

	private file(path: string): number {
		return path ? this.storage.idOf(path) : 0;
	}

	/** A path's number if the client has the file, else 0. */
	private existing(path: string): number {
		const id = this.file(path);
		return id && this.storage.status(id) === 'ok' ? id : 0;
	}

	async scaleLookup(): Promise<(displayId: number) => number> {
		const { display } = await this.load();
		return (id) => display.getFloat(id, 4) || 1;
	}

	async reactionLookup(): Promise<ReactionLookup> {
		const { faction } = await this.load();
		const toSide = (group: number, friend: number, enemy: number, side: number): Reaction =>
			enemy & (side | FACTION_PLAYER) ? 'hostile' : (friend | group) & side ? 'friendly' : 'neutral';
		return (id) => {
			const group = faction.getInt(id, 3) ?? 0;
			const friend = faction.getInt(id, 4) ?? 0;
			const enemy = faction.getInt(id, 5) ?? 0;
			return { alliance: toSide(group, friend, enemy, FACTION_ALLIANCE), horde: toSide(group, friend, enemy, FACTION_HORDE) };
		};
	}

	async creature(displayId: number, weapons: Weapons | null = null): Promise<{ fdid: number; options: M2Options } | null> {
		const t = await this.load();
		const modelName = t.model.getString(t.display.getInt(displayId, 1) ?? 0, 2);
		if (!modelName) return null;
		const fdid = this.file(modelPath(modelName));
		const held = weapons ? this.weapons(t, weapons) : [];
		const extra = t.display.getInt(displayId, 3) ?? 0;
		if (extra && t.extra.has(extra)) {
			const race = t.extra.getInt(extra, 1) ?? 0;
			const sex = t.extra.getInt(extra, 2) ?? 0;
			const style = t.extra.getInt(extra, 5) ?? 0;
			const bake = this.existing(`Textures\\BakedNpcTextures\\${t.extra.getString(extra, 18) ?? ''}`);
			const hair = this.file(t.hair.get(`${race}:${sex}:${style}:${t.extra.getInt(extra, 6) ?? 0}`) ?? '');
			const gear = this.armor(t, extra, race, sex);
			const hairGeoset = t.hairGeosets.get(`${race}:${sex}:${style}`);
			const looks = [hairGeoset === undefined ? [] : [hairGeoset || HIDE_HAIR], t.facialHair.get(`${race}:${sex}:${t.extra.getInt(extra, 7) ?? 0}`) ?? []].flat();
			// Gear geosets (gloves, boots, ...) win over appearance ones in the same group.
			const gearGroups = new Set(gear.geosets.map((g) => Math.floor(g / 100)));
			const geosets = [...gear.geosets, ...looks.filter((g) => !gearGroups.has(Math.floor(g / 100)))];
			return { fdid, options: { textures: { 1: bake, 6: hair }, geosets, attachments: [...gear.attachments, ...held], defaultGeosets: true, stand: true } };
		}
		// Skins are named in the model's own folder.
		const folder = modelName.slice(0, modelName.lastIndexOf('\\') + 1);
		const skin = (k: number) => {
			const name = t.display.getString(displayId, 6 + k);
			return name ? this.file(`${folder}${name}.blp`) : 0;
		};
		return { fdid, options: { textures: { 11: skin(0), 12: skin(1), 13: skin(2) }, attachments: held, defaultGeosets: true, stand: true } };
	}

	/** An item's model (1 or 2) in a folder, its texture (3 or 4) beside it; null if it has none. */
	private itemModel(t: Tables, display: number, k: number, folders: string[], suffix = ''): GearAttachment | null {
		const name = t.items.getString(display, 1 + k);
		if (!name) return null;
		const base = modelPath(name).replace(/\.m2$/i, '');
		for (const folder of folders) {
			const fdid = this.existing(`${ITEMS}\\${folder}\\${base}${suffix}.m2`);
			if (!fdid) continue;
			const texture = t.items.getString(display, 3 + k);
			return { point: 0, fdid, texture: texture ? this.file(`${ITEMS}\\${folder}\\${texture}.blp`) : 0 };
		}
		return null;
	}

	/** Weapons held in the hands (or a shield on the arm). */
	private weapons(t: Tables, [mainHand, offHand, offHandIsShield]: Weapons): GearAttachment[] {
		const out: GearAttachment[] = [];
		const add = (display: number, point: number) => {
			const model = display && t.items.has(display) ? this.itemModel(t, display, 0, ['Weapon', 'Shield']) : null;
			if (model) out.push({ ...model, point });
		};
		add(mainHand, ATTACH_HAND_RIGHT);
		add(offHand, offHandIsShield ? ATTACH_SHIELD : ATTACH_HAND_LEFT);
		return out;
	}

	/** A humanoid NPC's armour: helmet and shoulder models, and the geosets the rest switch on. */
	private armor(t: Tables, extra: number, race: number, sex: number): { attachments: GearAttachment[]; geosets: number[] } {
		const attachments: GearAttachment[] = [];
		const geosets: number[] = [];
		for (let slot = 0; slot < GEAR_SLOTS; slot++) {
			const display = t.extra.getInt(extra, 8 + slot) ?? 0;
			if (!display || !t.items.has(display)) continue;
			const group = (k: number) => t.items.getInt(display, 7 + k) ?? 0;
			const setGeoset = (base: number, value: number) => {
				if (value > 0) geosets.push(base + 1 + value);
			};
			switch (slot) {
				case SLOT_HEAD: {
					const helm = this.itemModel(t, display, 0, ['Head'], `_${RACE_CODES[race] ?? 'Hu'}${sex ? 'F' : 'M'}`);
					if (helm) attachments.push({ ...helm, point: ATTACH_HELM });
					break;
				}
				case SLOT_SHOULDER: {
					const left = this.itemModel(t, display, 0, ['Shoulder']);
					const right = this.itemModel(t, display, 1, ['Shoulder']);
					if (left) attachments.push({ ...left, point: ATTACH_SHOULDER_LEFT });
					if (right) attachments.push({ ...right, point: ATTACH_SHOULDER_RIGHT });
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
			}
		}
		return { attachments, geosets };
	}

	async object(displayId: number): Promise<number | null> {
		const { object } = await this.load();
		const name = object.getString(displayId, 1);
		return name ? this.file(modelPath(name)) : null;
	}
}
