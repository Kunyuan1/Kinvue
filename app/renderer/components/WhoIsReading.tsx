import type { PersonShown } from '../../shared/people'
import { PERSON_BUTTON, PERSON_CHOICE, PERSON_NOTE, useFocusWhenShown } from './person'

/**
 * *Who is taking the reading?* (KV-18): asked before every reading on a
 * computer where more than one person takes them, so a reading is filed under
 * the person who sat down — never under whoever the dashboard last showed,
 * which would put it in the wrong baseline without anyone noticing.
 *
 * On the cared-for person's path, so sized as it is (KV-20): the heading takes
 * focus, and the first name is one Tab after it. One column of names however
 * many there are, so the list grows down and the page scrolls, never sideways.
 * The demo is never here: no reading is ever taken as it.
 */
export default function WhoIsReading({
  people,
  onChoose,
  onCancel,
}: {
  /** Everyone who takes readings here, each named. */
  people: PersonShown[]
  onChoose: (person: PersonShown) => void
  onCancel: () => void
}): React.JSX.Element {
  const heading = useFocusWhenShown<HTMLHeadingElement>()
  return (
    <section className="mx-auto max-w-xl">
      <h2 ref={heading} tabIndex={-1} className="text-center text-2xl font-semibold">
        Who is taking the reading?
      </h2>
      <p className={`mt-3 text-center ${PERSON_NOTE}`}>
        The reading is kept with the name pressed, and compared with their own usual.
      </p>
      <ul className="mt-6 space-y-3">
        {people.map((person) => (
          <li key={person.id}>
            <button
              type="button"
              onClick={() => onChoose(person)}
              className={`${PERSON_CHOICE} border-(--color-control) hover:border-(--color-muted)`}
            >
              {/* Named by the time this is shown: an unnamed person sends the
                  caregiver to the setup screen instead. */}
              {person.name}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onCancel} className={`mt-6 ${PERSON_BUTTON}`}>
        Go back
      </button>
    </section>
  )
}
