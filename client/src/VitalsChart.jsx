import React, { useState } from 'react';
import { metricSeries, shortTimestamp, chartPositions, chartLabelIndices } from './profileData.js';

function compactDate(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(/\s*@\s*/, ' '));
  return Number.isNaN(date.getTime())
    ? String(value)
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

export default function VitalsChart({ readings, metric }) {
  const points = metricSeries(readings, metric);
  const [hoveredIndex, setHoveredIndex] = useState(null);
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
  const positions = chartPositions(points);
  const labelled = new Set(chartLabelIndices(positions, width - left - right));
  const x = (index) => left + positions[index] * (width - left - right);
  const y = (value) => top + ((max - value) / (max - min)) * (height - top - bottom);
  const polyline = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const unit = points.find((point) => point.unit)?.unit || '';
  const hoveredPoint = hoveredIndex === null ? null : points[hoveredIndex] || null;
  const tooltipWidth = 230;
  const tooltipHeight = 42;
  const tooltipX = !hoveredPoint
    ? 0
    : Math.min(Math.max(x(hoveredIndex) - tooltipWidth / 2, left), width - right - tooltipWidth);
  const tooltipY = !hoveredPoint
    ? 0
    : Math.max(y(hoveredPoint.value) - tooltipHeight - 10, 2);
  const pointLabel = (point) => `${point.value}${point.unit ? ` ${point.unit}` : ''} on ${shortTimestamp(point.dateTime)}${point.episodeId ? `, episode ${point.episodeId}` : ''}`;

  return <figure className="vital-chart">
    <figcaption>
      <strong>{metric}</strong>
      <span>{points.length} recorded {points.length === 1 ? 'reading' : 'readings'}{unit ? ` · ${unit}` : ''}</span>
    </figcaption>
    <p className="chart-latest">Latest recorded: {points.at(-1).value} {unit || '(unit not supplied)'} · {shortTimestamp(points.at(-1).dateTime)}</p>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${metric} trend across ${points.length} recorded readings`} onMouseLeave={() => setHoveredIndex(null)}>
      {[0, 1, 2].map((line) => {
        const value = max - ((max - min) * line) / 2;
        const lineY = y(value);
        return <g key={line}>
          <line x1={left} x2={width - right} y1={lineY} y2={lineY} className="chart-grid" />
          <text x={left - 7} y={lineY + 4} textAnchor="end" className="chart-axis-label">{Number(value.toFixed(1))}</text>
        </g>;
      })}
      <polyline points={polyline} className="chart-line" />
      {points.map((point, index) => <g
        key={`${point.dateTime}-${point.episodeId}-${index}`}
        onMouseEnter={() => setHoveredIndex(index)}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <circle
          cx={x(index)}
          cy={y(point.value)}
          r="10"
          className="chart-point-hit"
          tabIndex="0"
          aria-label={pointLabel(point)}
          onFocus={() => setHoveredIndex(index)}
          onBlur={() => setHoveredIndex(null)}
        />
        <circle cx={x(index)} cy={y(point.value)} r={hoveredIndex === index ? 5 : 4} className={`chart-point${hoveredIndex === index ? ' chart-point-active' : ''}`}>
          <title>{pointLabel(point)}</title>
        </circle>
        {labelled.has(index) && (
          <text x={x(index)} y={height - 18} textAnchor={points.length === 1 ? 'middle' : index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="chart-date-label">{compactDate(point.dateTime)}</text>
        )}
      </g>)}
      {hoveredPoint && <g className="chart-tooltip" pointerEvents="none" transform={`translate(${tooltipX}, ${tooltipY})`}>
        <rect width={tooltipWidth} height={tooltipHeight} rx="2" className="chart-tooltip-box" />
        <text x="7" y="15" className="chart-tooltip-value">{`${hoveredPoint.value}${hoveredPoint.unit ? ` ${hoveredPoint.unit}` : ''}`}</text>
        <text x="7" y="29" className="chart-tooltip-meta">{shortTimestamp(hoveredPoint.dateTime)}{hoveredPoint.episodeId ? ` · ${hoveredPoint.episodeId}` : ''}</text>
      </g>}
    </svg>
  </figure>;
}
