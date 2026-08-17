import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('las acciones de GitHub están ancladas a commits completos', async () => {
  const files = ['ci.yml', 'cd-main.yml', 'release.yml', 'cd-promote.yml', 'codeql.yml']
  for (const file of files) {
    const text = await readFile(path.join(root, '.github/workflows', file), 'utf8')
    for (const line of text.match(/^\s*(?:-\s+)?uses:\s*[^\s]+/gm) ?? []) {
      assert.match(line, /@[0-9a-f]{40}(?:\s+#\s+v[0-9A-Za-z_.-]+)?$/,
        `${file} contiene una acción mutable: ${line.trim()}`)
    }
  }
})

test('las imágenes base desplegables están ancladas por digest', async () => {
  const nodeDockerfile = await readFile(path.join(root, 'docker/Dockerfile'), 'utf8')
  assert.match(nodeDockerfile, /^ARG NODE_VERSION=[^\s]+@sha256:[0-9a-f]{64}$/m)

  for (const file of [
    'docker/Dockerfile.proxy',
    'infra/test/compose.yml',
    'infra/prod/compose.yml'
  ]) {
    const text = await readFile(path.join(root, file), 'utf8')
    const bases = text.match(/^\s*(?:FROM|image:)\s+(?:node|nginx|postgres):[^\s]+/gm) ?? []
    assert.ok(bases.length > 0, `${file} debe contener una imagen base vigilada`)
    for (const base of bases) assert.match(base, /@sha256:[0-9a-f]{64}$/)
  }
})

test('CD publica SBOM, provenance y firma; release verifica la firma', async () => {
  const cd = await readFile(path.join(root, '.github/workflows/cd-main.yml'), 'utf8')
  const release = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8')
  assert.match(cd, /\*\.attest=type=sbom/)
  assert.match(cd, /\*\.attest=type=provenance,mode=max/)
  assert.match(cd, /cosign sign --yes/)
  assert.equal((cd.match(/aquasecurity\/trivy-action@[0-9a-f]{40}/g) ?? []).length, 3)
  assert.equal((cd.match(/severity: CRITICAL,HIGH/g) ?? []).length, 3)
  assert.equal((cd.match(/exit-code: '1'/g) ?? []).length, 3)
  assert.match(release, /cosign verify/)
})

test('el CI de PR también bloquea CVE altas/críticas en las tres imágenes', async () => {
  const ci = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  assert.equal((ci.match(/aquasecurity\/trivy-action@[0-9a-f]{40}/g) ?? []).length, 3)
  assert.equal((ci.match(/severity: CRITICAL,HIGH/g) ?? []).length, 3)
  assert.equal((ci.match(/exit-code: '1'/g) ?? []).length, 3)
})

test('npm ci nunca se ejecuta con un token de escritura disponible', async () => {
  const cd = await readFile(path.join(root, '.github/workflows/cd-main.yml'), 'utf8')
  const verify = cd.match(/^ {2}verify:\n([\s\S]*?)^ {2}release:\n/m)?.[1] ?? ''
  const release = cd.match(/^ {2}release:\n([\s\S]*)/m)?.[1] ?? ''

  assert.match(verify, /^ {4}permissions:\n {6}contents: read$/m)
  assert.match(verify, /persist-credentials: false/)
  assert.match(verify, /npm ci/)
  assert.doesNotMatch(verify, /contents: write|packages: write|id-token: write/)
  assert.match(release,
    /^ {4}permissions:\n {6}contents: write\n {6}packages: write\n {6}id-token: write$/m)
  assert.doesNotMatch(release, /npm ci/)
})
