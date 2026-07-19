import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const buildScript = path.join(projectDir, 'scripts', 'build-songs.ts');

async function makeBuildFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'holy-songs-build-test-'));
  const songsDir = path.join(root, 'source-songs');
  const outputDir = path.join(root, 'data');
  const generatedSongsDir = path.join(outputDir, 'songs');
  await fs.mkdir(songsDir, { recursive: true });
  await fs.mkdir(generatedSongsDir, { recursive: true });
  return { root, songsDir, outputDir, generatedSongsDir };
}

function buildEnvironment(songsDir: string, outputDir: string) {
  return {
    ...process.env,
    SONGS_DIR: songsDir,
    SONGS_OUTPUT_DIR: outputDir,
  };
}

function runBuild(
  songsDir: string,
  outputDir: string,
  extraEnvironment: Record<string, string> = {}
) {
  return spawnSync(process.execPath, ['--import', 'tsx', buildScript], {
    cwd: projectDir,
    env: { ...buildEnvironment(songsDir, outputDir), ...extraEnvironment },
    encoding: 'utf8',
  });
}

async function activeGeneration(outputDir: string) {
  assert.equal((await fs.lstat(outputDir)).isSymbolicLink(), true);
  return fs.realpath(outputDir);
}

async function assertNoPublishDebris(outputDir: string) {
  const outputName = path.basename(outputDir);
  const parent = path.dirname(outputDir);
  const generationsDir = path.join(parent, `.${outputName}-generations`);
  const generationEntries = await fs.readdir(generationsDir);
  assert.equal(generationEntries.includes('.publish-journal.json'), false);
  assert.deepEqual(
    generationEntries.filter((entry) => entry.startsWith('.build-') || entry.endsWith('.tmp')),
    []
  );
  assert.deepEqual(
    (await fs.readdir(parent)).filter((entry) => entry.startsWith(`.${outputName}-link-`)),
    []
  );
}

test('publishes a complete build and retains JSON used by older cached indices', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const oldIndex = JSON.stringify([{ id: 'old-song', title: 'Old Song' }]);
  const oldSong = JSON.stringify({ id: 'old-song', title: 'Old Song' });
  await fs.writeFile(path.join(fixture.outputDir, 'songs.index.json'), oldIndex, 'utf8');
  await fs.writeFile(path.join(fixture.generatedSongsDir, 'old-song.json'), oldSong, 'utf8');
  await fs.writeFile(
    path.join(fixture.songsDir, 'new-song.pro'),
    '{title: New Song}\n{key: D}\n',
    'utf8'
  );

  execFileSync(process.execPath, ['--import', 'tsx', buildScript], {
    cwd: projectDir,
    env: buildEnvironment(fixture.songsDir, fixture.outputDir),
    stdio: 'pipe',
  });

  const newIndex = JSON.parse(
    await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8')
  );
  assert.equal(newIndex[0].id, 'new-song');
  assert.equal((await fs.lstat(fixture.outputDir)).isSymbolicLink(), true);
  assert.equal(
    await fs.readFile(path.join(fixture.generatedSongsDir, 'old-song.json'), 'utf8'),
    oldSong
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.generatedSongsDir, 'new-song.json'), 'utf8')).id,
    'new-song'
  );
  await assertNoPublishDebris(fixture.outputDir);
});

