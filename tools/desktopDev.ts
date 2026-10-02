// npm run desktop:dev: the Vite dev server (with the game served under __wow/ and live reloading),
// and the desktop app's window showing it.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5201, strictPort: true } });
await server.listen();
server.printUrls();
const url = server.resolvedUrls?.local[0] ?? 'http://localhost:5201/';
// The electron package's main export is the path of its executable.
const electron = createRequire(import.meta.url)('electron') as string;
// Started from inside VS Code, this is set, and would run Electron as plain Node.
const env: Record<string, string | undefined> = { ...process.env, IRONFORGE_DEV_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ['.'], { stdio: 'inherit', env });
app.on('exit', async (code) => {
	await server.close();
	process.exit(code ?? 0);
});
