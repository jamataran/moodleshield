import test from 'node:test'
import assert from 'node:assert/strict'
import { CLAIM, hasInstructorRole, toLaunchContext } from '../src/lti/claims.js'

const PLATFORM = { id: 'plat-1', issuer: 'https://moodle.example.org', client_id: 'CID' }

const LEARNER = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner'
const INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'
const ADMIN = 'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator'

test('reconoce los roles de profesor y no confunde al alumno', () => {
  assert.equal(hasInstructorRole([INSTRUCTOR]), true)
  assert.equal(hasInstructorRole([ADMIN]), true)
  assert.equal(hasInstructorRole([LEARNER]), false)
  assert.equal(hasInstructorRole([]), false)
  assert.equal(hasInstructorRole([LEARNER, INSTRUCTOR]), true)
})

test('un rol que sólo contiene la palabra Instructor como texto no cuela', () => {
  assert.equal(hasInstructorRole(['http://example.org/InstructorAssistantThing']), false)
})

test('toLaunchContext aplana el id_token a la forma que usa la app', () => {
  const claims = {
    iss: PLATFORM.issuer,
    aud: 'CID',
    sub: 'user-42',
    name: 'Ana García',
    email: 'ana@example.org',
    [CLAIM.deploymentId]: 'dep-1',
    [CLAIM.messageType]: 'LtiResourceLinkRequest',
    [CLAIM.roles]: [LEARNER],
    [CLAIM.context]: { id: 'curso-9', title: 'Cálculo I' },
    [CLAIM.resourceLink]: { id: 'rl-3' },
    [CLAIM.custom]: { videoId: 'abc', username: 'jgarcia' },
    [CLAIM.lis]: { person_sourcedid: '99999999R' },
    [CLAIM.presentation]: { return_url: 'https://moodle.example.org/vuelta' }
  }

  const ctx = toLaunchContext(claims, PLATFORM)
  assert.equal(ctx.sub, 'user-42')
  assert.equal(ctx.name, 'Ana García')
  assert.equal(ctx.clientId, 'CID')
  assert.equal(ctx.deploymentId, 'dep-1')
  assert.equal(ctx.isInstructor, false)
  assert.equal(ctx.contextId, 'curso-9')
  assert.equal(ctx.contextTitle, 'Cálculo I')
  assert.equal(ctx.resourceLinkId, 'rl-3')
  assert.equal(ctx.custom.videoId, 'abc')
  assert.equal(ctx.custom.username, 'jgarcia')
  assert.equal(ctx.lisPersonSourcedId, '99999999R')
  assert.equal(ctx.returnUrl, 'https://moodle.example.org/vuelta')
})

test('con varios aud se toma el primero como client_id', () => {
  const ctx = toLaunchContext(
    { iss: PLATFORM.issuer, aud: ['CID', 'otro'], sub: 'u', [CLAIM.roles]: [] },
    PLATFORM
  )
  assert.equal(ctx.clientId, 'CID')
})

test('un launch sin claims opcionales no rompe nada', () => {
  const ctx = toLaunchContext({ iss: PLATFORM.issuer, aud: 'CID', sub: 'u' }, PLATFORM)
  assert.deepEqual(ctx.roles, [])
  assert.equal(ctx.contextId, null)
  assert.deepEqual(ctx.custom, {})
  assert.equal(ctx.isInstructor, false)
})
