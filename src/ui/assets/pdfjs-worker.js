/**
 * El worker de PDF.js, precedido de lo que su build legacy no repone.
 *
 * Es el `workerSrc` del visor (`pdf-component.js`). Los `import` y `export … from`
 * se evalúan en el orden en que aparecen, así que los polyfills quedan puestos
 * antes de que el worker de PDF.js ejecute una sola línea.
 *
 * Reexporta `WorkerMessageHandler` porque es lo que PDF.js busca en este módulo
 * cuando no puede arrancar un worker —Firefox anterior a 114 no tiene workers de
 * módulo, y a cualquiera le puede fallar la red al pedirlo— y lo ejecuta en la
 * propia página. Sin la reexportación ese respaldo fallaba y, como PDF.js
 * recuerda el fallo, ningún PDF de la página volvía a abrir.
 */
import './pdfjs-polyfills.js?v=pdf-legacy-1'
export { WorkerMessageHandler } from '/vendor/pdfjs/pdf.worker.min.mjs'
