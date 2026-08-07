// Script propio de la página de login, separado de admin.js a propósito.
//
// La raíz del dominio redirige aquí, así que este fichero lo puede descargar
// cualquiera sin autenticarse. admin.js habla de issuer, deployment y keyset:
// enlazarlo desde el login delataría qué es esto a quien mirase el código
// fuente de la página. Aquí sólo va lo imprescindible para pintar el error y
// rellenar el token CSRF.

const data = JSON.parse(document.querySelector('#bootstrap')?.textContent || '{}')

const notice = document.querySelector('#notice')
if (notice && data.error) {
  notice.hidden = false
  notice.textContent = data.error
}

const csrf = document.querySelector('[name="_csrf"]')
if (csrf) csrf.value = data.csrf ?? ''
