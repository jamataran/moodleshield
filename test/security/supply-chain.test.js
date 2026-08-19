import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Todos los workflows, sin lista que mantener: uno nuevo entra solo. */
async function workflowFiles () {
  const dir = path.join(root, '.github/workflows')
  return (await readdir(dir)).filter((f) => f.endsWith('.yml')).sort()
}

test('las acciones de GitHub están ancladas a commits completos', async () => {
  const files = await workflowFiles()
  assert.ok(files.length >= 4, 'faltan workflows por revisar')
  for (const file of files) {
    const text = await readFile(path.join(root, '.github/workflows', file), 'utf8')
    for (const line of text.match(/^\s*(?:-\s+)?uses:\s*[^\s]+/gm) ?? []) {
      assert.match(line, /@[0-9a-f]{40}(?:\s+#\s+v[0-9A-Za-z_.-]+)?$/,
        `${file} contiene una acción mutable: ${line.trim()}`)
    }
  }
})

/**
 * El nombre dice si hay que hacer algo: `[AUTO]` se dispara solo, `[MANUAL]` es
 * un botón. Sin el prefijo, la pestaña de Actions es una lista de nombres
 * parecidos en la que hay que abrir cada uno para saber cuál se lanza a mano.
 */
test('cada workflow declara en su nombre si es automático o manual', async () => {
  for (const file of await workflowFiles()) {
    const text = await readFile(path.join(root, '.github/workflows', file), 'utf8')
    const name = text.match(/^name:\s*'?([^'\n]+)'?/)?.[1] ?? ''
    assert.match(name, /^\[(AUTO|MANUAL)\] /, `${file} no dice si es [AUTO] o [MANUAL]: ${name}`)
    const manual = name.startsWith('[MANUAL]')
    const soloAMano = /^on:\n\s+workflow_dispatch:/m.test(text)
    assert.equal(manual, soloAMano,
      `${file}: [MANUAL] es sólo para lo que no se dispara solo`)
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

test('CD publica SBOM, provenance y firma; la promoción la verifica', async () => {
  const cd = await readFile(path.join(root, '.github/workflows/cd-test.yml'), 'utf8')
  const promote = await readFile(path.join(root, '.github/workflows/cd-promote.yml'), 'utf8')
  assert.match(cd, /\*\.attest=type=sbom/)
  assert.match(cd, /\*\.attest=type=provenance,mode=max/)
  assert.match(cd, /cosign sign --yes/)
  assert.equal((cd.match(/aquasecurity\/trivy-action@[0-9a-f]{40}/g) ?? []).length, 3)
  assert.equal((cd.match(/severity: CRITICAL,HIGH/g) ?? []).length, 3)
  assert.equal((cd.match(/exit-code: '1'/g) ?? []).length, 3)

  // Promocionar no reconstruye: lo único que demuestra la procedencia del
  // digest es la firma que le puso cd-test. Se verifica ANTES de re-etiquetar.
  assert.match(promote, /cosign verify/)
  // Por posición del PASO, no del texto: la cabecera del workflow ya menciona
  // `imagetools create` en un comentario y adelantaría la comparación.
  const verifyAt = promote.search(/^ {6}- name: .*[Vv]erificar la firma/m)
  const retagAt = promote.search(/^ {6}- name: Re-etiquetar/m)
  assert.ok(verifyAt > -1, 'cd-promote debe tener un paso que verifique la firma')
  assert.ok(retagAt > verifyAt, 'la verificación de firma debe ir antes del re-etiquetado')
})

// La identidad del certificado lleva dentro el nombre del workflow y la rama que
// lo emitió. Cuando ADR-028 renombró cd-main.yml a cd-test.yml y movió el build
// a `test`, release.yml siguió verificando contra `cd-main.yml@refs/heads/main`:
// una identidad que ya no firma nada. Esto lo ata a lo que de verdad construye.
test('la identidad de cosign apunta al workflow y la rama que firman', async () => {
  const promote = await readFile(path.join(root, '.github/workflows/cd-promote.yml'), 'utf8')
  const cd = await readFile(path.join(root, '.github/workflows/cd-test.yml'), 'utf8')

  const identity = promote.match(/identity="([^"]+)"/)?.[1]
  assert.ok(identity, 'cd-promote debe fijar la identidad del certificado')
  const workflow = identity.match(/\.github\/workflows\/([^@]+)@refs\/heads\/(.+)$/)
  assert.ok(workflow, `identidad con formato inesperado: ${identity}`)
  const [, file, branch] = workflow

  assert.equal(file, 'cd-test.yml', 'debe verificarse contra el workflow que firma')
  const triggers = cd.match(/branches:\s*\[([^\]]+)\]/)?.[1] ?? ''
  assert.ok(triggers.split(',').map((b) => b.trim()).includes(branch),
    `cd-test.yml no se dispara en '${branch}', así que nunca firmará con esa identidad`)
})

test('el CI de PR también bloquea CVE altas/críticas en las tres imágenes', async () => {
  const ci = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8')
  assert.equal((ci.match(/aquasecurity\/trivy-action@[0-9a-f]{40}/g) ?? []).length, 3)
  assert.equal((ci.match(/severity: CRITICAL,HIGH/g) ?? []).length, 3)
  assert.equal((ci.match(/exit-code: '1'/g) ?? []).length, 3)
})

test('npm ci nunca se ejecuta con un token de escritura disponible', async () => {
  const cd = await readFile(path.join(root, '.github/workflows/cd-test.yml'), 'utf8')
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
