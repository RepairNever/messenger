const UUID_ROUTE_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function taskSlugFromPublicId(publicId: string): string {
  return publicId.trim().toLowerCase()
}

export function taskPublicIdFromSlug(slug: string): string {
  return slug.trim().toUpperCase()
}

export function isUuidTaskRouteValue(value: string): boolean {
  return UUID_ROUTE_VALUE_RE.test(value.trim())
}