test('copies a legacy directory when the filesystem cannot rename it directly', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const oldSong = JSON.stringify({ id: 'old-song', title: 'Old Song' });
  await fs.writeFile(
    path.join(fixture.outputDir, 'songs.index.json'),
    JSON.stringify([{ id: 'old-song', title: 'Old Song' }]),
    'utf8'
  );
  await fs.writeFile(path.join(fixture.generatedSongsDir, 'old-song.json'), oldSong, 'utf8');
  await fs.writeFile(
    path.join(fixture.songsDir, 'new-song.pro'),
    '{title: New Song}\n{key: E}\n[E]new\n',
    'utf8'
  );

  const result = runBuild(fixture.songsDir, fixture.outputDir, {
    SONGS_BUILD_ENABLE_FAILURE_INJECTION: '1',
    SONGS_BUILD_FORCE_LEGACY_COPY: '1',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal((await fs.lstat(fixture.outputDir)).isSymbolicLink(), true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'))[0].id,
    'new-song'
  );
  assert.equal(
    await fs.readFile(path.join(fixture.outputDir, 'songs', 'old-song.json'), 'utf8'),
    oldSong
  );
  await assertNoPublishDebris(fixture.outputDir);
});

test('does not trust an uncommitted cross-device backup after a crash', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const oldIndex = JSON.stringify([{ id: 'old-song', title: 'Old Song' }]);
  const oldSong = JSON.stringify({ id: 'old-song', title: 'Old Song' });
  await fs.writeFile(path.join(fixture.outputDir, 'songs.index.json'), oldIndex, 'utf8');
  await fs.writeFile(path.join(fixture.generatedSongsDir, 'old-song.json'), oldSong, 'utf8');
  await fs.writeFile(
    path.join(fixture.songsDir, 'new-song.pro'),
    '{title: New Song}\n{key: A}\n[A]new\n',
    'utf8'
  );

  const crashed = runBuild(fixture.songsDir, fixture.outputDir, {
    SONGS_BUILD_ENABLE_FAILURE_INJECTION: '1',
    SONGS_BUILD_FORCE_LEGACY_COPY: '1',
    SONGS_BUILD_FAILPOINT: 'before-legacy-backup-commit',
    SONGS_BUILD_FAILURE_MODE: 'crash',
  });
  assert.equal(crashed.status, 86);
  assert.equal(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'), oldIndex);
  assert.equal(
    await fs.readFile(path.join(fixture.outputDir, 'songs', 'old-song.json'), 'utf8'),
    oldSong
  );

  const recovered = runBuild(fixture.songsDir, fixture.outputDir, {
    SONGS_BUILD_ENABLE_FAILURE_INJECTION: '1',
    SONGS_BUILD_FORCE_LEGACY_COPY: '1',
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal((await fs.lstat(fixture.outputDir)).isSymbolicLink(), true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'))[0].id,
    'new-song'
  );
  await assertNoPublishDebris(fixture.outputDir);
});

test('a failed build leaves the active catalogue untouched', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const oldIndex = JSON.stringify([{ id: 'safe-song', title: 'Safe Song' }]);
  const oldSong = JSON.stringify({ id: 'safe-song', title: 'Safe Song' });
  const indexPath = path.join(fixture.outputDir, 'songs.index.json');
  const oldSongPath = path.join(fixture.generatedSongsDir, 'safe-song.json');
  await fs.writeFile(indexPath, oldIndex, 'utf8');
  await fs.writeFile(oldSongPath, oldSong, 'utf8');
  await fs.writeFile(path.join(fixture.songsDir, 'duplicate-a.pro'), '{title: Duplicate}\n', 'utf8');
  await fs.writeFile(path.join(fixture.songsDir, 'duplicate-b.pro'), '{title: Duplicate}\n', 'utf8');

  const result = spawnSync(process.execPath, ['--import', 'tsx', buildScript], {
    cwd: projectDir,
    env: buildEnvironment(fixture.songsDir, fixture.outputDir),
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate song id/);
  assert.equal(await fs.readFile(indexPath, 'utf8'), oldIndex);
  assert.equal(await fs.readFile(oldSongPath, 'utf8'), oldSong);
  assert.deepEqual(await fs.readdir(fixture.generatedSongsDir), ['safe-song.json']);
});

test('switches index and songs as one directory generation', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const sourcePath = path.join(fixture.songsDir, 'changing-song.pro');
  await fs.writeFile(sourcePath, '{title: Changing Song}\n{key: C}\n[C]old words\n', 'utf8');

  assert.equal(runBuild(fixture.songsDir, fixture.outputDir).status, 0);
  const firstGeneration = await activeGeneration(fixture.outputDir);
  const firstIndex = await fs.readFile(path.join(firstGeneration, 'songs.index.json'), 'utf8');
  const firstSong = await fs.readFile(
    path.join(firstGeneration, 'songs', 'changing-song.json'),
    'utf8'
  );

  await fs.writeFile(sourcePath, '{title: Changing Song}\n{key: D}\n[D]new words\n', 'utf8');
  assert.equal(runBuild(fixture.songsDir, fixture.outputDir).status, 0);
  const secondGeneration = await activeGeneration(fixture.outputDir);

  assert.notEqual(secondGeneration, firstGeneration);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'))[0].key,
    'D'
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(fixture.outputDir, 'songs', 'changing-song.json'), 'utf8')
    ).key,
    'D'
  );

  // The old generation remains an internally coherent immutable snapshot.
  assert.equal(await fs.readFile(path.join(firstGeneration, 'songs.index.json'), 'utf8'), firstIndex);
  assert.equal(
    await fs.readFile(path.join(firstGeneration, 'songs', 'changing-song.json'), 'utf8'),
    firstSong
  );
  await assertNoPublishDebris(fixture.outputDir);
});

