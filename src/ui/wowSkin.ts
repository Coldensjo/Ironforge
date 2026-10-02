import type { Image } from '../formats/blp';
import type { AsyncStorageApi } from '../worker/protocol';

/**
 * The game's own interface art, read from the install (nothing of it ships with this app):
 * frames, buttons, checkboxes, slots, the minimap ring, the gauntlet cursor and icons. File IDs
 * from the community listfile, as the classic client has no names for them.
 */
const UI = {
	tooltipBorder: 137057, // interface/tooltips/ui-tooltip-border
	dialogBorder: 131072, // interface/dialogframe/ui-dialogbox-border
	goldBorder: 131076, // interface/dialogframe/ui-dialogbox-gold-border
	dialogBackground: 131071, // interface/dialogframe/ui-dialogbox-background
	marble: 374154, // interface/framegeneral/ui-background-marble
	header: 131080, // interface/dialogframe/ui-dialogbox-header
	buttonUp: 130828, // interface/buttons/ui-panel-button-up
	buttonDown: 130825,
	buttonHighlight: 130826,
	buttonDisabled: 130824,
	checkUp: 130755, // interface/buttons/ui-checkbox-up
	checkDown: 130752,
	check: 130751,
	checkHighlight: 130753,
	closeUp: 130832, // interface/buttons/ui-panel-minimizebutton-up
	closeDown: 130830,
	closeHighlight: 130831,
	input: 130975, // interface/common/common-input-border
	slot: 130841, // interface/buttons/ui-quickslot2
	slotHighlight: 130718, // interface/buttons/buttonhilight-square
	slotChecked: 130724, // interface/buttons/checkbuttonhilight
	listHighlight: 136810, // interface/questframe/ui-questtitlehighlight
	minimapBorder: 136468, // interface/minimap/ui-minimap-border
	cursorPoint: 131028, // interface/cursor/point
	cursorGrab: 462987, // interface/cursor/openhand (pickup, 131027, is the vendor's buy/sell hand)
	scrollKnob: 130849, // interface/buttons/ui-scrollbar-knob
} as const;

/** Icons (interface/icons/*) the editor uses, by name. */
export const ICONS = {
	select: 134441, // inv_misc_spyglass_02
	move: 132307, // ability_rogue_sprint
	rotate: 134063, // inv_misc_gear_01
	scale: 133859, // inv_misc_enggizmos_01
	place: 132762, // inv_crate_02
	remove: 132331, // ability_vanish
	duplicate: 133733, // inv_misc_book_01
	undo: 132181, // ability_hunter_pathfinding
	npc: 134166, // inv_misc_head_human_01
	monster: 134299, // inv_misc_monsterhead_01
	object: 132594, // inv_box_01
	prop: 134181, // inv_misc_herb_01
	building: 134269, // inv_misc_map_01
	note: 134327, // inv_misc_note_01
	unknown: 134400, // inv_misc_questionmark
	// Palette categories and groups.
	nature: 132137, // ability_druid_naturalperfection
	props: 132763, // inv_crate_03
	town: 132327, // ability_townwatch
	effects: 134333, // inv_misc_orb_01
	candle: 133750, // inv_misc_candle_01
	food: 133943, // inv_misc_food_01
	bone: 133718, // inv_misc_bone_01
	book: 133734, // inv_misc_book_02
	recent: 133647, // inv_misc_bag_14
	// Terrain brushes.
	terrain: 136248, // trade_mining
	raise: 136025, // spell_nature_earthquake
	lower: 134435, // inv_misc_shovel_01
	flatten: 133038, // inv_hammer_01
	smooth: 136022, // spell_nature_earthbind
	// Creature types.
	beast: 132203, // ability_hunter_pet_wolf
	dragonkin: 134153, // inv_misc_head_dragon_01
	demon: 136217, // spell_shadow_summonfelhunter
	elemental: 135861, // spell_frost_summonwaterelemental
	undead: 134179, // inv_misc_head_undead_01
	critter: 132192, // ability_hunter_pet_owl
	mechanical: 132247, // ability_mount_mechastrider
	totem: 136098, // spell_nature_stoneskintotem
} as const;

/** The icon for a creature type, by its name as the spawn data labels it. */
export function creatureIcon(kind: string | undefined): IconName {
	const byKind: Record<string, IconName> = {
		Beast: 'beast', Dragonkin: 'dragonkin', Demon: 'demon', Elemental: 'elemental', Giant: 'monster', Undead: 'undead',
		Humanoid: 'npc', Critter: 'critter', Mechanical: 'mechanical', Totem: 'totem',
	};
	return (kind && byKind[kind]) || 'monster';
}
export type IconName = keyof typeof ICONS;

/** The game's fonts: Friz Quadrata (labels, names), Arial Narrow (text), Morpheus (titles). */
const FONTS: [string, number][] = [['Friz Quadrata', 615960], ['Arial Narrow WoW', 615958], ['Morpheus', 615962]];

function canvasOf(image: Image): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = image.width;
	c.height = image.height;
	c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.rgba), image.width, image.height), 0, 0);
	return c;
}

/** A piece of an image (in pixels), as a data URL. */
function crop(image: HTMLCanvasElement, x: number, y: number, w: number, h: number): string {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	c.getContext('2d')!.drawImage(image, x, y, w, h, 0, 0, w, h);
	return c.toDataURL();
}

/**
 * A backdrop as the game draws one, made into a nine-slice image for CSS border-image: the
 * background (tiled texture or flat colour) inset under an edge file. Edge files hold eight
 * square pieces in a row: left, right, top, bottom (both stored upright: turned a quarter
 * clockwise to lie flat), then the top-left, top-right, bottom-left and bottom-right corners.
 */
