/**
 * Minimal structural view of the affine transformation of a volume viewer,
 * so that the conversion can be tested without constructing a viewer.
 */
export interface AffineProviderLike {
  getAffine: () => number[][]
}

/**
 * Millimeters per OpenLayers projection unit, derived from the affine matrix
 * that DMV uses to map projection coordinates to slide coordinates.
 *
 * Projection units are total pixel matrix pixels of the base level, so this is
 * the base level pixel spacing. Reading it off the column norms of the affine
 * rather than off `getPixelSpacing(level)` avoids having to know which end of
 * the resolution pyramid a level index refers to, and stays correct when the
 * slide is rotated on the slide coordinate system.
 *
 * @param viewer - Volume image viewer
 *
 * @returns Millimeters per projection unit along each axis
 */
export function getMillimeterPerUnit(viewer: AffineProviderLike): {
  x: number
  y: number
} {
  const affine = viewer.getAffine()
  return {
    x: Math.hypot(affine[0][0], affine[1][0]),
    y: Math.hypot(affine[0][1], affine[1][1]),
  }
}
