import type { ProductInfo } from '../casc/config';
import type { FileSource } from '../casc/source';
import { wdlPath, wdtPath } from '../formats/vanilla';
import { MpqStorage } from './storage';
import { VanillaStorage } from './vanillaStorage';

/** The product name the original client is listed under, beside the modern installs' (wow_classic...). */
export const VANILLA_PRODUCT = 'wow_vanilla';

/**
 * Whether a folder is an original (1.12) client: MPQ archives in Data, and no .build.info (which
 * every modern install has).
 */
export async function isVanillaClient(source: FileSource): Promise<boolean> {
	try {
		await source.openFile(['.build.info']);
		return false;
	} catch {
		// No .build.info: look for the archives.
	}
	try {
		return (await source.listDir(['Data'])).some((n) => /^(dbc|terrain|model)\.mpq$/i.test(n));
	} catch {
		return false;
	}
}

/** How the original client is listed among the folder's game versions. */
export const vanillaProduct: ProductInfo = { product: VANILLA_PRODUCT, version: '1.12', branch: '', active: true, buildKey: '', cdnKey: '' };

export async function openVanilla(source: FileSource): Promise<VanillaStorage> {
	return new VanillaStorage(await MpqStorage.open(source));
}

/** The continents of the original client, their files numbered by the storage. */
export function vanillaContinents(storage: VanillaStorage) {
	return [
		{ name: 'Eastern Kingdoms', directory: 'Azeroth', mapId: 0, wdt: storage.idOf(wdtPath('Azeroth')), wdl: storage.idOf(wdlPath('Azeroth')) },
		{ name: 'Kalimdor', directory: 'Kalimdor', mapId: 1, wdt: storage.idOf(wdtPath('Kalimdor')), wdl: storage.idOf(wdlPath('Kalimdor')) },
	];
}
