/**
 * Apertura de diálogos, con la única precaución que hace falta recordar.
 *
 * `returnValue` sobrevive entre aperturas y cerrar con Escape no lo toca: un
 * diálogo que se cerró con "Aceptar" vuelve a abrirse con ese valor puesto, así
 * que el siguiente Escape se leería como una confirmación. Limpiarlo antes de
 * `showModal()` es lo que evita esa confusión.
 *
 * Se abre TODO diálogo por aquí. La biblioteca del profesor tiene su propia
 * copia en `catalog.js` por no arrastrar sus 70 KB hasta el visor del alumno.
 */
export function abrirDialogo (dialog) {
  if (!dialog) return
  dialog.returnValue = ''
  if (typeof dialog.showModal === 'function') return dialog.showModal()
  abrirSinSoporte(dialog)
}

/**
 * Safari < 15.4 y Firefox < 98 no tienen `<dialog>` (#110): el elemento es un
 * bloque desconocido sin `showModal`, y su `form method="dialog"` se enviaría
 * como un GET a la propia página, que en un visor es `/lti/launch`. Aquí se
 * abre como capa normal y se cierra a mano, con el botón pulsado como
 * `returnValue` y Escape como en el nativo. Sólo en esos navegadores.
 */
function abrirSinSoporte (dialog) {
  if (!dialog.dataset.sinSoporte) {
    dialog.dataset.sinSoporte = '1'
    let pulsado = ''
    dialog.addEventListener('click', (event) => {
      const boton = event.target.closest?.('button')
      if (boton) pulsado = boton.value ?? ''
    })
    dialog.addEventListener('submit', (event) => {
      if (event.target.getAttribute('method') !== 'dialog') return
      event.preventDefault()
      cerrarSinSoporte(dialog, pulsado)
      pulsado = ''
    })
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && dialog.hasAttribute('open')) cerrarSinSoporte(dialog, '')
    })
  }
  dialog.classList.add('dialogo-sin-soporte')
  dialog.setAttribute('open', '')
}

function cerrarSinSoporte (dialog, valor) {
  dialog.returnValue = valor
  dialog.removeAttribute('open')
  dialog.dispatchEvent(new Event('close'))
}
