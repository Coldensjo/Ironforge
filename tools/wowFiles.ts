// Serves the World of Warcraft install found on this computer under /__wow/ in the dev server,
// as the desktop app and the portable launcher do, so the page opens it without asking for the
// folder. See electron/wowInstall.ts for how it's found.
import { createReadStream } from 'node:fs';
import type { Plugin } from 'vite';
import { byteRange, findWow, PATCH_PATH, wowRequest, writePatch } from '../electron/wowInstall.ts';

const PREFIX = '/__wow/';

export function wowFiles(): Plugin {
	return {
		name: 'wow-files',
		apply: 'serve',
		configureServer(server) {
			const root = findWow();
			server.config.logger.info(root ? `  World of Warcraft: ${root}` : '  World of Warcraft not found; choose the folder in the page (or set WOW_DIR).');
			if (!root) return;
			server.middlewares.use((req, res, next) => {
				if (!req.url?.startsWith(PREFIX)) return next();
				// The editor's map export, put into the game's Data folder.
				if (req.method === 'PUT') {
					if (decodeURIComponent(req.url.slice(PREFIX.length).split('?')[0]) !== PATCH_PATH) {
						res.statusCode = 405;
						return res.end();
					}
					const parts: Buffer[] = [];
					req.on('data', (part: Buffer) => parts.push(part));
					req.on('end', () => {
						const written = writePatch(root, new Uint8Array(Buffer.concat(parts)));
						res.statusCode = written.ok ? 200 : 409;
						res.setHeader('Content-Type', 'text/plain; charset=utf-8');
						res.end(written.ok ? written.path : written.reason);
					});
					return;
				}
				const found = wowRequest(root, decodeURIComponent(req.url.slice(PREFIX.length).split('?')[0]));
				if (!found) {
					res.statusCode = 404;
					return res.end();
				}
				if (found.kind === 'list') {
					res.setHeader('Content-Type', 'text/plain; charset=utf-8');
					return res.end(found.names.join('\n'));
				}
				res.setHeader('Content-Type', 'application/octet-stream');
				res.setHeader('Accept-Ranges', 'bytes');
				res.setHeader('Cache-Control', 'no-cache');
				const range = byteRange(req.headers.range, found.size);
				if (range === 'bad') {
					res.statusCode = 416;
					res.setHeader('Content-Range', `bytes */${found.size}`);
					return res.end();
				}
				const [start, end] = range ?? [0, found.size - 1];
				if (range) {
					res.statusCode = 206;
					res.setHeader('Content-Range', `bytes ${start}-${end}/${found.size}`);
				}
				res.setHeader('Content-Length', String(end - start + 1));
				if (req.method === 'HEAD') return res.end();
				createReadStream(found.path, { start, end }).pipe(res);
			});
		},
	};
}
