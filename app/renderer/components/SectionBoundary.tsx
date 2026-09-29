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
 * It stays failed while `resetKey` stays the one it failed on, and tries again
 * when a new one arrives: a reload of the check-ins is new data. The key is
 * recorded as each render starts, not compared with the previous props after
 * it — a reload brings the new key and the record that breaks the section in
 * the same commit, and comparing with the previous props saw a change there and
 * drew the same data twice (review of #164). Keyed here rather than left to
 * the page being unmounted and drawn afresh, which today every reload happens
 * to do: an invariant in another file, and one the next way of refreshing
 * would break.
 */
interface Props {
  /** Said in the section's place: what could not be shown. */
  fallback: string
  /** The section's own box, so the gap sits where the section was. */
  className: string
  /** `main` when the section is the whole screen, so the sentence keeps the page's landmark. */
  as?: 'div' | 'main'
  /** What the section is drawn from; a new one is worth another try. */
  resetKey?: unknown
  /**
   * A failure found before drawing, by whoever computes what the section
   * shows — and logged by them. The section shows its sentence as if it had
   * thrown (review of #164: one record `presentAll` cannot present).
   */
  alreadyFailed?: boolean
  /**
   * Called once when the section throws. For a section whose state outlives
   * it and must not be stranded: a capture still running, a reading still
   * submittable (review of #164).
   */
  onFailure?: (error: unknown) => void
  /** Offered as "Try again" under the sentence. */
  onRetry?: () => void
  children: ReactNode
}

interface State {
  failed: boolean
  /** The `resetKey` this render is drawing from. */
  key: unknown
}

export default class SectionBoundary extends Component<Props, State> {
  override state: State = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey }
  }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('A dashboard section could not be drawn.', error, info.componentStack)
    this.props.onFailure?.(error)
  }

  override render(): ReactNode {
    if (!this.state.failed && this.props.alreadyFailed !== true) return this.props.children
    const Box = this.props.as ?? 'div'
    return (
      <Box className={this.props.className}>
        <p className="text-sm text-(--color-muted)">{this.props.fallback}</p>
        {this.props.onRetry !== undefined && (
          <button
            type="button"
            onClick={this.props.onRetry}
            className="mt-3 rounded-lg border border-(--color-line) px-4 py-2 text-sm hover:bg-(--color-raised)"
          >
            Try again
          </button>
        )}
      </Box>
    )
  }
}
