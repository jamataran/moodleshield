import test from 'node:test'
import assert from 'node:assert/strict'
import { issueSession } from '../src/session.js'
import { requireCatalogInstructor } from '../src/routes/auth.js'

function runMiddleware (context) {
  const token = issueSession(context)
  const req = {
    headers: { authorization: `Bearer ${token}` },
    query: {},
    get (name) { return this.headers[name.toLowerCase()] }
  }
  const response = { statusCode: 200, body: null }
  const res = {
    status (code) { response.statusCode = code; return this },
    json (body) { response.body = body; return this }
  }
  return new Promise((resolve, reject) => {
    requireCatalogInstructor(req, res, (err) => {
      if (err) reject(err)
      else resolve({ allowed: true, req, response })
    })
    queueMicrotask(() => {
      if (response.statusCode !== 200) resolve({ allowed: false, req, response })
    })
  })
}

test('el token de catálogo del profesor permite administrar', async () => {
  const result = await runMiddleware({
    sub: 'teacher', platformId: 'platform', isInstructor: true, mode: 'catalog'
  })
  assert.equal(result.allowed, true)
})

test('un launch de reproducción no se reutiliza para administrar', async () => {
  const result = await runMiddleware({
    sub: 'teacher',
    platformId: 'platform',
    isInstructor: true,
    mode: 'launch',
    resource: { kind: 'video', id: 'video-a' }
  })
  assert.equal(result.allowed, false)
  assert.equal(result.response.statusCode, 403)
})

test('el modo catálogo no eleva a un alumno a profesor', async () => {
  const result = await runMiddleware({
    sub: 'student', platformId: 'platform', isInstructor: false, mode: 'catalog'
  })
  assert.equal(result.allowed, false)
  assert.equal(result.response.statusCode, 403)
})

