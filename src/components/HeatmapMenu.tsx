import {
  Col,
  Divider,
  InputNumber,
  Row,
  Select,
  Slider,
  Space,
  Switch,
  Typography,
} from 'antd'
// skipcq: JS-C1003
import type * as dmv from 'dicom-microscopy-viewer'
import type React from 'react'
import { FaEye, FaEyeSlash } from 'react-icons/fa'
import OpacitySlider from './OpacitySlider'
import type { MeasurementDescriptor } from './SlideViewer/heatmap/annotationData'
import {
  COLORMAP_NAMES,
  getColormapGradientCss,
} from './SlideViewer/heatmap/colormap'
import type { HeatmapStatus } from './SlideViewer/heatmap/HeatmapController'
import type {
  HeatmapMetric,
  HeatmapSettings,
} from './SlideViewer/heatmap/types'

const METRIC_OPTIONS: Array<{ value: HeatmapMetric; label: string }> = [
  { value: 'density', label: 'Annotation density (count)' },
  { value: 'mean', label: 'Mean of measurement' },
  { value: 'max', label: 'Max of measurement' },
  { value: 'sum', label: 'Sum of measurement' },
]

interface HeatmapMenuProps {
  settings: HeatmapSettings
  status: HeatmapStatus
  annotationGroups: dmv.annotation.AnnotationGroup[]
  measurements: MeasurementDescriptor[]
  /** Full range of the selected measurement, for the filter slider bounds. */
  measurementRange: [number, number] | null
  hoveredValue: number | null
  onChange: (patch: Partial<HeatmapSettings>) => void
}

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  lineHeight: '18px',
}

function formatValue(value: number): string {
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
 * Legend: colour ramp between the effective minimum and maximum, plus the
 * value of the bin currently under the cursor.
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
  return (
    <div style={{ marginTop: '8px' }}>
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
          <Typography.Text type="secondary" style={{ fontSize: '11px' }}>
            {formatValue(low)}
          </Typography.Text>
        </Col>
        <Col>
          <Typography.Text type="secondary" style={{ fontSize: '11px' }}>
            {settings.useLogScale ? 'log scale' : ''}
          </Typography.Text>
        </Col>
        <Col>
          <Typography.Text type="secondary" style={{ fontSize: '11px' }}>
            {formatValue(high)}
          </Typography.Text>
        </Col>
      </Row>
      <Typography.Text style={{ fontSize: '12px' }}>
        Bin under cursor:{' '}
        <strong>
          {hoveredValue === null ? '—' : formatValue(hoveredValue)}
        </strong>
      </Typography.Text>
      <br />
      <Typography.Text type="secondary" style={{ fontSize: '11px' }}>
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
 * Sidebar controls for the annotation heatmap overlay.
 *
 * Rough spike UI: laid out with the same antd primitives as
 * `AnnotationGroupItem` but without the popover/badge chrome, so that every
 * control is visible at once while evaluating the feature.
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
  const requiresMeasurement = settings.metric !== 'density'
  const grid = status.grid

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
          <Typography.Text style={LABEL_STYLE}>Source</Typography.Text>
          <Select
            style={{ width: '100%' }}
            size="small"
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
            <Typography.Text style={LABEL_STYLE}>
              Annotation group
            </Typography.Text>
            <Select
              style={{ width: '100%' }}
              size="small"
              placeholder="Select an annotation group"
              value={settings.annotationGroupUID}
              onChange={(value) =>
                onChange({
                  annotationGroupUID: value,
                  measurement: undefined,
                  filterRange: undefined,
                })
              }
              options={annotationGroups.map((group) => ({
                value: group.uid,
                label: group.label,
              }))}
            />
          </div>
        )}

        <div>
          <Typography.Text style={LABEL_STYLE}>Metric</Typography.Text>
          <Select
            style={{ width: '100%' }}
            size="small"
            value={settings.metric}
            onChange={(value) => onChange({ metric: value })}
            options={METRIC_OPTIONS}
          />
        </div>

        {requiresMeasurement && (
          <div>
            <Typography.Text style={LABEL_STYLE}>Measurement</Typography.Text>
            <Select
              style={{ width: '100%' }}
              size="small"
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
              min={1}
              max={5000}
              size="small"
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
          <Typography.Text style={LABEL_STYLE}>Colormap</Typography.Text>
          <Select
            style={{ width: '100%' }}
            size="small"
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
              style={{ width: '70px' }}
              value={settings.smoothingSigmaBins}
              onChange={(value) => onChange({ smoothingSigmaBins: value ?? 0 })}
            />
          </Col>
        </Row>

        <Row justify="space-between" align="middle">
          <Col>Log scale</Col>
          <Col>
            <Switch
              size="small"
              checked={settings.useLogScale}
              onChange={(checked) => onChange({ useLogScale: checked })}
            />
          </Col>
        </Row>

        {grid !== null && (
          <div>
            <Typography.Text style={LABEL_STYLE}>
              Value range clamp
            </Typography.Text>
            <Slider
              range
              min={grid.minValue}
              max={grid.maxValue}
              step={(grid.maxValue - grid.minValue) / 100 || 1}
              value={settings.clampRange ?? [grid.minValue, grid.maxValue]}
              onChange={(value) =>
                onChange({ clampRange: value as [number, number] })
              }
            />
          </div>
        )}

        {requiresMeasurement && measurementRange !== null && (
          <div>
            <Typography.Text style={LABEL_STYLE}>
              Measurement filter (hides annotations outside the range)
            </Typography.Text>
            <Slider
              range
              min={measurementRange[0]}
              max={measurementRange[1]}
              step={(measurementRange[1] - measurementRange[0]) / 200 || 1}
              value={settings.filterRange ?? measurementRange}
              onChange={(value) =>
                onChange({ filterRange: value as [number, number] })
              }
            />
          </div>
        )}

        {status.error !== null && (
          <Typography.Text type="warning" style={{ fontSize: '11px' }}>
            {status.error}
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