function backdrop(edge: HTMLCanvasElement, inset: number, background: HTMLCanvasElement | string): string {
	const s = edge.height;
	const size = s * 3;
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const g = c.getContext('2d')!;
	g.fillStyle = typeof background === 'string' ? background : g.createPattern(background, 'repeat')!;
	g.fillRect(inset, inset, size - inset * 2, size - inset * 2);
	const piece = (i: number, x: number, y: number) => g.drawImage(edge, i * s, 0, s, s, x, y, s, s);
	const turned = (i: number, x: number, y: number) => {
		g.save();
		g.translate(x + s, y);
		g.rotate(Math.PI / 2);
		g.drawImage(edge, i * s, 0, s, s, 0, 0, s, s);
		g.restore();
	};
	piece(0, 0, s);
	piece(1, s * 2, s);
	turned(2, s, 0);
	turned(3, s, s * 2);
	piece(4, 0, 0);
	piece(5, s * 2, 0);
	piece(6, 0, s * 2);
	piece(7, s * 2, s * 2);
	return c.toDataURL();
}

const url = (data: string) => `url("${data}")`;

/** Icon data URLs by name, once the skin has loaded (the icons' own 4 px frame trimmed off). */
export const iconUrls = new Map<IconName, string>();

/**
 * Reads the interface art and fonts and hands them to the stylesheet as custom properties on
 * the root (see wow.css). Whatever is missing keeps the plain fallback look. Resolves to whether
 * the frames loaded.
 */
export async function loadWowSkin(storage: AsyncStorageApi): Promise<boolean> {
	const fonts = Promise.all(FONTS.map(async ([family, fdid]) => {
		try {
			document.fonts.add(await new FontFace(family, new Uint8Array(await storage.loadFont(fdid))).load());
		} catch {
			// The fallback font stays.
		}
	}));
	const names = Object.keys(UI) as (keyof typeof UI)[];
	const iconNames = Object.keys(ICONS) as IconName[];
	const images = await storage.loadImages([...names.map((n) => UI[n]), ...iconNames.map((n) => ICONS[n])]);
	const tex: Partial<Record<keyof typeof UI, HTMLCanvasElement>> = {};
	names.forEach((n, i) => {
		const image = images[i];
		if (image) tex[n] = canvasOf(image);
	});
	iconNames.forEach((n, i) => {
		const image = images[names.length + i];
		if (!image) return;
		const c = canvasOf(image);
		const trim = Math.round(c.width * 0.07);
		iconUrls.set(n, crop(c, trim, trim, c.width - trim * 2, c.height - trim * 2));
	});
	await fonts;

	const vars: Record<string, string> = {};
	const set = (name: string, data: string | undefined) => {
		if (data) vars[`--wow-${name}`] = url(data);
	};
	const whole = (c: HTMLCanvasElement | undefined) => c?.toDataURL();
	// Frames: the tooltip's thin silver border on a dark blue, the dialog's heavy one on marble.
	if (tex.tooltipBorder) set('panel', backdrop(tex.tooltipBorder, 4, 'rgba(9, 9, 22, 0.92)'));
	if (tex.dialogBorder) set('dialog', backdrop(tex.dialogBorder, 11, tex.marble ?? tex.dialogBackground ?? 'rgb(12, 12, 14)'));
	if (tex.goldBorder) set('gold', backdrop(tex.goldBorder, 11, tex.dialogBackground ?? 'rgba(0, 0, 0, 0.85)'));
	// The red panel button's drawn part is the top-left 80 x 22 of its 128 x 32 texture.
	for (const [name, key] of [['button', 'buttonUp'], ['button-down', 'buttonDown'], ['button-highlight', 'buttonHighlight'], ['button-disabled', 'buttonDisabled']] as const) {
		const c = tex[key];
		if (c) set(name, crop(c, 0, 0, c.width * 0.625, c.height * 0.6875));
	}
	// The edit box border: 128 x 20 of its 128 x 32, ends 8 px.
	if (tex.input) set('input', crop(tex.input, 0, 0, tex.input.width, tex.input.height * 0.625));
	for (const [name, key] of [['check-up', 'checkUp'], ['check-down', 'checkDown'], ['check', 'check'], ['check-highlight', 'checkHighlight'],
		['close', 'closeUp'], ['close-down', 'closeDown'], ['close-highlight', 'closeHighlight'], ['slot', 'slot'], ['slot-highlight', 'slotHighlight'],
		['slot-checked', 'slotChecked'], ['header', 'header'], ['scroll-knob', 'scrollKnob']] as const) {
		set(name, whole(tex[key]));
	}
	if (tex.listHighlight) set('list-highlight', whole(tex.listHighlight));
	// The minimap ring: the 150 x 150 around a 140 px map at (94, 32) of the texture.
	if (tex.minimapBorder) set('minimap-ring', crop(tex.minimapBorder, 94, 32, 150, 150));
	// The gauntlet, its point at the top left; the open hand while carrying something.
	if (tex.cursorPoint) vars['--wow-cursor'] = `${url(tex.cursorPoint.toDataURL())} 1 1, default`;
	// The hand's palm, its middle.
	if (tex.cursorGrab) vars['--wow-cursor-grab'] = `${url(tex.cursorGrab.toDataURL())} ${tex.cursorGrab.width >> 1} ${tex.cursorGrab.height >> 1}, grab`;

	const root = document.documentElement;
	for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
	root.classList.toggle('wow-skin', !!tex.tooltipBorder);
	return !!tex.tooltipBorder;
}
