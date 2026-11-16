// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import ConfirmDeletion from '@renderer/components/ConfirmDeletion'

/**
 * The shell every deletion is confirmed in, on its own (KV-235). What follows a
 * deletion that landed is outside the reach of the handler that says the
 * deletion failed: by then it cannot be undone, and "nothing has been changed"
 * would be false. A rule in a comment was how the bug got in, so this is the
 * shape, held here whatever a caller does.
 */
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const shown = (over: {
  onDelete: () => Promise<number>
  onDeleted: (removed: number) => void
  onFailure: (e: unknown) => void
}): void => {
  render(
    <ConfirmDeletion
      heading="Delete this check-in?"
      deleteLabel="Delete"
      afterNote="An export is a copy to keep."
      onExport={() => Promise.resolve(null)}
      onCancel={() => undefined}
      {...over}
    >
      <li>This cannot be undone.</li>
    </ConfirmDeletion>,
  )
}

describe('ConfirmDeletion: the deletion, and what follows it, apart (KV-235)', () => {
  it('hands what was deleted to what follows, and reports no failure', async () => {
    const onDeleted = vi.fn()
    const onFailure = vi.fn()
    shown({ onDelete: () => Promise.resolve(2), onDeleted, onFailure })
    fireEvent.click(screen.getByText('Delete'))
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledWith(2))
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('says the deletion failed when it did, and runs nothing after it', async () => {
    const onDeleted = vi.fn()
    const onFailure = vi.fn()
    const refused = new Error('EBUSY')
    shown({ onDelete: () => Promise.reject(refused), onDeleted, onFailure })
    fireEvent.click(screen.getByText('Delete'))
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledWith(refused))
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('never says the deletion failed for something that went wrong after it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const after = new Error('the reload failed')
    const onDeleted = vi.fn(() => {
      throw after
    })
    const onFailure = vi.fn()
    shown({ onDelete: () => Promise.resolve(1), onDeleted, onFailure })
    fireEvent.click(screen.getByText('Delete'))
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledWith(1))
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(after))
    expect(onFailure).not.toHaveBeenCalled()
  })
})
