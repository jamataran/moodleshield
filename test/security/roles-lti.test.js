import test from 'node:test'
import assert from 'node:assert/strict'
import { hasInstructorRole } from '../../src/lti/claims.js'

// V-05: el respaldo por expresión regular aceptaba cualquier URI acabada en
// `#Instructor`, incluidos sub-roles de alumno y roles institucionales. La
// corrección es una lista blanca exacta. Estas pruebas están escritas como el
// ataque, no como la implementación: siguen siendo válidas si la lista cambia.

const MEMBERSHIP_INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor'
const LEARNER_SUBROLE_INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership/Learner#Instructor'
const INSTITUTION_INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Instructor'
const SYSTEM_ADMIN = 'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator'

test('el rol de profesor del curso sí escala', () => {
  assert.equal(hasInstructorRole([MEMBERSHIP_INSTRUCTOR]), true)
  assert.equal(hasInstructorRole([SYSTEM_ADMIN]), true)
})

test('el sub-rol Learner#Instructor NO escala', () => {
  assert.equal(hasInstructorRole([LEARNER_SUBROLE_INSTRUCTOR]), false)
})

test('el rol institucional institution/person#Instructor NO escala', () => {
  assert.equal(hasInstructorRole([INSTITUTION_INSTRUCTOR]), false)
})

test('un alumno con rol institucional de instructor no obtiene gestión', () => {
  const roles = [
    'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
    INSTITUTION_INSTRUCTOR
  ]
  assert.equal(hasInstructorRole(roles), false)
})

test('roles como cadena en vez de array no revienta ni escala (V-31)', () => {
  assert.equal(hasInstructorRole(MEMBERSHIP_INSTRUCTOR), false)
  assert.equal(hasInstructorRole(undefined), false)
  assert.equal(hasInstructorRole(null), false)
})
