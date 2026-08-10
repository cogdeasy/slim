import React, { useCallback, useMemo, useState } from 'react'

export const LEFT_PANEL_STORAGE_KEY = 'slim_left_panel_collapsed'
export const RIGHT_PANEL_STORAGE_KEY = 'slim_right_panel_collapsed'

export interface PanelsContextValue {
  isLeftPanelCollapsed: boolean
  isRightPanelCollapsed: boolean
  toggleLeftPanel: () => void
  toggleRightPanel: () => void
}

const PanelsContext = React.createContext<PanelsContextValue | null>(null)

export const usePanels = (): PanelsContextValue | null =>
  React.useContext(PanelsContext)

const readStoredState = (key: string): boolean => {
  return window.localStorage.getItem(key) === 'true'
}

interface PanelsProviderProps {
  children: React.ReactNode
}

/**
 * Provides the collapsed state of the left and right panels of the viewer.
 * The state is persisted in local storage so that it is retained while
 * navigating between slides.
 */
export const PanelsProvider: React.FC<PanelsProviderProps> = ({ children }) => {
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(() =>
    readStoredState(LEFT_PANEL_STORAGE_KEY),
  )
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(() =>
    readStoredState(RIGHT_PANEL_STORAGE_KEY),
  )

  const toggleLeftPanel = useCallback((): void => {
    setIsLeftPanelCollapsed((isCollapsed) => {
      window.localStorage.setItem(LEFT_PANEL_STORAGE_KEY, String(!isCollapsed))
      return !isCollapsed
    })
  }, [])

  const toggleRightPanel = useCallback((): void => {
    setIsRightPanelCollapsed((isCollapsed) => {
      window.localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(!isCollapsed))
      return !isCollapsed
    })
  }, [])

  const value = useMemo(
    () => ({
      isLeftPanelCollapsed,
      isRightPanelCollapsed,
      toggleLeftPanel,
      toggleRightPanel,
    }),
    [
      isLeftPanelCollapsed,
      isRightPanelCollapsed,
      toggleLeftPanel,
      toggleRightPanel,
    ],
  )

  return (
    <PanelsContext.Provider value={value}>{children}</PanelsContext.Provider>
  )
}

interface PanelsCollapseObserverProps {
  onCollapseChange: () => void
}

/**
 * Invokes a callback whenever the collapsed state of one of the panels
 * changes. Allows class components to react to panel layout changes.
 */
export const PanelsCollapseObserver: React.FC<PanelsCollapseObserverProps> = ({
  onCollapseChange,
}) => {
  const panels = usePanels()
  const onCollapseChangeRef = React.useRef(onCollapseChange)
  onCollapseChangeRef.current = onCollapseChange

  const _isLeftPanelCollapsed = panels?.isLeftPanelCollapsed
  const _isRightPanelCollapsed = panels?.isRightPanelCollapsed

  React.useEffect(() => {
    onCollapseChangeRef.current()
  }, [])

  return null
}
