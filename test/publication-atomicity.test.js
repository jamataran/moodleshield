import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
  ensureDirs,
  exists,
  mediaFingerprint,
  prepareStaging,
  publishStaging,
  readPublishedMeta,
  removeVideoFiles,
  videoDir
} from '../src/media/storage.js'

test('la publicación sólo hace visible un directorio completo', async (t) => {
  const videoId = randomUUID()
  const jobId = Math.floor(Math.random() * 1_000_000) + 1
  await ensureDirs()
  t.after(() => removeVideoFiles(videoId))

  const staging = await prepareStaging(jobId, videoId)
  await mkdir(`${staging}/A`, { recursive: true })
  await mkdir(`${staging}/B`, { recursive: true })
  await writeFile(`${staging}/key.bin`, Buffer.alloc(16))
  await writeFile(`${staging}/A/index.m3u8`, '#EXTM3U\n#EXT-X-ENDLIST\n')
  await writeFile(`${staging}/B/index.m3u8`, '#EXTM3U\n#EXT-X-ENDLIST\n')
  await writeFile(`${staging}/A/seg_0000.ts`, 'A')
  await writeFile(`${staging}/B/seg_0000.ts`, 'B')
  const meta = {
    videoId,
    segmentCount: 1,
    segmentSeconds: 4,
    artifactHash: (await mediaFingerprint(staging)).artifactHash
  }
  await writeFile(`${staging}/meta.json`, JSON.stringify(meta))

  assert.equal(await exists(videoDir(videoId)), false)
  assert.deepEqual(await publishStaging(jobId, videoId), meta)
  assert.deepEqual(await readPublishedMeta(videoId), meta)
})

test('un final completo se adopta de forma idempotente', async (t) => {
  const videoId = randomUUID()
  const firstJob = Math.floor(Math.random() * 1_000_000) + 1
  const secondJob = firstJob + 1
  await ensureDirs()
  t.after(() => removeVideoFiles(videoId))

  for (const jobId of [firstJob, secondJob]) {
    const staging = await prepareStaging(jobId, videoId)
    await mkdir(`${staging}/A`, { recursive: true })
    await mkdir(`${staging}/B`, { recursive: true })
    await writeFile(`${staging}/key.bin`, Buffer.alloc(16))
    await writeFile(`${staging}/A/index.m3u8`, '#EXTM3U\n')
    await writeFile(`${staging}/B/index.m3u8`, '#EXTM3U\n')
    await writeFile(`${staging}/A/seg_0000.ts`, `A-${jobId}`)
    await writeFile(`${staging}/B/seg_0000.ts`, `B-${jobId}`)
    await writeFile(`${staging}/meta.json`, JSON.stringify({
      videoId,
      segmentCount: 1,
      artifactHash: (await mediaFingerprint(staging)).artifactHash
    }))
  }

  const first = await publishStaging(firstJob, videoId)
  const adopted = await publishStaging(secondJob, videoId)
  assert.deepEqual(adopted, first)
})
