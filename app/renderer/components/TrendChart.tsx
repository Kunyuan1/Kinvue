import { useMemo, useState } from "react";
import type { ComparedMetric, SessionRecord } from "@core/session/types";
import {
  TREND_METRICS,
  trendNotes,
  trendOf,
  trendTitle,
  usualLabel,
  type Trend,
  type TrendPoint,
} from "@core/trend";
import { METRIC_NAME, METRIC_UNIT } from "@core/scoring";

/**
 * One metric over the baseline window, the latest check-in marked and their
 * usual drawn behind it (KV-4). The series and every sentence under it come
 * from `core/trend`; this only draws them.
 *
 * Hand-drawn SVG rather than a chart library: one line, three runtime
 * dependencies kept at three (decided by the owner). Placed by date, so a gap
 * in the check-ins shows as one.
 */

const TAB_LABEL: Record<ComparedMetric, string> = {
  pulse: "Pulse",
  breathing: "Breathing",
  hrv: "HRV",
};

// The drawing's own coordinates; the SVG scales to the card's width.
const W = 640;
const H = 180;
// The right margin holds the latest value, where no line or gridline reaches.
const PAD = { left: 40, right: 72, top: 16, bottom: 28 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Three or four round ticks covering [lo, hi]: steps of 1, 2 or 5 × 10^k. */
function ticksFor(lo: number, hi: number): number[] {
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step)
    ticks.push(t);
  return ticks;
}

/** The day a point was captured, where it was captured (KV-28). */
function dayOf(point: TrendPoint): string {
  return new Date(point.capturedAt).toLocaleDateString(undefined, {
    ...(point.timeZone === undefined ? {} : { timeZone: point.timeZone }),
    month: "short",
    day: "numeric",
  });
}

const valueText = (value: number): string => String(Number(value.toFixed(1)));

