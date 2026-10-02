import { LIGHT_COLORS, type LightingData, type LightKey, type LightZone } from '../explorer/lighting';
import type { Dbc } from './dbc';
import { readDbc } from './vanillaTables';
import type { VanillaStorage } from './vanillaStorage';

/**
 * The original client's lighting: Light.dbc places light zones, each naming a LightParams set;
 * a set's colours are 18 LightIntBand rows and its fog 6 LightFloatBand rows, each a day curve
 * of up to 16 keys (time in half-minutes, value). Made here into the modern keyframes.
 */

/** Light.dbc stores positions as yards x 36 from a corner of the map; world coordinates from the middle. */
const LIGHT_ORIGIN = 17066.666;
const LIGHT_UNITS = 36;
const INT_BANDS = 18;
const FLOAT_BANDS = 6;
/** Which colour band each of LIGHT_COLORS is (band 8, a shadow colour, has no counterpart). */
const COLOR_BANDS = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const FOG_END_BAND = 0;
const FOG_SCALER_BAND = 1;
const DAY = 2880;
/**
 * How far the sunlight colour is pulled toward a grey of the same brightness. 1.12's sunlight is
 * much more saturated than the same lights in the remastered client (noon ff8800 against
 * eabd8a, the ambient alike), whose look the lighting here is tuned to; raw, it turns everything
 * orange.
 */
const DIRECT_DESATURATE = 0.5;

interface Band {
	times: number[];
	values: number[];
}

/** Band row: 1 key count, 2-17 times, 18-33 values. */
function readBand(table: Dbc, id: number, float: boolean): Band | null {
	const count = Math.min(16, table.getInt(id, 1) ?? 0);
	if (count <= 0) return null;
	const times = Array.from({ length: count }, (_, k) => table.getInt(id, 2 + k) ?? 0);
	const values = Array.from({ length: count }, (_, k) => (float ? table.getFloat(id, 18 + k) : table.getInt(id, 18 + k)) ?? 0);
	return { times, values };
}

/** A colour moved part way toward the grey of its own brightness. */
function desaturate(c: number, amount: number): number {
	const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
	const grey = 0.299 * r + 0.587 * g + 0.114 * b;
	const mix = (v: number) => Math.round(v + (grey - v) * amount);
	return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/** A band's value at a time of day, wrapping round midnight; colours blend per channel. */
function sample(band: Band | null, time: number, color: boolean): number {
	if (!band) return 0;
	const { times, values } = band;
	if (times.length === 1) return values[0];
	let next = times.findIndex((t) => t > time);
	if (next < 0) next = 0;
	const prev = (next + times.length - 1) % times.length;
	const t0 = times[prev];
	const t1 = next === 0 && prev === times.length - 1 ? times[next] + DAY : times[next];
	const at = time < t0 ? time + DAY : time;
	const f = t1 === t0 ? 0 : (at - t0) / (t1 - t0);
	const a = values[prev], b = values[next];
	if (!color) return a + (b - a) * f;
	let out = 0;
	for (let shift = 0; shift <= 16; shift += 8) {
		const ca = (a >> shift) & 0xff, cb = (b >> shift) & 0xff;
		out |= Math.round(ca + (cb - ca) * f) << shift;
	}
	return out;
}

export async function loadVanillaLighting(storage: VanillaStorage, mapIds: number[]): Promise<LightingData> {
	const [lights, ints, floats] = await Promise.all([readDbc(storage, 'Light'), readDbc(storage, 'LightIntBand'), readDbc(storage, 'LightFloatBand')]);
	const zones: LightZone[] = [];
	for (const id of lights.ids()) {
		const mapId = lights.getInt(id, 1) ?? -1;
		const params = lights.getInt(id, 7) ?? 0;
		if (!mapIds.includes(mapId) || !params) continue;
		const outer = (lights.getFloat(id, 6) ?? 0) / LIGHT_UNITS;
		// A zone without a radius is the map's global light; its position means nothing.
		const pos = (column: number) => (outer ? LIGHT_ORIGIN - (lights.getFloat(id, column) ?? 0) / LIGHT_UNITS : 0);
		zones.push({
			mapId,
			x: pos(4),
			y: pos(2),
			z: (lights.getFloat(id, 3) ?? 0) / LIGHT_UNITS,
			inner: (lights.getFloat(id, 5) ?? 0) / LIGHT_UNITS,
			outer,
			params,
		});
	}

	const keys: Record<number, LightKey[]> = {};
	for (const params of new Set(zones.map((z) => z.params))) {
		const colorBands = COLOR_BANDS.map((b) => readBand(ints, (params - 1) * INT_BANDS + 1 + b, false));
		const fogEnd = readBand(floats, (params - 1) * FLOAT_BANDS + 1 + FOG_END_BAND, true);
		const fogScaler = readBand(floats, (params - 1) * FLOAT_BANDS + 1 + FOG_SCALER_BAND, true);
		// A keyframe wherever any of its curves has a key.
		const times = new Set<number>();
		for (const band of [...colorBands, fogEnd, fogScaler]) for (const t of band?.times ?? []) times.add(t);
		if (!times.size) continue;
		keys[params] = [...times].sort((a, b) => a - b).map((time) => ({
			time,
			colors: LIGHT_COLORS.map((name, i) => {
				const color = sample(colorBands[i], time, true);
				return name === 'direct' ? desaturate(color, DIRECT_DESATURATE) : color;
			}),
			// In the same units as the modern table's (yards x 36).
			fogEnd: sample(fogEnd, time, false),
			fogScaler: sample(fogScaler, time, false),
			grading: 0,
			fogDensity: 1,
		}));
	}
	return { zones, keys };
}
