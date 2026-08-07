import { cleanup, fireEvent, render, screen } from '@testing-library/react'
// skipcq: JS-C1003 - dmv uses nested namespaces (dmv.annotation)
import type * as dmv from 'dicom-microscopy-viewer'

import HeatmapMenu from '../HeatmapMenu'
import type { MeasurementDescriptor } from '../SlideViewer/heatmap/annotationData'
import {
  DEFAULT_HEATMAP_SETTINGS,
  type HeatmapGrid,
  type HeatmapSettings,
  type HeatmapStatus,
  INITIAL_HEATMAP_STATUS,
} from '../SlideViewer/heatmap/types'

afterEach(cleanup)

const ANNOTATION_GROUPS = [
  { uid: '1.2.3', label: 'Nuclei' },
  { uid: '1.2.4', label: 'Cells' },
] as dmv.annotation.AnnotationGroup[]

const MEASUREMENTS: MeasurementDescriptor[] = [
  {
    index: 0,
    name: {
      CodeValue: '42798000',
      CodingSchemeDesignator: 'SCT',
      CodeMeaning: 'Area',
    } as MeasurementDescriptor['name'],
    key: 'SCT-42798000',
    label: 'Area',
    unit: 'um2',
  },
]

const GRID: HeatmapGrid = {
  values: Float32Array.from([1, 4]),
  counts: Uint32Array.from([1, 2]),
  width: 2,
  height: 1,
  binSizeUnits: 10,
  extent: [0, -10, 20, 0],
  minValue: 1,
  maxValue: 4,
  includedCount: 3,
}

/**
 * Render the panel with the given settings and status.
 *
 * @param options - Options
 * @param options.settings - Settings to override the defaults with
 * @param options.status - Status to override the initial status with
 * @param options.measurementRange - Bounds of the measurement filter slider
 * @param options.hoveredValue - Value of the bin under the cursor
 *
 * @returns The `onChange` spy the panel reports its patches to
 */
function renderMenu({
  settings = {},
  status = {},
  measurementRange = null,
  hoveredValue = null,
}: {
  settings?: Partial<HeatmapSettings>
  status?: Partial<HeatmapStatus>
  measurementRange?: [number, number] | null
  hoveredValue?: number | null
} = {}): jest.Mock {
  const onChange = jest.fn()
  render(
    <HeatmapMenu
      settings={{ ...DEFAULT_HEATMAP_SETTINGS, ...settings }}
      status={{ ...INITIAL_HEATMAP_STATUS, ...status }}
      annotationGroups={ANNOTATION_GROUPS}
      measurements={MEASUREMENTS}
      measurementRange={measurementRange}
      hoveredValue={hoveredValue}
      onChange={onChange}
    />,
  )
  return onChange
}