test('an injected publish error rolls back before the pointer switch', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const sourcePath = path.join(fixture.songsDir, 'safe-song.pro');
  await fs.writeFile(sourcePath, '{title: Safe Song}\n{key: C}\n[C]safe\n', 'utf8');
  assert.equal(runBuild(fixture.songsDir, fixture.outputDir).status, 0);
  const originalGeneration = await activeGeneration(fixture.outputDir);
  const originalIndex = await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8');
  const originalSong = await fs.readFile(
    path.join(fixture.outputDir, 'songs', 'safe-song.json'),
    'utf8'
  );

  await fs.writeFile(sourcePath, '{title: Safe Song}\n{key: E}\n[E]changed\n', 'utf8');
  const result = runBuild(fixture.songsDir, fixture.outputDir, {
    SONGS_BUILD_ENABLE_FAILURE_INJECTION: '1',
    SONGS_BUILD_FAILPOINT: 'after-journal',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Injected song build failure/);
  assert.equal(await activeGeneration(fixture.outputDir), originalGeneration);
  assert.equal(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'), originalIndex);
  assert.equal(
    await fs.readFile(path.join(fixture.outputDir, 'songs', 'safe-song.json'), 'utf8'),
    originalSong
  );
  await assertNoPublishDebris(fixture.outputDir);
});

test('recovers a hard crash during one-time physical-directory migration', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const oldIndex = JSON.stringify([{ id: 'old-song', title: 'Old Song' }]);
  const oldSong = JSON.stringify({ id: 'old-song', title: 'Old Song' });
  await fs.writeFile(path.join(fixture.outputDir, 'songs.index.json'), oldIndex, 'utf8');
  await fs.writeFile(path.join(fixture.generatedSongsDir, 'old-song.json'), oldSong, 'utf8');
  await fs.writeFile(
    path.join(fixture.songsDir, 'new-song.pro'),
    '{title: New Song}\n{key: G}\n[G]new\n',
    'utf8'
  );

  const crashedMigration = runBuild(fixture.songsDir, fixture.outputDir, {
    SONGS_BUILD_ENABLE_FAILURE_INJECTION: '1',
    SONGS_BUILD_FORCE_LEGACY_COPY: '1',
    SONGS_BUILD_FAILPOINT: 'after-legacy-copy',
    SONGS_BUILD_FAILURE_MODE: 'crash',
  });
  assert.equal(crashedMigration.status, 86);
  assert.equal((await fs.lstat(fixture.outputDir)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'), oldIndex);
  assert.equal(
    await fs.readFile(path.join(fixture.outputDir, 'songs', 'old-song.json'), 'utf8'),
    oldSong
  );

  // Recovery runs before staging. Crashing at the next stage lets the test
  // observe that the old physical catalogue was restored first.
  const crashedAfterRecovery = runBuild(fixture.songsDir, fixture.outputDir, {
    SONGS_BUILD_ENABLE_FAILURE_INJECTION: '1',
    SONGS_BUILD_FAILPOINT: 'after-stage',
    SONGS_BUILD_FAILURE_MODE: 'crash',
  });
  assert.equal(crashedAfterRecovery.status, 86);
  assert.equal((await fs.lstat(fixture.outputDir)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'), oldIndex);
  assert.equal(
    await fs.readFile(path.join(fixture.outputDir, 'songs', 'old-song.json'), 'utf8'),
    oldSong
  );

  const completed = runBuild(fixture.songsDir, fixture.outputDir);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal((await activeGeneration(fixture.outputDir)).length > 0, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'))[0].id,
    'new-song'
  );
  assert.equal(
    await fs.readFile(path.join(fixture.outputDir, 'songs', 'old-song.json'), 'utf8'),
    oldSong
  );
  await assertNoPublishDebris(fixture.outputDir);
});

test('accepts a complete generation after a hard crash immediately after commit', async (t) => {
  const fixture = await makeBuildFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const sourcePath = path.join(fixture.songsDir, 'committed-song.pro');
  await fs.writeFile(sourcePath, '{title: Committed Song}\n{key: C}\n[C]first\n', 'utf8');
  assert.equal(runBuild(fixture.songsDir, fixture.outputDir).status, 0);
  const firstGeneration = await activeGeneration(fixture.outputDir);

  await fs.writeFile(sourcePath, '{title: Committed Song}\n{key: F}\n[F]second\n', 'utf8');
  const crashed = runBuild(fixture.songsDir, fixture.outputDir, {
    SONGS_BUILD_ENABLE_FAILURE_INJECTION: '1',
    SONGS_BUILD_FAILPOINT: 'after-pointer-switch',
    SONGS_BUILD_FAILURE_MODE: 'crash',
  });
  assert.equal(crashed.status, 86);

  const committedGeneration = await activeGeneration(fixture.outputDir);
  assert.notEqual(committedGeneration, firstGeneration);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.outputDir, 'songs.index.json'), 'utf8'))[0].key,
    'F'
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(fixture.outputDir, 'songs', 'committed-song.json'), 'utf8')
    ).key,
    'F'
  );

  // A normal retry recognizes the pointer as committed, removes the journal,
  // and publishes another complete generation without rolling data back.
  const retry = runBuild(fixture.songsDir, fixture.outputDir);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(fixture.outputDir, 'songs', 'committed-song.json'), 'utf8')).key,
    'F'
  );
  await assertNoPublishDebris(fixture.outputDir);
});