function Plot({ trend }: { trend: Trend }): React.JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null);
  const unit = METRIC_UNIT[trend.metric];
  const points = trend.points;

  const times = points.map((p) => Date.parse(p.capturedAt));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const values = [
    ...points.map((p) => p.value),
    ...(trend.usual === null ? [] : [trend.usual]),
  ];
  const spread = Math.max(...values) - Math.min(...values);
  const pad =
    spread === 0 ? Math.max(1, Math.abs(values[0] ?? 1) * 0.1) : spread * 0.15;
  const lo = Math.min(...values) - pad;
  const hi = Math.max(...values) + pad;

  const x = (t: number): number =>
    t1 === t0
      ? PAD.left + PLOT_W / 2
      : PAD.left + ((t - t0) / (t1 - t0)) * PLOT_W;
  const y = (v: number): number =>
    PAD.top + (1 - (v - lo) / (hi - lo)) * PLOT_H;
  const xy = points.map((p, i) => ({
    p,
    cx: x(times[i] ?? t0),
    cy: y(p.value),
  }));
  const path = xy
    .map(({ cx, cy }, i) => `${i === 0 ? "M" : "L"}${cx},${cy}`)
    .join(" ");
  const ticks = ticksFor(lo, hi);
  const label = usualLabel(trend);
  const first = xy[0];
  const last = xy[xy.length - 1];
  const focus = hovered === null ? null : (xy[hovered] ?? null);

  // The crosshair snaps to the nearest check-in in time.
  const onMove = (e: React.PointerEvent<SVGRectElement>): void => {
    const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return;
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    xy.forEach(({ cx }, i) => {
      if (Math.abs(cx - px) < Math.abs((xy[best]?.cx ?? 0) - px)) best = i;
    });
    setHovered(best);
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${trendTitle(trend)}${label === null ? "" : ` Line: ${label}.`}`}
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
              style={{ fontVariantNumeric: "tabular-nums" }}
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
            fill={p.seeded ? "var(--color-raised)" : "var(--color-series)"}
            stroke={p.seeded ? "var(--color-series)" : "var(--color-raised)"}
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
            {`${valueText(last.p.value)} ${unit}`}
          </text>
        )}

        {first !== undefined && (
          <text x={PAD.left} y={H - 8} fontSize={11} fill="var(--color-muted)">
            {dayOf(first.p)}
          </text>
        )}
        {last !== undefined && last !== first && (
          <text
            x={last.cx}
            y={H - 8}
            textAnchor="end"
            fontSize={11}
            fill="var(--color-muted)"
          >
            {dayOf(last.p)}
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

      {focus !== null && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 rounded-md border border-(--color-line) bg-(--color-ground) px-2 py-1 text-xs"
          style={{
            left: `${(focus.cx / W) * 100}%`,
            transform: focus.cx > W / 2 ? "translateX(-100%)" : undefined,
          }}
        >
          <p className="font-medium">{`${valueText(focus.p.value)} ${unit}`}</p>
          <p className="text-(--color-muted)">
            {dayOf(focus.p)}
            {focus.p.latest ? " · latest" : ""}
            {focus.p.seeded ? " · seeded demo data" : ""}
          </p>
        </div>
      )}
    </div>
  );
}

export default function TrendChart({
  records,
  personId,
}: {
  records: readonly SessionRecord[];
  personId: string;
}): React.JSX.Element | null {
  const [metric, setMetric] = useState<ComparedMetric>("pulse");
  const trend = useMemo(
    () => trendOf(records, personId, metric),
    [records, personId, metric],
  );
  // No usable check-in at all — for any metric, since that is what null means:
  // nothing to draw, and the cards say why.
  if (trend === null) return null;

  const unit = METRIC_UNIT[metric];
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
                ? "border-(--color-muted) text-(--color-ink)"
                : "border-(--color-line) text-(--color-muted) hover:bg-(--color-ground)"
            }`}
          >
            {TAB_LABEL[m]}
          </button>
        ))}
      </div>

      {trend.points.length === 0 ? (
        <p className="text-sm text-(--color-muted)">
          {`No ${METRIC_NAME[metric]} readings to draw.`}
        </p>
      ) : (
        <>
          <h2 className="mb-2 text-sm font-medium">{trendTitle(trend)}</h2>
          <Plot trend={trend} />
          <p className="mt-2 flex flex-wrap items-center gap-4 text-xs text-(--color-muted)">
            {usualLabel(trend) !== null && (
              <span className="flex items-center gap-1">
                <svg width="14" height="10" aria-hidden="true">
                  <line
                    x1="0"
                    x2="14"
                    y1="5"
                    y2="5"
                    stroke="var(--color-muted)"
                    strokeWidth="1"
                  />
                </svg>
                {usualLabel(trend)}
              </span>
            )}
            {trend.seededPoints > 0 && (
              <>
                <span className="flex items-center gap-1">
                  <svg width="10" height="10" aria-hidden="true">
                    <circle cx="5" cy="5" r="4" fill="var(--color-series)" />
                  </svg>
                  measured
                </span>
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
          {trendNotes(trend).map((note) => (
            <p key={note} className="mt-1 text-sm text-(--color-muted)">
              {note}
            </p>
          ))}
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-(--color-muted)">
              Show as a table
            </summary>
            <table className="mt-2 w-full text-left">
              <thead className="text-(--color-muted)">
                <tr>
                  <th className="font-normal">Date</th>
                  <th className="font-normal">{`${TAB_LABEL[metric]} (${unit})`}</th>
                  <th className="font-normal" />
                </tr>
              </thead>
              <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                {[...trend.points].reverse().map((p) => (
                  <tr key={p.id}>
                    <td>{dayOf(p)}</td>
                    <td>{valueText(p.value)}</td>
                    <td className="text-(--color-muted)">
                      {[
                        p.latest ? "latest" : "",
                        p.seeded ? "seeded demo data" : "",
                      ]
                        .filter((s) => s !== "")
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}
