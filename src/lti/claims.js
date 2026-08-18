/** URIs de los claims de LTI 1.3, agrupadas para no repetir la cadena larga. */
export const CLAIM = {
  messageType: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  version: 'https://purl.imsglobal.org/spec/lti/claim/version',
  deploymentId: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  targetLinkUri: 'https://purl.imsglobal.org/spec/lti/claim/target_link_uri',
  resourceLink: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
  roles: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  context: 'https://purl.imsglobal.org/spec/lti/claim/context',
  custom: 'https://purl.imsglobal.org/spec/lti/claim/custom',
  presentation: 'https://purl.imsglobal.org/spec/lti/claim/launch_presentation',
  tool: 'https://purl.imsglobal.org/spec/lti/claim/tool_platform',
  lis: 'https://purl.imsglobal.org/spec/lti/claim/lis',
  deepLinkingSettings: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings',
  deepLinkingContentItems: 'https://purl.imsglobal.org/spec/lti-dl/claim/content_items',
  deepLinkingData: 'https://purl.imsglobal.org/spec/lti-dl/claim/data'
}

export const MESSAGE_TYPE = {
  resourceLink: 'LtiResourceLinkRequest',
  deepLinking: 'LtiDeepLinkingRequest'
}

/**
 * Roles que dan gestión del catálogo. Lista blanca EXACTA de URIs del contexto
 * del curso (`membership`) más las administrativas de institución/sistema.
 *
 * No hay respaldo por expresión regular a propósito (V-05): un `#Instructor`
 * suelto acepta también `.../membership/Learner#Instructor` (sub-rol de alumno)
 * y `.../institution/person#Instructor` («da clase en la institución», no «en
 * este curso»), que son escaladas de privilegio. `TeachingAssistant` queda
 * fuera adrede: no debe obtener gestión plena. Si un despliegue lo necesita, se
 * añade aquí su URI completa y se documenta. Lo vigila `test/claims.test.js` y
 * `test/security/roles-lti.test.js`.
 */
const INSTRUCTOR_ROLES = [
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator'
]

export function hasInstructorRole (roles) {
  // Una plataforma puede mandar `roles` como cadena en vez de array (V-31):
  // sin este guardo, `.some()` lanzaría y devolvería un 500 en el launch.
  if (!Array.isArray(roles)) return false
  return roles.some((role) => INSTRUCTOR_ROLES.includes(role))
}

/**
 * Aplana el id_token a la forma que usa el resto de la aplicación.
 * A partir de aquí nadie más necesita conocer las URIs de IMS.
 */
export function toLaunchContext (claims, platform) {
  const custom = claims[CLAIM.custom] ?? {}
  const roles = Array.isArray(claims[CLAIM.roles]) ? claims[CLAIM.roles] : []
  return {
    platformId: platform.id,
    issuer: claims.iss,
    clientId: Array.isArray(claims.aud) ? claims.aud[0] : claims.aud,
    deploymentId: claims[CLAIM.deploymentId],
    messageType: claims[CLAIM.messageType],
    sub: claims.sub,
    name: claims.name ?? [claims.given_name, claims.family_name].filter(Boolean).join(' ') ?? '',
    email: claims.email ?? '',
    roles,
    isInstructor: hasInstructorRole(roles),
    contextId: claims[CLAIM.context]?.id ?? null,
    contextTitle: claims[CLAIM.context]?.title ?? null,
    resourceLinkId: claims[CLAIM.resourceLink]?.id ?? null,
    custom,
    lisPersonSourcedId: claims[CLAIM.lis]?.person_sourcedid ?? null,
    deepLinkingSettings: claims[CLAIM.deepLinkingSettings] ?? null,
    returnUrl: claims[CLAIM.presentation]?.return_url ?? null
  }
}
