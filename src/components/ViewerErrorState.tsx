import { Collapse, Result, Typography } from 'antd'
import { Link } from 'react-router-dom'
import {
  describeError,
  getImpactStatement,
  type UserFacingError,
} from '../utils/userFacingErrors'

/**
 * Error state that is rendered in place of the viewport when a slide cannot be
 * displayed, so that the user gets an explanation instead of a blank canvas.
 * The underlying error remains available in the collapsible detail section and
 * in the console.
 */
export const ViewerErrorState = ({
  error,
  userFacingError,
}: {
  error?: unknown
  userFacingError?: UserFacingError
}): JSX.Element => {
  const description = userFacingError ?? describeError(error)
  const impactStatement = getImpactStatement(description.impact)
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : undefined

  return (
    <Result
      status="warning"
      title={description.title}
      subTitle={
        <span>
          {description.description}
          {impactStatement !== '' ? (
            <>
              <br />
              {impactStatement}
            </>
          ) : null}
        </span>
      }
      extra={
        <>
          <Link to="/">Back to the worklist</Link>
          {detail !== undefined ? (
            <Collapse ghost style={{ marginTop: 16, textAlign: 'left' }}>
              <Collapse.Panel header="Technical detail" key="detail">
                <Typography.Paragraph
                  copyable
                  style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}
                >
                  {detail}
                </Typography.Paragraph>
              </Collapse.Panel>
            </Collapse>
          ) : null}
        </>
      }
    />
  )
}

export default ViewerErrorState
