import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Keeps a section that fails to draw from taking the dashboard with it
 * (KV-163).
 *
 * React unmounts the whole tree on a render error nothing catches. In review of
 * #162 a record with `timeZone: ''` made `Intl` throw in the trend chart, and
 * the caregiver lost every check-in card with it — the chart was the only part
 * that could not be drawn. Each section is wrapped on its own, so a failure is
 * a gap where that section was, said in a sentence, and the rest stays.
 *
 * The sentence is the caregiver's, not a diagnosis of the code: what could not
 * be shown, and that nothing stored was lost. The error itself goes to the
 * console for whoever is developing.
 *
 * It stays failed until the dashboard is drawn afresh — leaving for a reading
 * and coming back does that — rather than retrying on every render the same
 * data that just threw.
 */
export default class SectionBoundary extends Component<
  {
    /** Said in the section's place: what could not be shown. */
    fallback: string
    /** The section's own box, so the gap sits where the section was. */
    className: string
    children: ReactNode
  },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A dashboard section could not be drawn.', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className={this.props.className}>
        <p className="text-sm text-(--color-muted)">{this.props.fallback}</p>
      </div>
    )
  }
}
