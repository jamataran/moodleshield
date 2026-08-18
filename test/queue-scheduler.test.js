import test from 'node:test'
import assert from 'node:assert/strict'
import { claimNextJob } from '../src/queue/scheduler.js'

function pipeline (kind, jobs, claims) {
  return {
    kind,
    queue: {
      async claimJob () {
        claims.push(kind)
        return jobs.shift() ?? null
      }
    }
  }
}

test('el planificador reclama como máximo un fichero por iteración', async () => {
  const claims = []
  const pipelines = [
    pipeline('video', [{ id: 1 }, { id: 2 }], claims),
    pipeline('pdf', [{ id: 3 }], claims)
  ]
  const first = await claimNextJob(pipelines, 0, {})
  assert.equal(first.pipeline.kind, 'video')
  assert.equal(first.job.id, 1)
  assert.equal(first.nextIndex, 1)
  assert.deepEqual(claims, ['video'], 'no debe reclamar un PDF mientras el vídeo está activo')
})

test('alterna vídeo y PDF para que una migración grande no cause inanición', async () => {
  const claims = []
  const pipelines = [
    pipeline('video', [{ id: 1 }, { id: 2 }], claims),
    pipeline('pdf', [{ id: 3 }], claims)
  ]
  const first = await claimNextJob(pipelines, 0, {})
  const second = await claimNextJob(pipelines, first.nextIndex, {})
  const third = await claimNextJob(pipelines, second.nextIndex, {})
  assert.deepEqual([first.pipeline.kind, second.pipeline.kind, third.pipeline.kind], ['video', 'pdf', 'video'])
  assert.deepEqual([first.job.id, second.job.id, third.job.id], [1, 3, 2])
})
