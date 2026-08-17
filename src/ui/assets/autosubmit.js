// Auto-envío del formulario de Deep Linking. Vive como fichero externo porque
// la CSP no permite manejadores en línea (T32): un `onload=` en el body sería
// bloqueado y Moodle se quedaría esperando la respuesta.
document.forms[0]?.submit()
