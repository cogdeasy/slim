import { Layout, Menu } from 'antd'
// skipcq: JS-C1003
import * as dcmjs from 'dcmjs'
import { useEffect, useState } from 'react'
import { Route, Routes, useLocation, useParams } from 'react-router-dom'

import type { AnnotationSettings } from '../AppConfig'
import type { User } from '../auth'
import { PanelsProvider, usePanels } from '../contexts/PanelsContext'
import type DicomWebManager from '../DicomWebManager'
import type { Slide } from '../data/slides'
import { StorageClasses } from '../data/uids'
import { useSlides } from '../hooks/useSlides'
import { type RouteComponentProps, withRouter } from '../utils/router'
import ClinicalTrial from './ClinicalTrial'
import CollapsiblePanel from './CollapsiblePanel'
import Patient from './Patient'
import SlideList from './SlideList'
import SlideViewer from './SlideViewer'
import Study from './Study'

const { naturalizeDataset } = dcmjs.data.DicomMetaDictionary

interface NaturalizedInstance {
  SeriesInstanceUID: string
  SOPInstanceUID: string
  FrameOfReferenceUID?: string
  ContainerIdentifier?: string
  ReferencedSeriesSequence?: Array<{
    SeriesInstanceUID: string
  }>
  ContentSequence?: Array<{
    ConceptNameCodeSequence: Array<{
      CodeValue: string
    }>
    ContentSequence?: Array<{
      ContentSequence: Array<{
        ReferencedSOPSequence: Array<{
          ReferencedSOPInstanceUID: string
        }>
      }>
    }>
  }>
}

const findSeriesSlide = (
  slides: Slide[],
  seriesInstanceUID: string,
): Slide | undefined => {
  return slides.find((slide: Slide) => {
    return slide.seriesInstanceUIDs.find((uid: string) => {
      return uid === seriesInstanceUID
    })
  })
}

function ParametrizedSlideViewer({
  clients,
  slides,
  user,
  app,
  preload,
  enableAnnotationTools,
  annotations,
}: {
  clients: { [key: string]: DicomWebManager }
  slides: Slide[]
  user?: User
  app: {
    name: string
    version: string
    uid: string
    organization?: string
  }
  preload: boolean
  enableAnnotationTools: boolean
  annotations: AnnotationSettings[]
}): JSX.Element | null {
  const { studyInstanceUID = '', seriesInstanceUID = '' } = useParams<{
    studyInstanceUID: string
    seriesInstanceUID: string
  }>()
  const location = useLocation()

  const [selectedSlide, setSelectedSlide] = useState(
    findSeriesSlide(slides, seriesInstanceUID),
  )
  const [derivedDataset, setDerivedDataset] =
    useState<NaturalizedInstance | null>(null)

  useEffect(() => {
    const currentSlideMatchesSeries =
      selectedSlide?.seriesInstanceUIDs.some(
        (uid: string) => uid === seriesInstanceUID,
      ) ?? false

    if (
      selectedSlide === null ||
      selectedSlide === undefined ||
      !currentSlideMatchesSeries
    ) {
      const imageSlide = findSeriesSlide(slides, seriesInstanceUID)
      if (imageSlide !== null && imageSlide !== undefined) {
        setSelectedSlide(imageSlide)
        setDerivedDataset(null)
        return
      }

      const findReferencedSlide = async (): Promise<void> => {
        const client = clients[StorageClasses.VL_WHOLE_SLIDE_MICROSCOPY_IMAGE]
        const derivedSeriesMetadata = await client.retrieveSeriesMetadata({
          studyInstanceUID,
          seriesInstanceUID,
        })
        const naturalizedDerivedMetadata = naturalizeDataset(
          derivedSeriesMetadata[0],
        ) as NaturalizedInstance
        if (
          naturalizedDerivedMetadata.ReferencedSeriesSequence != null &&
          naturalizedDerivedMetadata.ReferencedSeriesSequence.length > 0
        ) {
          for (const referencedSeries of naturalizedDerivedMetadata.ReferencedSeriesSequence) {
            const referencedImageSeriesUID = referencedSeries.SeriesInstanceUID
            const referencedSlide = slides.find((slide: Slide) => {
              return slide.seriesInstanceUIDs.some(
                (uid: string) => uid === referencedImageSeriesUID,
              )
            })
            if (referencedSlide !== null && referencedSlide !== undefined) {
              setSelectedSlide(referencedSlide)
              setDerivedDataset(naturalizedDerivedMetadata)
              return
            }
          }
        }
        const IMAGE_LIBRARY_CONCEPT_NAME_CODE = '111028'
        const imageLibrary = naturalizedDerivedMetadata.ContentSequence?.find(
          (contentItem) =>
            contentItem.ConceptNameCodeSequence[0].CodeValue ===
            IMAGE_LIBRARY_CONCEPT_NAME_CODE,
        )
        if (
          imageLibrary?.ContentSequence?.[0]?.ContentSequence?.[0]
            ?.ReferencedSOPSequence?.[0] !== undefined &&
          imageLibrary?.ContentSequence?.[0]?.ContentSequence?.[0]
            ?.ReferencedSOPSequence?.[0] !== null
        ) {
          const referencedSOPInstanceUID =
            imageLibrary.ContentSequence[0].ContentSequence[0]
              .ReferencedSOPSequence[0].ReferencedSOPInstanceUID
          const referencedSlide = slides.find((slide: Slide) => {
            return slide.volumeImages.find(
              (image: { SOPInstanceUID: string }) => {
                return image.SOPInstanceUID === referencedSOPInstanceUID
              },
            )
          })
          setSelectedSlide(referencedSlide)
          setDerivedDataset(naturalizedDerivedMetadata)
        }
      }

      void findReferencedSlide()
    }
  }, [slides, clients, studyInstanceUID, seriesInstanceUID, selectedSlide])

  const searchParams = new URLSearchParams(location.search)
  let presentationStateUID: string | undefined
  if (!searchParams.has('access_token')) {
    const stateParam = searchParams.get('state')
    presentationStateUID = stateParam !== null ? stateParam : undefined
  }

  let viewer = null
  if (selectedSlide != null && selectedSlide !== undefined) {
    viewer = (
      <SlideViewer
        clients={clients}
        studyInstanceUID={studyInstanceUID}
        seriesInstanceUID={seriesInstanceUID}
        selectedPresentationStateUID={presentationStateUID}
        slide={selectedSlide}
        preload={preload}
        annotations={annotations}
        enableAnnotationTools={enableAnnotationTools}
        app={app}
        user={user}
        derivedDataset={derivedDataset ?? undefined}
      />
    )
  }
  return viewer
}

