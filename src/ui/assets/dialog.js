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
  dialog.showModal()
}
