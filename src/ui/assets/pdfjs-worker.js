/**
 * El worker de PDF.js, precedido de lo que su build legacy no repone.
 *
 * Es el `workerSrc` del visor (`pdf-component.js`). Los `import` estáticos se
 * evalúan en orden, así que los polyfills quedan puestos antes de que el
 * worker de PDF.js ejecute una sola línea. Si el navegador no admite workers de
 * módulo, PDF.js importa este mismo fichero en la página y el orden se mantiene.
 */
import './pdfjs-polyfills.js?v=pdf-legacy-1'
import '/vendor/pdfjs/pdf.worker.min.mjs'
