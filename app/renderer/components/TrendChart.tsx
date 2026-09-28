import { useMemo, useState } from 'react'
import type { ComparedMetric, SessionRecord } from '@core/session/types'
import {
  axisTicks,
  TREND_METRICS,
  trendNotes,
  trendOf,
  trendTitle,
  usualLabel,
  type Trend,
  type TrendPoint,
} from '@core/trend'
import { METRIC_NAME, READING_LABEL, READING_UNIT, readingText } from '@core/scoring'
import { knownZone } from '@core/session/time'

/**
 * One metric over the baseline window, the latest check-in marked and their
 * usual drawn behind it (KV-4). The series and every sentence under it come
 * from `core/trend`; this only draws them.
 *
 * Hand-drawn SVG rather than a chart library: one line, three runtime
 * dependencies kept at three (decided by the owner). Placed by date, so a gap
 * in the check-ins shows as one.
 */

// The drawing's own coordinates; the SVG scales to the card's width.
const W = 640
const H = 180
// The right margin holds the latest value, where no line or gridline reaches.
const PAD = { left: 40, right: 72, top: 16, bottom: 28 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

/** The day a point was captured, where it was captured (KV-28). */
/**
 * Whether dates need a year: when the points cross into another year. The
 * window has no age bound, so for someone checking in monthly it can hold two
 * "Mar 3"s (review of #162).
 */
function spansYears(points: readonly TrendPoint[]): boolean {
  // The year each date is printed with, in its own zone, not the UTC one: near
  // New Year the two differ (second review of #162).
  const years = new Set(
    points.map((p) =>
      new Date(p.capturedAt).toLocaleDateString('en-US', { ...inZone(p), year: 'numeric' }),
    ),
  )
  return years.size > 1
}

/**
 * `knownZone`, not the raw field: '' or an unknown zone throws, and this is
 * drawn above every card (review of #162).
 */
function inZone(point: TrendPoint): { timeZone?: string } {
  const zone = knownZone(point.timeZone)
  return zone === undefined ? {} : { timeZone: zone }
}

function dayOf(point: TrendPoint, withYear: boolean): string {
  return new Date(point.capturedAt).toLocaleDateString(undefined, {
    ...inZone(point),
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  })
}

function Plot({ trend }: { trend: Trend }): React.JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null)
  const unit = READING_UNIT[trend.metric]
  const points = trend.points
  const withYear = spansYears(points)

  const times = points.map((p) => Date.parse(p.capturedAt))
  const t0 = Math.min(...times)
  const t1 = Math.max(...times)
  const values = [...points.map((p) => p.value), ...(trend.usual === null ? [] : [trend.usual])]
  const spread = Math.max(...values) - Math.min(...values)
  const pad = spread === 0 ? Math.max(1, Math.abs(values[0] ?? 1) * 0.1) : spread * 0.15
  const lo = Math.min(...values) - pad
  const hi = Math.max(...values) + pad

  const x = (t: number): number =>
    t1 === t0 ? PAD.left + PLOT_W / 2 : PAD.left + ((t - t0) / (t1 - t0)) * PLOT_W
  const y = (v: number): number => PAD.top + (1 - (v - lo) / (hi - lo)) * PLOT_H
  const xy = points.map((p, i) => ({
    p,
    cx: x(times[i] ?? t0),
    cy: y(p.value),
  }))
  const path = xy.map(({ cx, cy }, i) => `${i === 0 ? 'M' : 'L'}${cx},${cy}`).join(' ')
  const ticks = axisTicks(lo, hi)
  const label = usualLabel(trend)
  const first = xy[0]
  const last = xy[xy.length - 1]
  const focus = hovered === null ? null : (xy[hovered] ?? null)

  // The crosshair snaps to the nearest check-in in time.
  const onMove = (e: React.PointerEvent<SVGRectElement>): void => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (box === undefined || box.width === 0) return
    const px = ((e.clientX - box.left) / box.width) * W
    let best = 0
    xy.forEach(({ cx }, i) => {
      if (Math.abs(cx - px) < Math.abs((xy[best]?.cx ?? 0) - px)) best = i
    })
    setHovered(best)
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${trendTitle(trend)}${label === null ? '' : ` Line: ${label}.`}`}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--color-line)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={y(t)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--color-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {t}
            </text>
          </g>
        ))}

        {/* Labelled in the key below, not here: the line it would sit on is
            where a reading that moved away from it crosses. */}
        {trend.usual !== null && (
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(trend.usual)}
            y2={y(trend.usual)}
            stroke="var(--color-muted)"
            strokeWidth={1}
          />
        )}

        {xy.length > 1 && (
          <path
            d={path}
            fill="none"
            stroke="var(--color-series)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {focus !== null && (
          <line
            x1={focus.cx}
            x2={focus.cx}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke="var(--color-muted)"
            strokeWidth={1}
          />
        )}

        {xy.map(({ p, cx, cy }) => (
          <circle
            key={p.id}
            cx={cx}
            cy={cy}
            // A filled dot's surface ring covers half its stroke, so it is drawn
            // a step larger than a hollow one to read the same size.
            r={p.latest ? 7 : p.seeded ? 4 : 5}
            // Seeded days are hollow (KV-8): never plotted as if measured.
            fill={p.seeded ? 'var(--color-raised)' : 'var(--color-series)'}
            stroke={p.seeded ? 'var(--color-series)' : 'var(--color-raised)'}
            strokeWidth={2}
            data-seeded={p.seeded}
            data-latest={p.latest}
          />
        ))}

        {last?.p.latest === true && (
          <text
            x={last.cx + 12}
            y={last.cy}
            dominantBaseline="middle"
            fontSize={12}
            fill="var(--color-ink)"
          >
            {`${readingText(last.p.value)} ${unit}`}
          </text>
        )}

        {/* A lone point is drawn mid-plot, so its date goes under it, not at
            the left edge (second review of #162). */}
        {first !== undefined && (
          <text
            x={first === last ? first.cx : PAD.left}
            y={H - 8}
            textAnchor={first === last ? 'middle' : 'start'}
            fontSize={11}
            fill="var(--color-muted)"
            data-axis-date
          >
            {dayOf(first.p, withYear)}
          </text>
        )}
        {last !== undefined && last !== first && (
          <text
            x={last.cx}
            y={H - 8}
            textAnchor="end"
            fontSize={11}
            fill="var(--color-muted)"
            data-axis-date
          >
            {dayOf(last.p, withYear)}
          </text>
        )}

        <rect
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHovered(null)}
        />
      </svg>

      {/* Not a live region: it changes on every pointer move, and a screen
          reader would announce each point crossed. The table below says the
          same, calmly (second review of #162). */}
      {focus !== null && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-0 rounded-md border border-(--color-line) bg-(--color-ground) px-2 py-1 text-xs"
          style={{
            left: `${(focus.cx / W) * 100}%`,
            transform: focus.cx > W / 2 ? 'translateX(-100%)' : undefined,
          }}
        >
          <p className="font-medium">{`${readingText(focus.p.value)} ${unit}`}</p>
          <p className="text-(--color-muted)">
            {dayOf(focus.p, withYear)}
            {focus.p.latest ? ' · latest' : ''}
            {focus.p.seeded ? ' · seeded demo data' : ''}
          </p>
        </div>
      )}
    </div>
  )
}

/** The sentences under the chart, from `core/trend`. */
function Notes({ trend }: { trend: Trend }): React.JSX.Element {
  return (
    <>
      {trendNotes(trend).map((note) => (
        <p key={note} className="mt-1 text-sm text-(--color-muted)">
          {note}
        </p>
      ))}
    </>
  )
}

export default function TrendChart({
  records,
  personId,
}: {
  records: readonly SessionRecord[]
  personId: string
}): React.JSX.Element | null {
  const [metric, setMetric] = useState<ComparedMetric>('pulse')
  const trend = useMemo(() => trendOf(records, personId, metric), [records, personId, metric])
  // No usable check-in at all — for any metric, since that is what null means:
  // nothing to draw, and the cards say why.
  if (trend === null) return null

  const unit = READING_UNIT[metric]
  const withYear = spansYears(trend.points)
  const measuredPoints = trend.points.length - trend.seededPoints
  return (
    <section className="mb-8 rounded-xl border border-(--color-line) bg-(--color-raised) p-5">
      <div className="mb-3 flex gap-2" role="group" aria-label="Metric">
        {TREND_METRICS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={m === metric}
            onClick={() => setMetric(m)}
            className={`rounded-md border px-3 py-1 text-sm ${
              m === metric
                ? 'border-(--color-muted) text-(--color-ink)'
                : 'border-(--color-line) text-(--color-muted) hover:bg-(--color-ground)'
            }`}
          >
            {READING_LABEL[m]}
          </button>
        ))}
      </div>

      {trend.points.length === 0 ? (
        <>
          <p className="text-sm text-(--color-muted)">
            {`No ${METRIC_NAME[metric]} readings to draw.`}
          </p>
          {/* The notes still stand with nothing drawn: this is the tab where a
              caregiver has least else to go on (second review of #162). */}
          <Notes trend={trend} />
        </>
      ) : (
        <>
          <h2 className="mb-2 text-sm font-medium">{trendTitle(trend)}</h2>
          {/* Keyed by metric: a hovered index is a point on one metric's line,
              and a tab changed from the keyboard never fires pointerleave
              (second review of #162). */}
          <Plot key={metric} trend={trend} />
          <p className="mt-2 flex flex-wrap items-center gap-4 text-xs text-(--color-muted)">
            {usualLabel(trend) !== null && (
              <span className="flex items-center gap-1">
                <svg width="14" height="10" aria-hidden="true">
                  <line x1="0" x2="14" y1="5" y2="5" stroke="var(--color-muted)" strokeWidth="1" />
                </svg>
                {usualLabel(trend)}
              </span>
            )}
            {/* Each kind keyed only if it is on the chart: an all-seeded demo
                has no filled dot to explain (review of #162). */}
            {trend.seededPoints > 0 && (
              <>
                {measuredPoints > 0 && (
                  <span className="flex items-center gap-1">
                    <svg width="10" height="10" aria-hidden="true">
                      <circle cx="5" cy="5" r="4" fill="var(--color-series)" />
                    </svg>
                    measured
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <svg width="10" height="10" aria-hidden="true">
                    <circle
                      cx="5"
                      cy="5"
                      r="3.5"
                      fill="none"
                      stroke="var(--color-series)"
                      strokeWidth="1.5"
                    />
                  </svg>
                  seeded demo data
                </span>
              </>
            )}
          </p>
          <Notes trend={trend} />
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-(--color-muted)">Show as a table</summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-(--color-muted)">
                <tr>
                  <th className="font-normal">Date</th>
                  <th className="font-normal">{`${READING_LABEL[metric]} (${unit})`}</th>
                  <th className="font-normal" />
                </tr>
              </thead>
              <tbody style={{ fontVariantNumeric: 'tabular-nums' }}>
                {[...trend.points].reverse().map((p) => (
                  <tr key={p.id}>
                    <td>{dayOf(p, withYear)}</td>
                    <td>{readingText(p.value)}</td>
                    <td className="text-(--color-muted)">
                      {[p.latest ? 'latest' : '', p.seeded ? 'seeded demo data' : '']
                        .filter((s) => s !== '')
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  )
}
