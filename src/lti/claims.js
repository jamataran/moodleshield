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

const INSTRUCTOR_ROLES = [
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#ContentDeveloper',
  'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator',
  'http://purl.imsglobal.org/vocab/lis/v2/system/person#Administrator'
]

export function hasInstructorRole (roles = []) {
  return roles.some((role) => INSTRUCTOR_ROLES.includes(role) || /#(Instructor|Administrator|ContentDeveloper|TeachingAssistant)$/.test(role))
}

/**
 * Aplana el id_token a la forma que usa el resto de la aplicación.
 * A partir de aquí nadie más necesita conocer las URIs de IMS.
 */
export function toLaunchContext (claims, platform) {
  const custom = claims[CLAIM.custom] ?? {}
  const roles = claims[CLAIM.roles] ?? []
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
