import {
  Col,
  Divider,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Switch,
  Tooltip,
  Typography,
} from 'antd'
// skipcq: JS-C1003 - dmv uses nested namespaces (dmv.annotation)
import type * as dmv from 'dicom-microscopy-viewer'
import type React from 'react'
import { FaEye, FaEyeSlash } from 'react-icons/fa'

import OpacitySlider from './OpacitySlider'
import type { MeasurementDescriptor } from './SlideViewer/heatmap/annotationData'
import {
  COLORMAP_NAMES,
  getColormapGradientCss,
} from './SlideViewer/heatmap/colormap'
import { isLogScaleApplicable } from './SlideViewer/heatmap/scaling'
import {
  normalizeFilterRange,
  requiresMeasurement,
} from './SlideViewer/heatmap/settings'
import type {
  HeatmapMetric,
  HeatmapSettings,
  HeatmapStatus,
} from './SlideViewer/heatmap/types'

const METRIC_OPTIONS: Array<{ value: HeatmapMetric; label: string }> = [
  { value: 'density', label: 'Annotation density (count)' },
  { value: 'mean', label: 'Mean of measurement' },
  { value: 'max', label: 'Max of measurement' },
  { value: 'sum', label: 'Sum of measurement' },
]

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  lineHeight: '18px',
}

const NOTE_STYLE: React.CSSProperties = { fontSize: '11px' }

interface HeatmapMenuProps {
  settings: HeatmapSettings
  status: HeatmapStatus
  annotationGroups: dmv.annotation.AnnotationGroup[]
  measurements: MeasurementDescriptor[]
  /** Full range of the selected measurement, bounding the filter slider. */
  measurementRange: [number, number] | null
  hoveredValue: number | null
  onChange: (patch: Partial<HeatmapSettings>) => void
}

/**
 * Format a bin or measurement value for the legend.
 *
 * @param value - Value to format
 *
 * @returns A short human readable representation
 */
export function formatHeatmapValue(value: number): string {
  if (!Number.isFinite(value)) {
    return '—'
  }
  const magnitude = Math.abs(value)
  if (magnitude !== 0 && (magnitude < 0.01 || magnitude >= 100000)) {
    return value.toExponential(2)
  }
  return value.toFixed(magnitude >= 100 ? 0 : 2)
}

/**
 * Color ramp between the effective minimum and maximum, plus the value of the
 * bin under the cursor and a summary of what the grid is made of.
 *
 * @param props - Component properties
 * @param props.settings - Current heatmap settings
 * @param props.status - Current pipeline status
 * @param props.hoveredValue - Value of the bin under the cursor
 *
 * @returns The legend, or nothing while there is no grid
 */
function HeatmapLegend({
  settings,
  status,
  hoveredValue,
}: {
  settings: HeatmapSettings
  status: HeatmapStatus
  hoveredValue: number | null
}): React.ReactElement | null {
  const grid = status.grid
  if (grid === null) {
    return null
  }
  const low = settings.clampRange?.[0] ?? grid.minValue
  const high = settings.clampRange?.[1] ?? grid.maxValue
  const isLogarithmic = settings.useLogScale && isLogScaleApplicable(low)
  return (
    <div style={{ marginTop: '8px' }} data-testid="heatmap-legend">
      <div
        style={{
          height: '12px',
          borderRadius: '2px',
          border: '1px solid #d9d9d9',
          background: getColormapGradientCss(settings.colormap),
        }}
      />
      <Row justify="space-between">
        <Col>
          <Typography.Text type="secondary" style={NOTE_STYLE}>
            {formatHeatmapValue(low)}
          </Typography.Text>
        </Col>
        <Col>
          <Typography.Text type="secondary" style={NOTE_STYLE}>
            {isLogarithmic ? 'log scale' : ''}
          </Typography.Text>
        </Col>
        <Col>
          <Typography.Text type="secondary" style={NOTE_STYLE}>
            {formatHeatmapValue(high)}
          </Typography.Text>
        </Col>
      </Row>
      <Typography.Text style={{ fontSize: '12px' }}>
        Bin under cursor:{' '}
        <strong>
          {hoveredValue === null ? '—' : formatHeatmapValue(hoveredValue)}
        </strong>
      </Typography.Text>
      <br />
      <Typography.Text type="secondary" style={NOTE_STYLE}>
        {grid.width} x {grid.height} bins, {grid.includedCount.toLocaleString()}{' '}
        of {status.annotationCount.toLocaleString()} annotations
        {status.timings !== null
          ? `, binned in ${status.timings.binMs.toFixed(0)} ms`
          : ''}
      </Typography.Text>
    </div>
  )
}

