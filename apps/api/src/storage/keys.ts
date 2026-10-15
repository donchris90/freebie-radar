const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OWN_UPLOAD = new RegExp(`(?:^|/)u/(${UUID})/${UUID}\\.jpg$`, 'i');

/** Storage key for a user's uploaded photo. The user id in the path is what ties a photo to its owner. */
export const photoKey = (userId: string, id: string) => `u/${userId}/${id}.jpg`;

/**
 * If the URL points at one of our uploaded photos, returns the id of the user who uploaded it; otherwise null.
 * Works for both the local driver (/uploads/u/...) and an object-store or CDN base URL (.../u/...).
 */
export function uploadOwner(url: string): string | null {
  try {
    const m = OWN_UPLOAD.exec(new URL(url).pathname);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}