describe('HeatmapMenu', () => {
  it('reports a visibility change', () => {
    const onChange = renderMenu()
    fireEvent.click(screen.getByLabelText('Show heatmap'))
    expect(onChange).toHaveBeenCalledWith({ isVisible: true })
  })

  it('offers a measurement selector only for measurement metrics', () => {
    renderMenu({ settings: { metric: 'density' } })
    expect(screen.queryByText('Measurement')).toBeNull()
    cleanup()
    renderMenu({ settings: { metric: 'mean' } })
    expect(screen.getByText('Measurement')).toBeInTheDocument()
  })

  it('reports the coded concept of the selected measurement', async () => {
    const onChange = renderMenu({ settings: { metric: 'mean' } })
    fireEvent.mouseDown(screen.getByText('Select a measurement'))
    fireEvent.click(await screen.findByText('Area [um2]'))
    expect(onChange).toHaveBeenCalledWith({ measurement: MEASUREMENTS[0].name })
  })

  it('lists the annotation groups of the slide', async () => {
    const onChange = renderMenu()
    fireEvent.mouseDown(screen.getByText('Select an annotation group'))
    fireEvent.click(await screen.findByText('Cells'))
    expect(onChange).toHaveBeenCalledWith({ annotationGroupUID: '1.2.4' })
  })

  it('hides the annotation group selector for the ROI source', () => {
    renderMenu({ settings: { sourceKind: 'rois' } })
    expect(screen.queryByText('Annotation group')).toBeNull()
  })

  it('offers only density for the ROI source', async () => {
    /** Regions of interest carry no measurements to aggregate. */
    renderMenu({ settings: { sourceKind: 'rois' } })
    fireEvent.mouseDown(screen.getByText('Annotation density (count)'))
    const option = await screen.findByTitle('Mean of measurement')
    expect(option).toHaveClass('ant-select-item-option-disabled')
  })

  it('reports a bin size change', () => {
    const onChange = renderMenu()
    fireEvent.change(screen.getByLabelText('Bin size in micrometer'), {
      target: { value: '250' },
    })
    expect(onChange).toHaveBeenLastCalledWith({ binSizeMicrometer: 250 })
  })

  it('shows the legend only once a grid has been computed', () => {
    renderMenu()
    expect(screen.queryByTestId('heatmap-legend')).toBeNull()
    cleanup()
    renderMenu({ status: { grid: GRID, annotationCount: 3 } })
    expect(screen.getByTestId('heatmap-legend')).toBeInTheDocument()
  })

  it('shows the range of the grid and the bin under the cursor', () => {
    renderMenu({
      status: { grid: GRID, annotationCount: 3 },
      hoveredValue: 2.5,
    })
    const legend = screen.getByTestId('heatmap-legend')
    expect(legend).toHaveTextContent('1.00')
    expect(legend).toHaveTextContent('4.00')
    expect(legend).toHaveTextContent('Bin under cursor: 2.50')
  })

  it('shows a placeholder readout when the cursor is off the grid', () => {
    renderMenu({ status: { grid: GRID } })
    expect(screen.getByTestId('heatmap-legend')).toHaveTextContent(
      'Bin under cursor: —',
    )
  })

  it('disables the log scale for a range that includes zero', () => {
    renderMenu({ status: { grid: { ...GRID, minValue: 0 } } })
    expect(screen.getByLabelText('Log scale')).toBeDisabled()
  })

  it('enables the log scale for a strictly positive range', () => {
    renderMenu({ status: { grid: GRID } })
    expect(screen.getByLabelText('Log scale')).toBeEnabled()
  })

  it('lets the log scale be chosen before the first heatmap exists', () => {
    /*
     * Whether the values allow it is unknown until a grid has been computed,
     * and refusing until then would make the toggle look permanently broken
     * to anyone who sets it up before switching the heatmap on.
     */
    renderMenu({ status: { grid: null } })
    expect(screen.getByLabelText('Log scale')).toBeEnabled()
  })

  it('offers a measurement filter once the measurement range is known', () => {
    renderMenu({
      settings: { metric: 'mean', measurement: MEASUREMENTS[0].name },
      measurementRange: [0, 100],
    })
    expect(
      screen.getByText(
        'Measurement filter (hides annotations outside the range)',
      ),
    ).toBeInTheDocument()
  })

  it('does not offer a measurement filter for the density metric', () => {
    renderMenu({ settings: { metric: 'density' }, measurementRange: [0, 100] })
    expect(
      screen.queryByText(
        'Measurement filter (hides annotations outside the range)',
      ),
    ).toBeNull()
  })

  it('keeps the clamp inside the slider when the grid moved under it', () => {
    /*
     * A grid can widen without a settings patch to drop the clamp with, when
     * annotations finish loading, and a handle outside the track it is drawn
     * on cannot be moved back.
     */
    renderMenu({
      settings: { clampRange: [1, 40] },
      status: { grid: GRID, annotationCount: 3 },
    })
    const handle = screen
      .getAllByRole('slider')
      .find((element) => element.getAttribute('aria-valuenow') === '40')
    expect(handle).toBeDefined()
    expect(
      Number(handle?.getAttribute('aria-valuemax')),
    ).toBeGreaterThanOrEqual(40)
    expect(screen.getByTestId('heatmap-legend')).toHaveTextContent('40.00')
  })

  it('surfaces errors and warnings', () => {
    renderMenu({
      status: { error: 'Select an annotation group.', warning: 'Incomplete.' },
    })
    expect(screen.getByText('Select an annotation group.')).toBeInTheDocument()
    expect(screen.getByText('Incomplete.')).toBeInTheDocument()
  })
})
