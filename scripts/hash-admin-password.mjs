#!/usr/bin/env node
import { hashAdminPassword } from '../src/admin/auth.js'

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Este script debe ejecutarse en un TTY para no exponer la contraseña.')
  process.exit(1)
}

async function hiddenPrompt (label) {
  process.stdout.write(label)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  let value = ''
  return new Promise((resolve, reject) => {
    const onData = (key) => {
      if (key === '\u0003') {
        cleanup()
        reject(new Error('Cancelado'))
      } else if (key === '\r' || key === '\n') {
        cleanup()
        process.stdout.write('\n')
        resolve(value)
      } else if (key === '\u007f') {
        value = value.slice(0, -1)
      } else if (key >= ' ') {
        value += key
      }
    }
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
    }
    process.stdin.on('data', onData)
  })
}

try {
  const password = await hiddenPrompt('Contraseña: ')
  const confirmation = await hiddenPrompt('Repite la contraseña: ')
  if (password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres')
  if (password !== confirmation) throw new Error('Las contraseñas no coinciden')
  console.log(await hashAdminPassword(password))
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