/**
 * Sidebar controls of the annotation heatmap overlay.
 *
 * Purely presentational: every change is reported as a patch of the settings
 * held by `SlideViewer`, which drives the `HeatmapController`.
 *
 * @param props - Component properties
 *
 * @returns The panel
 */
const HeatmapMenu: React.FC<HeatmapMenuProps> = ({
  settings,
  status,
  annotationGroups,
  measurements,
  measurementRange,
  hoveredValue,
  onChange,
}) => {
  const needsMeasurement = requiresMeasurement(settings.metric)
  const grid = status.grid
  const clampLow = grid?.minValue ?? 0
  const clampHigh = grid?.maxValue ?? 0
  const canUseLogScale = isLogScaleApplicable(
    settings.clampRange?.[0] ?? clampLow,
  )

  return (
    /*
     * antd's inline Menu forces a 40px line height on its children, which
     * makes stacked labels overlap the controls beneath them.
     */
    <div style={{ padding: '7px 14px', lineHeight: '22px' }}>
      <Row justify="space-between" align="middle">
        <Col>Show heatmap</Col>
        <Col>
          <Switch
            size="small"
            aria-label="Show heatmap"
            checked={settings.isVisible}
            onChange={(checked) => onChange({ isVisible: checked })}
            checkedChildren={<FaEye />}
            unCheckedChildren={<FaEyeSlash />}
          />
        </Col>
      </Row>

      <Divider style={{ margin: '8px 0' }} />

      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <div>
          <Typography.Text style={LABEL_STYLE} id="heatmap-source-label">
            Source
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            size="small"
            aria-labelledby="heatmap-source-label"
            value={settings.sourceKind}
            onChange={(value) => onChange({ sourceKind: value })}
            options={[
              { value: 'annotationGroup', label: 'Annotation group' },
              { value: 'rois', label: 'My ROI annotations' },
            ]}
          />
        </div>

        {settings.sourceKind === 'annotationGroup' && (
          <div>
            <Typography.Text style={LABEL_STYLE} id="heatmap-group-label">
              Annotation group
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              size="small"
              aria-labelledby="heatmap-group-label"
              placeholder="Select an annotation group"
              value={settings.annotationGroupUID}
              onChange={(value) => onChange({ annotationGroupUID: value })}
              options={annotationGroups.map((group) => ({
                value: group.uid,
                label: group.label,
              }))}
            />
            <Typography.Text type="secondary" style={NOTE_STYLE}>
              One group at a time; make it visible under Annotation Groups
              first.
            </Typography.Text>
          </div>
        )}

        <div>
          <Typography.Text style={LABEL_STYLE} id="heatmap-metric-label">
            Metric
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            size="small"
            aria-labelledby="heatmap-metric-label"
            value={settings.metric}
            onChange={(value) => onChange({ metric: value })}
            options={METRIC_OPTIONS}
          />
        </div>

        {needsMeasurement && (
          <div>
            <Typography.Text style={LABEL_STYLE} id="heatmap-measurement-label">
              Measurement
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              size="small"
              aria-labelledby="heatmap-measurement-label"
              placeholder="Select a measurement"
              value={
                settings.measurement === undefined
                  ? undefined
                  : `${settings.measurement.CodingSchemeDesignator}-${settings.measurement.CodeValue}`
              }
              onChange={(value) => {
                const descriptor = measurements.find(
                  (candidate) => candidate.key === value,
                )
                onChange({ measurement: descriptor?.name })
              }}
              options={measurements.map((descriptor) => ({
                value: descriptor.key,
                label:
                  descriptor.unit === undefined
                    ? descriptor.label
                    : `${descriptor.label} [${descriptor.unit}]`,
              }))}
            />
          </div>
        )}

        <Row justify="center" align="middle">
          <Col span={10}>Bin size (µm)</Col>
          <Col span={8}>
            <Slider
              min={10}
              max={1000}
              step={10}
              value={settings.binSizeMicrometer}
              onChange={(value) => onChange({ binSizeMicrometer: value })}
            />
          </Col>
          <Col span={6}>
            <InputNumber
              min={10}
              max={1000}
              step={10}
              size="small"
              aria-label="Bin size in micrometer"
              style={{ width: '70px' }}
              value={settings.binSizeMicrometer}
              onChange={(value) =>
                onChange({
                  binSizeMicrometer: value ?? settings.binSizeMicrometer,
                })
              }
            />
          </Col>
        </Row>

        <div>
          <Typography.Text style={LABEL_STYLE} id="heatmap-colormap-label">
            Colormap
          </Typography.Text>
          <Select
            style={{ width: '100%' }}
            size="small"
            aria-labelledby="heatmap-colormap-label"
            value={settings.colormap}
            onChange={(value) => onChange({ colormap: value })}
            options={COLORMAP_NAMES.map((name) => ({
              value: name,
              label: name,
            }))}
          />
        </div>

        <OpacitySlider
          opacity={settings.opacity}
          onChange={(value) => onChange({ opacity: value ?? 0 })}
        />

        <Row justify="center" align="middle">
          <Col span={10}>Smoothing (σ)</Col>
          <Col span={8}>
            <Slider
              min={0}
              max={5}
              step={0.5}
              value={settings.smoothingSigmaBins}
              onChange={(value) => onChange({ smoothingSigmaBins: value })}
            />
          </Col>
          <Col span={6}>
            <InputNumber
              min={0}
              max={5}
              step={0.5}
              size="small"
              aria-label="Smoothing sigma in bins"
              style={{ width: '70px' }}
              value={settings.smoothingSigmaBins}
              onChange={(value) => onChange({ smoothingSigmaBins: value ?? 0 })}
            />
          </Col>
        </Row>

        <Row justify="space-between" align="middle">
          <Col>Log scale</Col>
          <Col>
            <Tooltip
              title={
                canUseLogScale
                  ? undefined
                  : 'A logarithmic scale needs a strictly positive value range.'
              }
            >
              <Switch
                size="small"
                aria-label="Log scale"
                disabled={!canUseLogScale}
                checked={settings.useLogScale && canUseLogScale}
                onChange={(checked) => onChange({ useLogScale: checked })}
              />
            </Tooltip>
          </Col>
        </Row>

        {grid !== null && clampHigh > clampLow && (
          <div>
            <Typography.Text style={LABEL_STYLE}>
              Value range clamp
            </Typography.Text>
            <Slider
              range
              min={clampLow}
              max={clampHigh}
              step={(clampHigh - clampLow) / 100}
              value={settings.clampRange ?? [clampLow, clampHigh]}
              onChange={(value) =>
                onChange({ clampRange: value as [number, number] })
              }
            />
          </div>
        )}

        {needsMeasurement &&
          measurementRange !== null &&
          measurementRange[1] > measurementRange[0] && (
            <div>
              <Typography.Text style={LABEL_STYLE}>
                Measurement filter (hides annotations outside the range)
              </Typography.Text>
              <Slider
                range
                min={measurementRange[0]}
                max={measurementRange[1]}
                step={(measurementRange[1] - measurementRange[0]) / 200}
                value={settings.filterRange ?? measurementRange}
                onChange={(value) =>
                  onChange({
                    filterRange: normalizeFilterRange({
                      range: value as [number, number],
                      bounds: measurementRange,
                    }),
                  })
                }
              />
            </div>
          )}

        {status.isComputing && (
          <Typography.Text type="secondary" style={NOTE_STYLE}>
            Computing…
          </Typography.Text>
        )}

        {status.error !== null && (
          <Typography.Text type="danger" style={NOTE_STYLE}>
            {status.error}
          </Typography.Text>
        )}

        {status.warning !== null && (
          <Typography.Text type="warning" style={NOTE_STYLE}>
            {status.warning}
          </Typography.Text>
        )}

        <HeatmapLegend
          settings={settings}
          status={status}
          hoveredValue={hoveredValue}
        />
      </Space>
    </div>
  )
}

export default HeatmapMenu
