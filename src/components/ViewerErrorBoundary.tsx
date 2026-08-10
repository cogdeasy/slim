import React from 'react'
import { describeError } from '../utils/userFacingErrors'
import ViewerErrorState from './ViewerErrorState'

interface ViewerErrorBoundaryState {
  error?: Error
}

/**
 * Error boundary around the slide viewer. Rendering failures of the viewer,
 * such as a slide whose optical paths do not share a pyramid, would otherwise
 * unmount the whole page and leave the user with a blank screen.
 */
class ViewerErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ViewerErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = {}
  }

  static getDerivedStateFromError(error: Error): ViewerErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('Slide viewer failed to render: ', error, info)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (error !== undefined) {
      return (
        <ViewerErrorState
          error={error}
          userFacingError={describeError(error)}
        />
      )
    }
    return this.props.children
  }
}

export default ViewerErrorBoundary