interface ViewerProps extends RouteComponentProps {
  clients: { [key: string]: DicomWebManager }
  studyInstanceUID: string
  app: {
    name: string
    version: string
    uid: string
    organization?: string
  }
  annotations: AnnotationSettings[]
  enableAnnotationTools: boolean
  preload: boolean
  user?: User
}

function Viewer(props: ViewerProps): JSX.Element | null {
  const { clients, studyInstanceUID, location, navigate } = props
  const { slides, isLoading } = useSlides({ clients, studyInstanceUID })
  const panels = usePanels()

  const handleSeriesSelection = ({
    seriesInstanceUID,
  }: {
    seriesInstanceUID: string
  }): void => {
    console.info(`switch to series "${seriesInstanceUID}"`)
    let urlPath = `/studies/${studyInstanceUID}/series/${seriesInstanceUID}`

    if (location.pathname.includes('/projects/')) {
      urlPath = location.pathname
      if (!location.pathname.includes('/series/')) {
        urlPath += `/series/${seriesInstanceUID}`
      } else {
        urlPath = urlPath.replace(
          /\/series\/[^/]+/,
          `/series/${seriesInstanceUID}`,
        )
      }
    }

    if (
      location.pathname.includes('/series/') &&
      location.search !== null &&
      location.search !== undefined
    ) {
      urlPath += location.search
    }

    navigate(urlPath, { replace: true })
  }

  if (isLoading) {
    return null
  }

  if (slides.length === 0) {
    return null
  }

  const firstSlide = slides[0]
  const volumeInstances = firstSlide.volumeImages
  if (volumeInstances.length === 0) {
    return null
  }
  const refImage = volumeInstances[0]

  /* If a series is encoded in the path, route the viewer to this series.
   * Otherwise select the first series correspondent to
   * the first slide contained in the study.
   */
  let selectedSeriesInstanceUID: string
  if (location.pathname.includes('series/')) {
    const seriesFragment = location.pathname.split('series/')[1]
    selectedSeriesInstanceUID = seriesFragment.includes('/')
      ? seriesFragment.split('/')[0]
      : seriesFragment
  } else {
    selectedSeriesInstanceUID = volumeInstances[0].SeriesInstanceUID
  }

  let clinicalTrialMenu: React.ReactNode
  if (refImage.ClinicalTrialSponsorName != null) {
    clinicalTrialMenu = (
      <Menu.SubMenu key="clinical-trial" title="Clinical Trial">
        <ClinicalTrial metadata={refImage} />
      </Menu.SubMenu>
    )
  }

  return (
    <Layout style={{ height: '100%' }} hasSider>
      <CollapsiblePanel
        side="left"
        label="case panel"
        isCollapsed={panels?.isLeftPanelCollapsed ?? false}
        onToggle={panels?.toggleLeftPanel ?? (() => {})}
        style={{
          borderRight: 'solid',
          borderRightWidth: 0.25,
        }}
      >
        <Menu
          mode="inline"
          defaultOpenKeys={['patient', 'study', 'clinical-trial', 'slides']}
          inlineIndent={14}
        >
          <Menu.SubMenu key="patient" title="Patient">
            <Patient metadata={refImage} />
          </Menu.SubMenu>
          <Menu.SubMenu key="study" title="Study">
            <Study metadata={refImage} />
          </Menu.SubMenu>
          {clinicalTrialMenu}
          <Menu.SubMenu key="slides" title="Slides">
            <SlideList
              clients={props.clients}
              metadata={slides}
              selectedSeriesInstanceUID={selectedSeriesInstanceUID}
              onSeriesSelection={handleSeriesSelection}
            />
          </Menu.SubMenu>
        </Menu>
      </CollapsiblePanel>

      <Routes>
        <Route
          path="/series/:seriesInstanceUID"
          element={
            <ParametrizedSlideViewer
              clients={props.clients}
              slides={slides}
              preload={props.preload}
              annotations={props.annotations}
              enableAnnotationTools={props.enableAnnotationTools}
              app={props.app}
              user={props.user}
            />
          }
        />
      </Routes>
    </Layout>
  )
}

function ViewerWithPanels(props: ViewerProps): JSX.Element {
  return (
    <PanelsProvider>
      <Viewer {...props} />
    </PanelsProvider>
  )
}

export default withRouter(ViewerWithPanels)
