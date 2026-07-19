import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { parseChordPro } from '../src/lib/parseChordPro';
import { SongData, SongIndexEntry } from '../src/types';

const OUTPUT_BASE = process.env.SONGS_OUTPUT_DIR || 'public/data';
const OUTPUT_BASE_DIR = path.resolve(OUTPUT_BASE);
const OUTPUT_PARENT_DIR = path.dirname(OUTPUT_BASE_DIR);
const OUTPUT_NAME = path.basename(OUTPUT_BASE_DIR);
const OUTPUT_DIR = path.join(OUTPUT_BASE_DIR, 'songs');
const INDEX_PATH = path.join(OUTPUT_BASE_DIR, 'songs.index.json');
const GENERATIONS_DIR = path.join(OUTPUT_PARENT_DIR, `.${OUTPUT_NAME}-generations`);
const JOURNAL_PATH = path.join(GENERATIONS_DIR, '.publish-journal.json');
const RETAINED_PREVIOUS_GENERATIONS = 2;

type PreviousOutput =
  | { kind: 'missing' }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory'; backupGeneration: string };

type PublishJournal = {
  version: 1;
  newGeneration: string;
  temporaryLink: string;
  previous: PreviousOutput;
};

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function pathState(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(dir: string) {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    // Some filesystems do not support fsync on a directory. Atomic renames still
    // provide process-crash safety there, just without a power-loss guarantee.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') throw error;
  } finally {
    await handle?.close();
  }
}

