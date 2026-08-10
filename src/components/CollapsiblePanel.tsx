import { Button, Layout, Tooltip } from 'antd'
import type React from 'react'
import { FaAngleDoubleLeft, FaAngleDoubleRight } from 'react-icons/fa'

import './CollapsiblePanel.css'

export const PANEL_WIDTH = 300
export const COLLAPSED_PANEL_WIDTH = 32
/** Duration of the collapse/expand transition in milliseconds. */
export const PANEL_TRANSITION_DURATION = 250

interface CollapsiblePanelProps {
  side: 'left' | 'right'
  label: string
  isCollapsed: boolean
  onToggle: () => void
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}

/**
 * Panel that can be collapsed to a narrow rail, which retains the button to
 * expand the panel again.
 */
const CollapsiblePanel: React.FC<CollapsiblePanelProps> = ({
  side,
  label,
  isCollapsed,
  onToggle,
  className,
  style,
  children,
}) => {
  const isPointingLeft = side === 'left' ? !isCollapsed : isCollapsed
  const Icon = isPointingLeft ? FaAngleDoubleLeft : FaAngleDoubleRight
  const action = isCollapsed ? 'Expand' : 'Collapse'
  const description = `${action} ${label}`

  return (
    <Layout.Sider
      width={PANEL_WIDTH}
      collapsedWidth={COLLAPSED_PANEL_WIDTH}
      collapsed={isCollapsed}
      trigger={null}
      reverseArrow={side === 'right'}
      className={
        className !== undefined
          ? `slim-collapsible-panel ${className}`
          : 'slim-collapsible-panel'
      }
      style={style}
    >
      <div
        className="slim-collapsible-panel-header"
        style={{
          justifyContent: side === 'left' ? 'flex-end' : 'flex-start',
        }}
      >
        <Tooltip title={description}>
          <Button
            type="text"
            size="small"
            aria-label={description}
            aria-expanded={!isCollapsed}
            icon={<Icon />}
            onClick={onToggle}
          />
        </Tooltip>
      </div>
      <div
        className="slim-collapsible-panel-body"
        style={{ display: isCollapsed ? 'none' : 'block' }}
      >
        {children}
      </div>
    </Layout.Sider>
  )
}

export default CollapsiblePanel
