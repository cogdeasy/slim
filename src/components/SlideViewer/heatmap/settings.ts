import type { HeatmapMetric, HeatmapSettings } from './types'

/**
 * Whether a metric aggregates a measurement and therefore needs one selected.
 *
 * @param metric - Aggregation metric
 *
 * @returns Whether a measurement has to be selected
 */
export function requiresMeasurement(metric: HeatmapMetric): boolean {
  return metric !== 'density'
}

/**
 * Apply a patch to the heatmap settings.
 *
 * Changing what is aggregated invalidates the color clamp and the measurement
 * filter, because both are expressed in the units of the previous quantity.
 *
 * @param settings - Current settings
 * @param patch - Fields to change
 *
 * @returns The updated settings
 */
export function applySettingsPatch(
  settings: HeatmapSettings,
  patch: Partial<HeatmapSettings>,
): HeatmapSettings {
  const updated: HeatmapSettings = { ...settings, ...patch }
  /*
   * Regions of interest carry no per-annotation measurements, so a metric
   * that aggregates one cannot be honored. The panel offers only density for
   * that source, and this keeps a metric chosen for an annotation group from
   * surviving the switch and stranding the user on an error message.
   *
   * Only the switch itself resets the metric. Doing it for every later patch
   * would be a metric the settings silently overrule rather than one the
   * source cannot express, and it would hide a source that does carry
   * measurements the moment one exists.
   */
  if (
    'sourceKind' in patch &&
    updated.sourceKind === 'rois' &&
    !('metric' in patch)
  ) {
    updated.metric = 'density'
  }
  /*
   * Every field is tested for membership rather than for a defined value:
   * clearing the selected group or measurement is a change of what is
   * aggregated just as much as picking a different one is, and a patch that
   * clears one is exactly how the panel deselects.
   */
  const changesMeasurement = 'measurement' in patch
  const changesSource = 'annotationGroupUID' in patch || 'sourceKind' in patch
  /** A measurement belongs to one group, so it cannot survive a group change. */
  if (changesSource && !changesMeasurement) {
    updated.measurement = undefined
  }
  const changesAggregation =
    'metric' in patch ||
    changesMeasurement ||
    'binSizeMicrometer' in patch ||
    changesSource
  if (changesAggregation && !('clampRange' in patch)) {
    updated.clampRange = undefined
  }
  /*
   * The filter slider is only offered for metrics that aggregate a
   * measurement, so a filter that survived a switch to the density metric
   * would keep annotations hidden with no control left to restore them.
   */
  if (
    (changesMeasurement ||
      changesSource ||
      !requiresMeasurement(updated.metric)) &&
    !('filterRange' in patch)
  ) {
    updated.filterRange = undefined
  }
  return updated
}

/**
 * Normalize a measurement filter range against the bounds of the measurement.
 *
 * A range that covers the full extent of the measurement is not a filter, and
 * treating it as one would exclude a slice of annotations at the extremes
 * because of slider step rounding. Such a range is therefore dropped.
 *
 * @param options - Options
 * @param options.range - Range selected in the user interface
 * @param options.bounds - Full value range of the measurement
 *
 * @returns The effective filter range, or `undefined` for "no filter"
 */
export function normalizeFilterRange({
  range,
  bounds,
}: {
  range?: [number, number]
  bounds: [number, number] | null
}): [number, number] | undefined {
  if (range === undefined) {
    return undefined
  }
  if (bounds === null) {
    return range
  }
  const span = bounds[1] - bounds[0]
  /** Half a per mille of the range absorbs slider and float rounding. */
  const tolerance = Math.abs(span) * 5e-4
  if (range[0] <= bounds[0] + tolerance && range[1] >= bounds[1] - tolerance) {
    return undefined
  }
  return range
}