async function writeFileDurably(file: string, content: string) {
  const handle = await fs.open(file, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hasChordProFiles(dir: string) {
  try {
    const entries = await fs.readdir(dir);
    return entries.some((entry) => entry.endsWith('.pro'));
  } catch {
    return false;
  }
}

function assertUniqueSongIds(songs: SongData[]) {
  const songsById = new Map<string, SongData[]>();

  for (const song of songs) {
    const existing = songsById.get(song.id) || [];
    existing.push(song);
    songsById.set(song.id, existing);
  }

  const duplicates = [...songsById.entries()].filter(([, songsForId]) => songsForId.length > 1);
  if (duplicates.length === 0) return;

  const details = duplicates
    .map(([id, songsForId]) => {
      const sources = songsForId
        .map((song) => `${song.title} (${song.sourcePath || 'unknown source'})`)
        .join(', ');
      return `- ${id}: ${sources}`;
    })
    .join('\n');

  throw new Error(
    `Duplicate song id(s) detected. Give every song a unique {title: ...} value or remove the duplicate .pro source before building:\n${details}`
  );
}

function generationPath(name: string) {
  if (path.basename(name) !== name || !/^(?:generation|legacy)-[a-zA-Z0-9.-]+$/.test(name)) {
    throw new Error(`Invalid song-data generation name: ${name}`);
  }
  return path.join(GENERATIONS_DIR, name);
}

function temporaryLinkPath(name: string) {
  if (path.basename(name) !== name || !/^\.[a-zA-Z0-9.-]+-link-[a-zA-Z0-9-]+$/.test(name)) {
    throw new Error(`Invalid temporary song-data link name: ${name}`);
  }
  return path.join(OUTPUT_PARENT_DIR, name);
}

function relativeGenerationTarget(generationDir: string) {
  return path.relative(OUTPUT_PARENT_DIR, generationDir);
}

async function outputPointsToGeneration(generationName: string) {
  const state = await pathState(OUTPUT_BASE_DIR);
  if (!state?.isSymbolicLink()) return false;
  const target = await fs.readlink(OUTPUT_BASE_DIR);
  return path.resolve(OUTPUT_PARENT_DIR, target) === generationPath(generationName);
}

async function isCompleteGeneration(generationDir: string) {
  try {
    const index = JSON.parse(await fs.readFile(path.join(generationDir, 'songs.index.json'), 'utf8'));
    if (!Array.isArray(index)) return false;
    await Promise.all(
      index.map(async (entry: unknown) => {
        if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string') {
          throw new Error('Invalid song index entry');
        }
        await fs.access(path.join(generationDir, 'songs', `${(entry as { id: string }).id}.json`));
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function writeJournal(journal: PublishJournal) {
  const temporaryJournal = `${JOURNAL_PATH}.${randomUUID()}.tmp`;
  await writeFileDurably(temporaryJournal, JSON.stringify(journal, null, 2));
  await fs.rename(temporaryJournal, JOURNAL_PATH);
  await syncDirectory(GENERATIONS_DIR);
}

async function readJournal(): Promise<PublishJournal | null> {
  try {
    const value = JSON.parse(await fs.readFile(JOURNAL_PATH, 'utf8')) as Partial<PublishJournal>;
    if (
      value.version !== 1 ||
      typeof value.newGeneration !== 'string' ||
      typeof value.temporaryLink !== 'string' ||
      !value.previous ||
      !['missing', 'symlink', 'directory'].includes(value.previous.kind)
    ) {
      throw new Error('Invalid song-data publish journal');
    }
    generationPath(value.newGeneration);
    temporaryLinkPath(value.temporaryLink);
    if (value.previous.kind === 'symlink' && typeof value.previous.target !== 'string') {
      throw new Error('Invalid previous symlink in song-data publish journal');
    }
    if (value.previous.kind === 'directory') {
      if (typeof value.previous.backupGeneration !== 'string') {
        throw new Error('Invalid directory backup in song-data publish journal');
      }
      generationPath(value.previous.backupGeneration);
    }
    return value as PublishJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function removeJournal() {
  await fs.rm(JOURNAL_PATH, { force: true });
  await syncDirectory(GENERATIONS_DIR);
}

async function createAndInstallLink(target: string) {
  const recoveryLink = path.join(
    OUTPUT_PARENT_DIR,
    `.${OUTPUT_NAME}-link-recovery-${randomUUID()}`
  );
  await fs.symlink(target, recoveryLink, 'dir');
  await fs.rename(recoveryLink, OUTPUT_BASE_DIR);
  await syncDirectory(OUTPUT_PARENT_DIR);
}

async function recoverInterruptedPublish() {
  await ensureDir(OUTPUT_PARENT_DIR);
  await ensureDir(GENERATIONS_DIR);
  const journal = await readJournal();

  if (journal) {
    const newGenerationDir = generationPath(journal.newGeneration);
    const temporaryLink = temporaryLinkPath(journal.temporaryLink);

    if (await outputPointsToGeneration(journal.newGeneration)) {
      // The atomic pointer switch completed. The new catalogue is the committed
      // state even if the process died before it removed the journal.
      if (!(await isCompleteGeneration(newGenerationDir))) {
        throw new Error('Active song-data generation is incomplete; refusing automatic recovery.');
      }
      await fs.rm(temporaryLink, { force: true });
      await removeJournal();
    } else {
      const outputState = await pathState(OUTPUT_BASE_DIR);
      if (!outputState) {
        if (journal.previous.kind === 'directory') {
          const backupDir = generationPath(journal.previous.backupGeneration);
          if (!(await pathState(backupDir))) {
            throw new Error('Cannot recover the previous song catalogue: its backup is missing.');
          }
          await fs.rename(backupDir, OUTPUT_BASE_DIR);
          await syncDirectory(OUTPUT_PARENT_DIR);
        } else if (journal.previous.kind === 'symlink') {
          await createAndInstallLink(journal.previous.target);
        } else if (await isCompleteGeneration(newGenerationDir)) {
          // There was no previous catalogue. Completing the pointer install is
          // safer than leaving the static path absent.
          await createAndInstallLink(relativeGenerationTarget(newGenerationDir));
        }
      }

      await fs.rm(temporaryLink, { force: true });
      if (!(await outputPointsToGeneration(journal.newGeneration))) {
        await fs.rm(newGenerationDir, { recursive: true, force: true });
      }
      await removeJournal();
    }
  }

  // A crash before the journal is written can only leave hidden staging/link
  // artifacts. Neither was ever active, so they are always safe to remove.
  const generationEntries = await fs.readdir(GENERATIONS_DIR);
  await Promise.all(
    generationEntries
      .filter((entry) => entry.startsWith('.build-') || entry.endsWith('.tmp'))
      .map((entry) => fs.rm(path.join(GENERATIONS_DIR, entry), { recursive: true, force: true }))
  );
  const parentEntries = await fs.readdir(OUTPUT_PARENT_DIR);
  await Promise.all(
    parentEntries
      .filter((entry) => entry.startsWith(`.${OUTPUT_NAME}-link-`))
      .map((entry) => fs.rm(path.join(OUTPUT_PARENT_DIR, entry), { force: true }))
  );
}

function injectFailure(point: string) {
  if (process.env.SONGS_BUILD_ENABLE_FAILURE_INJECTION !== '1') return;
  if (process.env.SONGS_BUILD_FAILPOINT !== point) return;
  if (process.env.SONGS_BUILD_FAILURE_MODE === 'crash') {
    process.exit(86);
  }
  throw new Error(`Injected song build failure at ${point}`);
}

async function copyRetainedSongs(stagingSongsDir: string) {
  try {
    const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) =>
          fs.copyFile(path.join(OUTPUT_DIR, entry.name), path.join(stagingSongsDir, entry.name))
        )
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function stageBuild(songs: SongData[], index: SongIndexEntry[]) {
  await ensureDir(GENERATIONS_DIR);
  const stagingDir = await fs.mkdtemp(path.join(GENERATIONS_DIR, '.build-'));
  await fs.chmod(stagingDir, 0o755);
  const stagingSongsDir = path.join(stagingDir, 'songs');
  const stagingIndexPath = path.join(stagingDir, 'songs.index.json');

  try {
    await ensureDir(stagingSongsDir);
    // Every generation contains the current songs plus historical JSON files.
    // A browser holding an older cached index can therefore still resolve all
    // of its /data/songs/<id>.json URLs after the pointer switches.
    await copyRetainedSongs(stagingSongsDir);
    await Promise.all(
      songs.map((song) =>
        writeFileDurably(
          path.join(stagingSongsDir, `${song.id}.json`),
          JSON.stringify(song, null, 2)
        )
      )
    );
    await syncDirectory(stagingSongsDir);

    // The index is written last inside the private generation. Only a complete,
    // validated generation is ever made visible by publishStagedBuild.
    await writeFileDurably(stagingIndexPath, JSON.stringify(index, null, 2));
    await syncDirectory(stagingDir);
    if (!(await isCompleteGeneration(stagingDir))) {
      throw new Error('Staged song catalogue failed validation.');
    }
    injectFailure('after-stage');
    return stagingDir;
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

async function inspectPreviousOutput(): Promise<PreviousOutput> {
  const state = await pathState(OUTPUT_BASE_DIR);
  if (!state) return { kind: 'missing' };
  if (state.isSymbolicLink()) {
    return { kind: 'symlink', target: await fs.readlink(OUTPUT_BASE_DIR) };
  }
  if (state.isDirectory()) {
    return { kind: 'directory', backupGeneration: `legacy-${Date.now()}-${randomUUID()}` };
  }
  throw new Error(`Song output path is neither a directory nor a symlink: ${OUTPUT_BASE_DIR}`);
}

async function cleanupOldGenerations() {
  try {
    const outputState = await pathState(OUTPUT_BASE_DIR);
    const activeTarget = outputState?.isSymbolicLink()
      ? path.resolve(OUTPUT_PARENT_DIR, await fs.readlink(OUTPUT_BASE_DIR))
      : null;
    const entries = await fs.readdir(GENERATIONS_DIR, { withFileTypes: true });
    const completed = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && /^(?:generation|legacy)-/.test(entry.name))
        .map(async (entry) => {
          const fullPath = path.join(GENERATIONS_DIR, entry.name);
          return { fullPath, modified: (await fs.stat(fullPath)).mtimeMs };
        })
    );
    const inactive = completed
      .filter(({ fullPath }) => fullPath !== activeTarget)
      .sort((a, b) => b.modified - a.modified);
    await Promise.all(
      inactive
        .slice(RETAINED_PREVIOUS_GENERATIONS)
        .map(({ fullPath }) => fs.rm(fullPath, { recursive: true, force: true }))
    );
  } catch (error) {
    // Cleanup is deliberately best-effort. Once the pointer has switched, a
    // cleanup problem must not turn a successful, coherent publish into a failure.
    console.warn(`Could not clean old song-data generations: ${(error as Error).message}`);
  }
}

async function publishStagedBuild(stagingDir: string) {
  const generationName = `generation-${Date.now()}-${randomUUID()}`;
  const newGenerationDir = generationPath(generationName);
  const temporaryLinkName = `.${OUTPUT_NAME}-link-${randomUUID()}`;
  const temporaryLink = temporaryLinkPath(temporaryLinkName);

  try {
    await fs.rename(stagingDir, newGenerationDir);
    await syncDirectory(GENERATIONS_DIR);
    injectFailure('after-generation-ready');

    await fs.symlink(relativeGenerationTarget(newGenerationDir), temporaryLink, 'dir');
    const previous = await inspectPreviousOutput();
    const journal: PublishJournal = {
      version: 1,
      newGeneration: generationName,
      temporaryLink: temporaryLinkName,
      previous,
    };
    await writeJournal(journal);
    injectFailure('after-journal');

    if (previous.kind === 'directory') {
      // A legacy physical output directory cannot be replaced atomically by a
      // symlink on POSIX. Move it to a journalled backup once; recovery restores
      // it if the process stops before the link is installed. Every later build
      // uses the atomic symlink-replacement path below.
      await fs.rename(OUTPUT_BASE_DIR, generationPath(previous.backupGeneration));
      await syncDirectory(OUTPUT_PARENT_DIR);
      injectFailure('after-legacy-move');
    }

    // Replacing a symlink (or installing it at a missing path) is one atomic
    // rename. Index and song JSONs consequently become visible as one snapshot.
    await fs.rename(temporaryLink, OUTPUT_BASE_DIR);
    await syncDirectory(OUTPUT_PARENT_DIR);
    injectFailure('after-pointer-switch');
    await removeJournal();
    await cleanupOldGenerations();
  } catch (error) {
    await recoverInterruptedPublish();
    if (!(await outputPointsToGeneration(generationName))) {
      await fs.rm(newGenerationDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.rm(temporaryLink, { force: true });
  }
}

async function build() {
  const localDir = path.resolve('songs');
  const siblingDir = path.resolve('..', 'holy-songs-content', 'songs');
  const songsDir =
    process.env.SONGS_DIR ||
    ((await hasChordProFiles(localDir)) ? localDir : siblingDir);
  try {
    await fs.access(songsDir);
  } catch {
    throw new Error(
      `Songs directory not found: ${songsDir}. Set SONGS_DIR or clone holy-songs-content beside this repo.`
    );
  }

  await recoverInterruptedPublish();

  const entries = await fs.readdir(songsDir);
  const songs: SongData[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.pro')) continue;
    const fullPath = path.join(songsDir, entry);
    const raw = await fs.readFile(fullPath, 'utf8');
    const song = parseChordPro(raw, path.relative(process.cwd(), fullPath));
    songs.push(song);
  }

  assertUniqueSongIds(songs);

  const index: SongIndexEntry[] = [];

  for (const song of songs) {
    index.push({
      id: song.id,
      title: song.title,
      key: song.key,
      interpret: song.interpret,
      categories: song.categories,
      sections: song.sections.flatMap((section) =>
        section.lines.map((line) => line.raw).filter((line) => line.trim() !== '')
      )
    });
  }

  const staged = await stageBuild(songs, index);
  await publishStagedBuild(staged);
  console.log(`Built ${songs.length} song(s).`);
}

build().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
