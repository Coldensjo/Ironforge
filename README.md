# Ironforge

A world editor for World of Warcraft Classic: move, place, pose and delete NPCs, objects, props and buildings, and shape the ground, in an editor drawn with the game's own interface. It grew out of [MapExplorer](https://github.com/Coldensjo/ClassicWowMapExplorer), whose explorer it still includes (Tab switches between the two), and like it reads everything from your own game install.

Work happens in **projects**. The launcher opens your last one, starts a new one (in the **sandbox**, a large field of grass to build on, or in **Azeroth**, the game's own world), or opens a saved one; File has New, Open, Save (Ctrl+S) and Save As (Ctrl+Shift+S). The desktop app saves projects as `.ironforge` files; the browser keeps them in its own storage, and can open project files too.

Fly over the World of Warcraft world, drawn from your own game install. Everything is read straight from the game files on your computer; nothing is hosted, uploaded or downloaded.

Built for WoW Classic, with Eastern Kingdoms and Kalimdor loaded as one seamless world.

## Get started on Windows

You need **Windows 10 or 11** and **World of Warcraft Classic** installed. Nothing else to install.
On Linux, see **[Get started on Linux](#get-started-on-linux)**.

1. Download **MapExplorer-portable.zip** from the
   **[latest release](https://github.com/Coldensjo/ClassicWowMapExplorer/releases/latest)** and unzip
   it anywhere.
2. Double-click **MapExplorer.exe**. Map Explorer opens in a window of its own.
   The first time, Windows may say *"Windows protected your PC"*, because the program isn't signed:
   click **More info**, then **Run anyway**.
3. It finds World of Warcraft by itself and the world opens. If it can't find it, click
   **Choose your World of Warcraft folder** (or drag the folder onto the window) and pick the
   folder that contains `_classic_` or `_classic_beta_`, usually
   `C:\Program Files (x86)\World of Warcraft`. The window calls it an upload, but the files never
   leave your computer.

Click to look around, fly with **W A S D**, and hold **Shift** to go faster.
Close the window when you're done.

### About the portable version

- **It's portable**: no installer and no admin rights. Keep `MapExplorer.exe` next to its `app`
  folder; to remove it, delete the folder.
- **Its own window**: the window is Microsoft Edge (or Chrome, if Edge is missing) in app mode,
  showing Map Explorer with no tabs or address bar. `MapExplorer.exe` serves the `app` folder to it
  at `http://127.0.0.1:51730`, reachable from this computer only, and stops when you close the
  window.
- **Finding the game**: it looks where World of Warcraft's installer says it is, then in the usual
  folders on each hard drive, and serves only the game's `.build.info` and `Data` folder to the
  window, read as they are.
- **Its own settings**: highlights and other settings are kept in a `data` folder beside it, apart
  from your own browser (in `%LOCALAPPDATA%\MapExplorer` if its folder is read-only).
- **Opening it again** while it's running opens another window onto the same Map Explorer.

### Running from source

On any system with Chrome or Edge, and **[Node.js](https://nodejs.org)** (the LTS version):

1. `git clone https://github.com/Coldensjo/ClassicWowMapExplorer.git` (or **Code → Download ZIP**)
2. In the project folder, run `npm install`, then `npm run dev`.
3. Open **http://localhost:5173** in Chrome or Edge. The dev server finds World of Warcraft as the
   portable version does (set `WOW_DIR` to point it elsewhere); if it can't, choose the folder as above.

## Get started on Linux

There's no portable version for Linux; Map Explorer runs from source instead. You need
**World of Warcraft Classic** installed through Wine, Lutris, Bottles, Steam (Proton) or Heroic,
a Chromium-based browser (**Chrome**, **Chromium**, **Edge** or **Brave**), **git**, and
**[Node.js](https://nodejs.org)** 22.12 or newer.

1. Install git and Node.js. Many distributions ship an older Node.js, so check with `node -v`; if
   it's older than 22.12, install the current LTS from [nodejs.org](https://nodejs.org/en/download) or with
   [nvm](https://github.com/nvm-sh/nvm):

   ```sh
   # Debian / Ubuntu
   sudo apt install git nodejs npm
   # Fedora
   sudo dnf install git nodejs npm
   # Arch
   sudo pacman -S git nodejs npm
   ```

2. Download Map Explorer and its packages:

   ```sh
   git clone https://github.com/Coldensjo/ClassicWowMapExplorer.git
   cd ClassicWowMapExplorer
   npm install
   ```

3. Start it:

   ```sh
   npm run dev
   ```

   It looks for World of Warcraft in your Wine prefixes: `$WINEPREFIX`, `~/.wine`, `~/Games`
   (Lutris), the prefixes in Lutris's game files, Heroic's prefixes, Bottles and Steam's Proton
   prefixes, including their Flatpak versions. It prints where it found the game, or
   *World of Warcraft not found*.

4. Open **http://localhost:5173** in your browser and the world opens.

If it doesn't find the game, point it at the folder that contains `_classic_` or `_classic_beta_`:

```sh
WOW_DIR="$HOME/Games/battlenet/drive_c/Program Files (x86)/World of Warcraft" npm run dev
```

or click **Choose your World of Warcraft folder** in the page and pick it there.

Press **Ctrl+C** in the terminal to stop it. To update later, run `git pull` and `npm install` in the
`ClassicWowMapExplorer` folder.

## Features

- The whole world at once: distant terrain for both continents, with full detail streamed in around you
- Terrain textures, water and other liquids, with the game's underwater look and sound
- Buildings and props placed as in the game, with animated fire, smoke and sparks
- Ground clutter: the grass, flowers and pebbles that grow on each terrain texture, swaying in the wind
- Sky, fog and lighting from the game's own light data, with a time-of-day control
- Zone names and zone music, including inside inns, Ironforge and other buildings
- Creatures and objects from VMaNGOS: clickable, with Wowhead links, name plates, their gear and
  animations, walking their patrols
- Every other map in the install (dungeons, raids, battlegrounds, unused and test maps) laid out in
  the sea south of the continents, optionally named from afar, to fly to or walk into through their entrances
- Highlights for chests, herbs, ore veins, fishing pools or anything by name, seen from afar
- A minimap from the game's own map images, and a search to go to any zone, town or map

## Controls

| Key | Action |
| --- | --- |
| Click | Capture the mouse to look around, or open info on a creature or object |
| W A S D / arrows | Move |
| Space / E, C / Q | Up, down |
| Shift | Move faster |
| G | Go through walls, floors and the ground on / off |
| Mouse wheel | Zoom |
| 1, 2 | Jump to a continent |
| O | Overview of the whole world |
| R | Return to the start position |
| T / Shift+T | Time of day forward / back |
| N | Reset time to the local clock |
| L | Torch light on / off |
| V | Ground clutter (grass, flowers, pebbles) on / off |
| F | Switch name plate colours between Alliance and Horde |
| M | Music and sound on / off |
| I | Names of dungeons, raids and other maps in the sea on / off (off by default) |
| H | Highlights on / off |
| / | Go to a zone, town or map |
| K | Performance stats on / off |
| P | Screenshot, with everything in view loaded in full detail |
| U or Alt+Z | Hide / show the interface |
| ? or F1 | List of controls |

Every key that switches something shows what it did, low in the middle of the screen. All of them are
also under **View** and **Sound** at the bottom right, which remember your choices between visits.

**Go to** (top right, or press /) finds any zone, town or landmark by name, and every map in the
install, including ones nothing leads to. Empty, it lists the maps by kind. The other maps also sit
in rows in the sea south of the continents, with their names floating over them (press I), so you can fly there.
Maps that are a single building (most dungeons) lie under the sea until you fly over them.

The **minimap** above it shows the game's own map around you, north up. Click it to fly there, and
zoom it with the wheel or its + and − buttons.

**Highlight** (bottom right) marks chests, herbs, ore and fishing pools within 1000 yards, through
terrain and buildings; typing a name marks every creature or object with that name on the map, however far away.
The spawn data lists every place a herb or vein can appear, so there are more marks than nodes up at any one time.

The camera position is kept in the URL, so a link brings you back to the same spot; click the coordinates
(top left) to copy it. Add `?time=HH:MM` to set the time of day.

## Troubleshooting

- **"That isn't the World of Warcraft folder"**: pick the folder one level up, the one that
  contains `_classic_` or `_classic_beta_`.
- **Direct access** (under *More options*) opens faster, but Chrome and Edge refuse folders under
  `Program Files`; use the main button for those.
- If nothing shows up, check that you're in Chrome or Edge with hardware acceleration on (for the
  portable version: Edge's *Settings → System and performance*), and that your graphics driver is
  up to date.
- **The portable version opened in a normal browser tab**: neither Edge nor Chrome was found, so
  your default browser is used. Press OK in the small Map Explorer message when you're done, to stop it.
- **"No free port between 51730 and 51749"**: other programs are using those ports; close them or
  restart your computer.

## For developers

### Desktop app

Ironforge also runs as a desktop app (Electron), which finds the game by itself and saves and opens files with the usual Windows dialogs:

```sh
npm run desktop       # build and run it
npm run desktop:dev   # the dev server in the app's window, reloading as you edit
npm run desktop:pack  # Ironforge Setup <version>.exe and a portable .exe, in release-desktop/
```

The app (`electron/main.ts`) serves the page and the game install from `app://ironforge/`, the install under `__wow/` as the dev server does, so the page reads it the same way; `electron/preload.cts` gives the page its folder and file dialogs (`src/app/desktop.ts`). It keeps its own saved edits, apart from the browser's.


### Spawn data

Creature and object spawns, patrols and dungeon entrances in `public/spawns` come from the [VMaNGOS](https://github.com/vmangos/core) world database. To rebuild them, download the SQLite database from the VMaNGOS `db_latest` release and run:

```sh
npm run spawns -- path/to/mangos.sqlite
```

This needs `sqlite3` on the PATH. NPC hair textures come from the community listfile, expected at `.cache/listfile.csv`.

The world editor's palette of map models (props and buildings) is `public/spawns/models.json`, built from the same listfile, keeping only the models your install has:

```sh
npm run models -- [wowDir] [product]
```

### Scripts

- `npm run dev`: start the dev server
- `npm run build`: type-check and build to `dist`
- `npm run typecheck`: type-check only
- `npm run probe`: inspect game data from Node
- `npm run spawns`: rebuild the spawn files
- `npm run desktop`, `desktop:dev`, `desktop:pack`: the desktop app (see above)
- `npm run models`: rebuild the editor's palette of map models
- `npm run portable`: build the portable version into `release/` (the zip for a GitHub release);
  needs mingw-w64 (gcc, windres), ImageMagick and 7-Zip on the PATH. The launcher is
  `tools/portable/launcher.c`, its icon `public/icon.svg`

`inspector.html` is a small test page for browsing the storage and file formats.

### Layout

- `src/casc`: CASC storage reader
- `src/formats`: WoW file formats (ADT, WDT, WDL, WMO, M2, BLP, DB2)
- `src/worker`: storage and parsing in a web worker
- `src/explorer`: world data, meshes, lighting, spawns, music
- `src/viewer`: three.js renderer, controls, particles, audio
- `tools`: Node scripts for probing data and building spawns
