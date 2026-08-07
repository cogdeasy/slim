# Annotation heatmap + measurement-driven annotation filtering

**Status:** spike / prototype write-up. The code that accompanies this document
is deliberately rough and is not proposed for merge as-is.

**Prototyped against:** `TCGA-50-6590` (lung adenocarcinoma H&E) on the public
IDC proxy — SM series `1.3.6.1.4.1.5962.99.1.1044659851.1751703833.1637427232395.2.0`
in study `2.25.6648858190181184824224753085742628317`, with the ANN series
`1.2.826.0.1.3680043.10.511.3.94961310062320590929959059217316301` (one
`POLYGON` annotation group, **898,090** annotations, one `Area` measurement in
`um2`).

---

## 1. Recommendation in brief

Build it entirely in Slim as an `ol/layer/Image` backed by an
`ol/source/ImageCanvas`, added to the DMV-owned map through the already-public
`volumeViewer.getMap()`. Read annotation positions out of the OpenLayers
features DMV has already materialised, fetch measurement bulk data directly
over DICOMweb (DMV does not fetch it), bin into flat typed arrays in a Web
Worker, and paint the resulting grid through a colormap LUT into a canvas.
**No DMV change is required**, including for the measurement filter: DMV cannot
hide annotations by measurement value (see the dead end below), so the filter
wraps the group's OpenLayers layer styles from Slim instead.

---

## 2. The five questions

### Q1 — Where does the overlay layer live?

**Recommendation: a Slim-owned OpenLayers layer on the DMV-owned map.**

`VolumeImageViewer` exposes its map as public API
(`dicom-microscopy-viewer/src/viewer.js`):

```js
getMap () {
  return this[_map]
}
```

so `viewer.getMap().addLayer(layer)` is a supported entry point, not a reach
into internals. The prototype adds one `ol/layer/Image` at `zIndex` 50 and
removes it on teardown. This works in practice — see the screenshots — and
survives zoom/pan for free because the layer is registered in the map's normal
extent-based render loop.

Options considered and rejected:

| Option | Verdict |
| --- | --- |
| `ol/layer/Image` + `ol/source/ImageCanvas` in Slim | **Chosen.** No DMV change; one canvas regardless of annotation count; the grid is precomputed so painting is O(bins), not O(annotations). |
| `ol/layer/Heatmap` (OL's built-in KDE heatmap) | Rejected. It is a *vector* layer: it needs 10^5–10^6 `Feature` objects live in a source, gives a per-point Gaussian blob rather than a fixed grid, and cannot express "mean of measurement per bin" at all — only weighted point density. |
| Add the layer inside DMV | Rejected. Requires shipping a DMV release for every UI iteration, and the aggregation logic is a viewer-product concern, not a DICOM-rendering concern. |
| Synthesise a client-side Parametric Map and feed DMV's `addParameterMappings` | Rejected — see §6 (dead ends). |

**Caveat worth knowing:** Slim and DMV each bundle their own copy of
OpenLayers, so the classes are structurally but not referentially identical.
The prototype therefore (a) never `instanceof`-checks DMV's objects — feature
and source access is duck typed in `annotationData.ts` — and (b) relies on the
fact that a layer constructed from Slim's OL is accepted by DMV's map. That
second point *is verified working at runtime* in this spike, but it is the
single most fragile assumption in the design. See §8.

### Q2 — Getting annotation geometry and measurements out of DMV

**Geometry: read the features DMV has already built.** When an annotation group
is made visible, DMV converts bulk annotations to OL features and tags each one
(`dicom-microscopy-viewer/src/bulkAnnotations/utils.js`):

```js
feature.setId(`${annotationGroupUID}-${annotationIndex}`)
feature.set('annotationGroupUID', annotationGroupUID, true)
measurements.forEach((measurement, measurementIndex) => {
  feature.set(`measurementValue${measurementIndex}`, measurement.values[annotationIndex], true)
})
```

So every feature carries both its group UID and its DICOM annotation index in
its OL id, which is what lets measurement arrays be gathered back onto the
extracted positions. `extractAnnotationPositions()` walks
`map.getLayers()`, unwraps cluster sources, and picks the source with the most
features whose `annotationGroupUID` matches — DMV maintains both a
whole-slide point source and a viewport-filtered polygon source, and only the
former covers the entire slide.

**Centroids:** the prototype uses the geometry's bounding-box centre. For the
whole-slide point source (which is what actually gets used) this *is* the
annotation's representative point, so the approximation is exact there. For a
polygon it is off from the true centroid by at most a cell radius — several
orders of magnitude below any sensible bin size.

**Measurements need a separate fetch.** DMV's viewer path explicitly does not
retrieve them (`src/viewer.js`):

```js
// TODO: Only fetch measurements if required
// _fetchMeasurements({ metadata, annotationGroupIndex, metadataItem, bulkdataItem, client })
```

`_fetchMeasurements` exists in `src/annotation.js` and is exported, but it is
not wired into `addAnnotationGroups`, so `feature.get('measurementValue0')` is
`undefined` in practice. The prototype fetches the bulk data itself via
`DicomWebManager.retrieveBulkData({ BulkDataURI })`, using the
`bulkdataReferences.AnnotationGroupSequence[i].MeasurementsSequence[j].MeasurementValuesSequence[0].FloatingPointValues`
URI from the ANN metadata, and interprets the payload by VR (`OF` → `Float32Array`,
`OD` → `Float64Array`, `OL` → `Int32Array`, `OW` → `Uint16Array`), matching DMV's
own conversion. Values are then gathered onto positions by annotation index.

This is cheap: on the test slide the measurement payload is **3.6 MB**
(898,090 × float32) against **308 MB** for the coordinate data. Fetching
measurements directly is three orders of magnitude cheaper than re-fetching
geometry, which is the main reason this design reuses DMV's features rather
than parsing the ANN object itself.

### Q3 — Performance at 10^5–10^6 annotations

Measured in Chrome on the test slide, 898,090 annotations, 1600×1000 viewport:

| Stage | Measured |
| --- | --- |
| Position extraction from OL features (898,090) | ~1.4 s, once, then cached |
| Measurement bulk-data fetch (3.6 MB, `Area`) | ~0.6 s, once per measurement, then cached |
| **Binning, 282 × 202 grid, density** | **19 ms** |
| **Binning, 282 × 202 grid, mean of `Area`** | **26 ms** |
| Canvas repaint (colormap/opacity/clamp/log change) | < 5 ms, no rebinning |
| JS heap, slide only | 138 MB |
| JS heap after loading 898,090 annotations (DMV) | ~1.89 GB |
| JS heap with heatmap active on top | ~1.97 GB (**+ ~80 MB**) |

The headline: **binning is not the bottleneck — DMV's own feature
materialisation is.** Loading the annotation group costs ~1.75 GB and ~90 s;
the entire heatmap pipeline adds ~80 MB and tens of milliseconds. The 4 GB
budget tracked by `MemoryMonitor` is respected, but the margin is owned by DMV,
not by this feature.

Consequences for the implementation:

- A Web Worker is implemented and used, but **it is not load-bearing at this
  scale** — 19 ms would not block the frame meaningfully either way. Keep it
  (it costs one file and protects the 10^6+ case), but do not build complexity
  on the assumption that binning is expensive.
- Buffers are **copied, not transferred**, to the worker. Transferring would
  detach the cached position array, forcing a 1.4 s re-extraction on every
  recompute. At 7 MB per copy this is the right trade.
- Recompute is **debounced by 150 ms** so that dragging the bin-size slider
  does not queue dozens of jobs, and stale responses are dropped by request id.
- Recompute is **not tied to zoom/pan at all.** The grid is computed once over
  the whole slide extent and the image layer is stretched by OL. This is both
  faster and more correct than viewport-relative binning, where bins would
  change meaning as the user zooms.
- Grid dimensions are clamped to `MAX_GRID_DIMENSION = 2048` per axis, so a
  1 µm bin size on a whole slide degrades to a coarser grid instead of trying
  to allocate 10^8 bins.
- Positions are stored as one flat interleaved `Float32Array` (`xy`) plus an
  `Int32Array` of annotation indices — 12 bytes per annotation, ~10.8 MB for
  the test slide, versus ~100× that for an array of objects.

### Q4 — Coordinate systems

This is the part most likely to be got wrong, so, precisely:

1. **OpenLayers projection coordinates** are total-pixel-matrix pixel
   coordinates *of the base level*, with a flipped y axis. From
   `dicom-microscopy-viewer/src/pyramid.js`:

   ```js
   const extent = [
     0,                                  // min x
     -(baseTotalPixelMatrixRows + 1),    // min y
     baseTotalPixelMatrixColumns,        // max x
     -1,                                 // max y
   ]
   ```

   So y runs from `-(rows + 1)` to `-1`: **negative, and increasing upward.**

2. **Projection ↔ pixel** is the flip in `src/scoord3dUtils.js`:

   ```js
   const pixelCoord = [c[0], -(c[1] + 1)]   // projection -> pixel
   ...
   return [pixelCoord[0], -(pixelCoord[1] + 1), 0]  // pixel -> projection
   ```

3. **Pixel ↔ slide (mm)** is the affine matrix, exposed as
   `viewer.getAffine()`, applied by `dmv.utils.applyTransform` /
   `applyInverseTransform`.

4. **µm → projection units** for the bin size. Because projection units are
   base-level pixels, millimetres per projection unit is the column norm of the
   affine:

   ```ts
   const affine = viewer.getAffine()
   const mmPerUnit = {
     x: Math.hypot(affine[0][0], affine[1][0]),
     y: Math.hypot(affine[0][1], affine[1][1]),
   }
   const binSizeUnits = binSizeMicrometer / 1000 / mmPerUnit.x
   ```

   Deriving it from the affine rather than `getPixelSpacing(level)` avoids
   having to know which end of the pyramid a level index refers to, and it
   stays correct if DMV changes its level ordering.

**Practical consequences.** Annotation features are already in projection
coordinates, so the heatmap bins them directly — no conversion, no rounding.
Only the *ROI* source needs conversion, because `roi.scoord3d.graphicData` is
in slide millimetres; `extractRoiPositions()` applies `applyInverseTransform`
and then the `-(y + 1)` flip. And because projection y increases upward while
canvas rows increase downward, the binner flips when computing the row index:

```ts
const row = ((maxY - y) / binSizeUnits) | 0
```

Getting that one line wrong produces a vertically mirrored heatmap that looks
plausible on a roughly symmetric slide — worth an explicit test.

### Q5 — UI placement and state

**Placement:** a new `Annotation Heatmap` `Menu.SubMenu` in
`SlideViewerSidebar`, immediately after `Annotation Groups`, rendered only when
the slide has annotation groups. It follows the existing menu-builder pattern
(`getHeatmapMenu(annotationGroups)` alongside `getAnnotationGroupMenu`), and
reuses `OpacitySlider` and the same antd `Select`/`Slider`/`Switch`
vocabulary as `AnnotationGroupItem`.

**State: `SlideViewer` state, not `SettingsContext`.** `SettingsContext` holds
durable, cross-slide user preferences; heatmap configuration is per-slide,
short-lived, and references an `annotationGroupUID` that only exists for the
current slide. Putting it in `SettingsContext` would leak stale UIDs across
navigation. Four new `SlideViewerState` fields carry it:
`heatmapSettings`, `heatmapStatus`, `heatmapMeasurementRange`,
`heatmapHoveredValue`.

**The imperative pipeline lives outside React.** `HeatmapController` owns the
OL layer, the worker, the caches and the debounce; `SlideViewer` holds a
reference to it and mirrors its status into state through an `onStatusChange`
callback. Trying to express "attach a canvas layer to a map React does not own,
keep a worker alive across renders and cache 10 MB typed arrays" as a
component's render output is the wrong shape.

**Hover readout** rides on the existing
`dicommicroscopyviewer_pointer_move` handler rather than adding a second
listener — sampling a bin is two array lookups.

**One antd gotcha:** the inline `Menu` forces `line-height: 40px` on its
children, which makes stacked labels overlap the controls beneath them. The
panel resets `line-height` on its root and on each label.

---

## 3. Recommended architecture

```
SlideViewer (React state: heatmapSettings, heatmapStatus, ...)
  │  onChange(patch)                          ▲ onStatusChange(status)
  ▼                                           │
HeatmapController ─────────────────────────────
  ├─ annotationData.ts   extract positions from DMV's OL features
  │                      fetch + align measurement bulk data (DICOMweb)
  ├─ binning.worker.ts → binning.ts   flat typed arrays → HeatmapGrid
  └─ HeatmapLayer.ts     ol/layer/Image + ol/source/ImageCanvas
                         grid + colormap LUT → ImageData → canvas
                              │
                              ▼
                     viewer.getMap().addLayer(...)
```

Two independent effects of the measurement filter, both driven by the same
range:

- **heatmap** — `filterRange` is passed into the binning request, so excluded
  annotations do not contribute to any bin;
- **annotations themselves** — `setAnnotationVisibilityFilter()` in
  `annotationData.ts`. It builds a `Uint8Array` mask indexed by DICOM annotation
  index, then replaces the style of every layer holding the group with a wrapper
  that returns `undefined` (OpenLayers renders nothing) for excluded features and
  delegates to the original style otherwise. The original style is kept in a
  `WeakMap` so clearing the filter restores it exactly. Cluster features carry no
  id of their own, so a cluster is kept whenever any of its members is allowed —
  bubbles thin out rather than disappear.

  This is deliberately *not* `setAnnotationGroupStyle(uid, { limitValues })`; see
  the dead end below.

---

## 4. File-by-file change list for the production implementation

New:

| File | Contents |
| --- | --- |
| `src/components/SlideViewer/heatmap/types.ts` | `HeatmapSettings`, `HeatmapMetric`, `HeatmapColormapName`, `AnnotationPositions`, `HeatmapGrid`, `BinningRequest`, `BinningResponse`, `DEFAULT_HEATMAP_SETTINGS` |
| `src/components/SlideViewer/heatmap/binning.ts` | `computeHeatmapGrid()`, separable Gaussian blur, `MAX_GRID_DIMENSION` |
| `src/components/SlideViewer/heatmap/binning.worker.ts` | worker entry point |
| `src/components/SlideViewer/heatmap/colormap.ts` | RGB LUT ramps + CSS gradient for the legend |
| `src/components/SlideViewer/heatmap/HeatmapLayer.ts` | `HeatmapLayer` (`sampleGrid()` lives in `binning.ts` so tests need not load OpenLayers) |
| `src/components/SlideViewer/heatmap/annotationData.ts` | `extractAnnotationPositions()`, `extractRoiPositions()`, `listMeasurements()`, `fetchMeasurementValues()`, `alignMeasurementValues()`, `getSlideExtent()`, `setAnnotationVisibilityFilter()` |
| `src/components/SlideViewer/heatmap/HeatmapController.ts` | pipeline, caches, debounce, worker lifecycle, `getMillimeterPerUnit()`, `applyAnnotationVisibility()` |
| `src/components/HeatmapMenu.tsx` | sidebar panel + legend |

Modified:

| File | Change |
| --- | --- |
| `src/components/SlideViewer.tsx` | `heatmapController` field; four state fields; `getHeatmapController()`, `handleHeatmapSettingsChange()`, `refreshHeatmapMeasurementRange()`, `updateHeatmapHoverReadout()`; `getHeatmapMenu()`; dispose in `componentWillUnmount` **and** in the `componentDidUpdate` slide-switch branch |
| `src/components/SlideViewer/types.ts` | four new `SlideViewerState` fields |
| `src/components/SlideViewer/SlideViewerSidebar.tsx` | `annotationHeatmapMenu` prop, rendered after `annotationGroupMenu` |
| `types/dicom-microscopy-viewer/index.d.ts` | declare `getMap()`, `getAffine()`, `utils.applyTransform`/`applyInverseTransform` |

Optional follow-up (not prototyped): move the hard-coded `0`/`1000` bounds in
`AnnotationGroupItem.tsx`'s measurement range slider onto the real measurement
range, which `HeatmapController.getMeasurementRange()` already computes.

---

## 5. Key signatures

```ts
export interface HeatmapSettings {
  isVisible: boolean
  sourceKind: 'annotationGroup' | 'rois'
  annotationGroupUID?: string
  metric: 'density' | 'mean' | 'max' | 'sum'
  measurement?: dcmjs.sr.coding.CodedConcept
  binSizeMicrometer: number
  colormap: HeatmapColormapName
  opacity: number
  smoothingSigmaBins: number
  clampRange?: [number, number]
  useLogScale: boolean
  filterRange?: [number, number]
}

/** Flat, worker-transferable. 12 bytes per annotation. */
export interface AnnotationPositions {
  xy: Float32Array            // interleaved, OL projection units
  annotationIndices: Int32Array
  count: number
  extent: [number, number, number, number]
}

export interface HeatmapGrid {
  values: Float32Array
  counts: Uint32Array
  width: number
  height: number
  binSizeUnits: number
  extent: [number, number, number, number]
  minValue: number
  maxValue: number
  includedCount: number
}

export class HeatmapController {
  constructor(options: {
    viewer: dmv.viewer.VolumeImageViewer
    client: DicomWebManager
    settings: HeatmapSettings
    onStatusChange: (status: HeatmapStatus) => void
  })
  attach(): void
  dispose(): void
  update(settings: HeatmapSettings, rois: dmv.roi.ROI[]): void
  sampleAt(coordinate: number[]): number | null
  listMeasurementsOf(uid: string): MeasurementDescriptor[]
  getMeasurementRange(uid: string, measurement: CodedConceptLike): Promise<[number, number] | null>
}

/**
 * Hide the annotations of a group whose annotation index is not set in
 * `allowed`; `null` restores the styles DMV originally set.
 */
export function setAnnotationVisibilityFilter(options: {
  viewer: dmv.viewer.VolumeImageViewer
  annotationGroupUID: string
  allowed: Uint8Array | null
}): void

interface HeatmapMenuProps {
  settings: HeatmapSettings
  status: HeatmapStatus
  annotationGroups: dmv.annotation.AnnotationGroup[]
  measurements: MeasurementDescriptor[]
  measurementRange: [number, number] | null
  hoveredValue: number | null
  onChange: (patch: Partial<HeatmapSettings>) => void
}
```

---

## 6. Dead ends and things that turned out not to be true

- **Synthetic client-side Parametric Map.** Attractive on paper: DMV already
  renders parametric maps with palettes, windowing and opacity, so a heatmap
  would inherit all of it. In practice it means constructing a valid
  `ParametricMap` DICOM object in the browser — pixel data, per-frame
  functional groups, `RealWorldValueMappingSequence`, its own SOP Instance
  UID — and feeding it through `addParameterMappings`, which is built to
  consume *retrieved* instances. Recomputing on every slider change would mean
  rebuilding and re-registering that object. Far more machinery than an
  `ImageCanvas` for a strictly worse iteration loop.
- **`ol/layer/Heatmap`.** Rejected on capability, not only performance: it is a
  point-density KDE and cannot compute "mean of measurement per bin".
- **`feature.get('measurementValue0')`.** DMV sets this key when it has
  measurements, so it looks like measurements are available on features for
  free. They are not: the fetch that populates them is commented out in the
  viewer path, and the value is `undefined` in practice. Discovering this is
  what forced the direct DICOMweb fetch — which turned out to be the better
  design anyway, since it is 3.6 MB against 308 MB of coordinate data.
- **`setAnnotationGroupStyle(uid, { limitValues })`.** DMV's optical-path and
  parameter-mapping style options both take `limitValues`, and the annotation
  group path accepts the same options object, so it reads as if annotations can
  be hidden by measurement value. They cannot: `viewer.js` L5012-5087 only ever
  reads `opacity`, `color` and `measurement` from that object, and unknown keys
  are dropped without an error or a warning. The first version of this prototype
  called it and looked correct — the heatmap changed, the status line said
  "101 of 898,090" — while the annotations on the slide were pixel-identical.
  **Verify annotation hiding zoomed in past DMV's 1000-annotation clustering
  threshold**, where individual outlines are drawn; at low zoom the clustered
  layer masks the difference. The Slim-side style wrapper described in §4
  replaced it and was confirmed by pixel-diffing the annotation canvas across a
  filter change (67,150 → 0 drawn pixels, and back on reset).
- **Transferring typed arrays to the worker.** The obvious optimisation is
  actively harmful here: it detaches the cached position array and turns a
  19 ms recompute into a 1.4 s one.
- **`retrieveBulkData` media types.** Passing `mediaTypes`/`byteRange` the way
  DMV's internal helper does is unnecessary; `DicomWebManager.retrieveBulkData({ BulkDataURI })`
  returns `ArrayBuffer[]` directly.
- **Binning being the performance problem.** It is not, by two orders of
  magnitude. The cost of this feature is dominated by DMV loading the
  annotation group at all (~90 s, ~1.75 GB), which the heatmap neither causes
  nor can fix.

---

## 7. Test strategy

Pure functions first — they are where the bugs are and they need no DOM:

- `binning.ts`: known point sets → expected grids; density/mean/max/sum;
  `filterRange` exclusion; **y-axis orientation** (a point in the top-left of
  the extent must land in row 0); `MAX_GRID_DIMENSION` clamping; Gaussian blur
  preserving total mass; empty input.
- `colormap.ts`: LUT length 768, monotonic ramp endpoints.
- `HeatmapLayer.sampleGrid()`: coordinates inside/outside the extent, bin
  boundaries.
- `annotationData.ts`: `alignMeasurementValues()` gather with out-of-range and
  missing indices; `listMeasurements()` against a fixture ANN metadata object;
  `extractAnnotationPositions()` against a duck-typed fake map (the duck typing
  makes this trivial to fake — no OL needed).
- `getMillimeterPerUnit()` against a known affine.

Component level (`@testing-library/react`, as used elsewhere in the repo):
`HeatmapMenu` renders the measurement selector only for non-density metrics,
emits the right `onChange` patches, and renders the legend only when a grid
exists.

Not worth unit-testing: the OL layer wiring and the worker plumbing. Those are
integration concerns and are better covered by one browser smoke test that
loads a slide with an ANN series, enables the heatmap and asserts a non-empty
grid in the legend readout.

---

## 8. Risks and open questions

1. **Two copies of OpenLayers.** Slim's OL layer instance is accepted by DMV's
   map in this spike, but nothing enforces that the two versions stay
   compatible. Mitigation: pin/dedupe OL across Slim and DMV, or add a smoke
   test that fails loudly if `addLayer` stops working. This is the risk to
   resolve first.
2. **Source selection heuristic.** `extractAnnotationPositions()` picks the
   matching source with the most features. It works on the test slide (all
   898,090 recovered) but it is a heuristic over DMV internals. A small DMV
   addition — e.g. `getAnnotationGroupFeatures(uid)` — would make this robust,
   and is the one DMV change worth asking for eventually. It is *not* required.
3. **Positions only exist after the group has been made visible.** Until then
   the panel shows "No annotations loaded yet". Acceptable, but the production
   UI should make the dependency explicit (or offer to enable the group).
4. **Clustering.** With clustering enabled the point source may be wrapped in a
   cluster source; the prototype unwraps it, but the interaction between
   clustering thresholds and extraction has not been tested across zoom levels.
5. **Measurement alignment assumes `annotationIndex` in the feature id.** True
   in current DMV. If DMV changes its id scheme, values silently misalign.
   A cheap guard: assert the parsed index is in range for a sample of features.
6. **Memory.** The heatmap adds ~80 MB, but it sits on top of DMV's ~1.75 GB.
   On slides with several large annotation groups the 4 GB budget is a real
   constraint and the caches (positions per group, measurements per
   group+measurement) should be bounded or cleared when a group is hidden.
7. **Multiple annotation groups.** The prototype heatmaps one group at a time.
   Whether pathologists want several overlaid (and how to compose colormaps) is
   a product question, not answered here.
8. **Log scale with non-positive values.** `sum`/`mean` of a signed measurement
   can be ≤ 0; the prototype's log transform guards with a floor, but the
   correct behaviour (clamp? hide? symlog?) is unresolved.
9. **The visibility filter overwrites DMV's layer styles.** It stores the
   original in a `WeakMap` and puts it back when the filter clears, but if DMV
   itself calls `setStyle` while a filter is active (e.g. the user changes the
   annotation group's colour or opacity) the wrapper is dropped and the
   annotations reappear. The production version should re-apply the filter after
   any `setAnnotationGroupStyle` call, or drive both from one place.
10. **Restoring the full range is not exactly "no filter".** Dragging the slider
   back to its bounds leaves a `filterRange` set, and floating-point/step
   rounding then excludes a slice of annotations at the extremes (observed:
   631,225 of 898,090 at nominal full range). The production UI should treat a
   range equal to the measurement's bounds as *unset* rather than as a filter.
