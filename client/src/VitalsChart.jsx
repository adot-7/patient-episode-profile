import React from 'react';
import { metricSeries, shortDate } from './profileData.js';

function compactDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value).slice(0, 10)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

export default function VitalsChart({ readings, metric }) {
  const points = metricSeries(readings, metric);
  if (!points.length) return null;
  const width = 520;
  const height = 206;
  const left = 45;
  const right = 18;
  const top = 20;
  const bottom = 42;
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = high - low || Math.max(Math.abs(high) * 0.12, 1);
  const min = low - spread * 0.15;
  const max = high + spread * 0.15;
  const x = (index) => points.length === 1
    ? (left + width - right) / 2
    : left + (index / (points.length - 1)) * (width - left - right);
  const y = (value) => top + ((max - value) / (max - min)) * (height - top - bottom);
  const polyline = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const unit = points.find((point) => point.unit)?.unit || '';

  return <figure className="vital-chart">
    <figcaption>
      <strong>{metric}</strong>
      <span>{points.length} recorded {points.length === 1 ? 'reading' : 'readings'}{unit ? ` · ${unit}` : ''}</span>
    </figcaption>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} trend across ${points.length} recorded readings`}>
      {[0, 1, 2].map((line) => {
        const value = max - ((max - min) * line) / 2;
        const lineY = y(value);
        return <g key={line}>
          <line x1={left} x2={width - right} y1={lineY} y2={lineY} className="chart-grid" />
          <text x={left - 7} y={lineY + 4} textAnchor="end" className="chart-axis-label">{Number(value.toFixed(1))}</text>
        </g>;
      })}
      <polyline points={polyline} className="chart-line" />
      {points.map((point, index) => <g key={`${point.dateTime}-${point.episodeId}-${index}`}>
        <circle cx={x(index)} cy={y(point.value)} r="4" className="chart-point">
          <title>{`${point.value}${point.unit ? ` ${point.unit}` : ''} · ${shortDate(point.dateTime)} · episode ${point.episodeId || 'not recorded'}`}</title>
        </circle>
        {(points.length <= 8 || index === 0 || index === points.length - 1) && (
          <text x={x(index)} y={height - 18} textAnchor="middle" className="chart-date-label">{compactDate(point.dateTime)}</text>
        )}
      </g>)}
    </svg>
    <div className="chart-footnote">Recorded values only; units are shown when supplied. Interpret in clinical context.</div>
  </figure>;
}
