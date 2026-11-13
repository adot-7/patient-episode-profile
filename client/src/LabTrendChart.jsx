import React from 'react';
import { labSeries, shortDate, chartPositions, chartLabelIndices } from './profileData.js';

export default function LabTrendChart({ readings, testName }) {
  const points = labSeries(readings, testName);
  if (!points.length) return null;
  const width = 520;
  const height = 190;
  const left = 48;
  const right = 16;
  const top = 18;
  const bottom = 38;
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = high - low || Math.max(Math.abs(high) * 0.12, 1);
  const min = low - spread * 0.15;
  const max = high + spread * 0.15;
  const positions = chartPositions(points);
  const labelled = new Set(chartLabelIndices(positions, width - left - right, 100));
  const x = (index) => left + positions[index] * (width - left - right);
  const y = (value) => top + ((max - value) / (max - min)) * (height - top - bottom);
  const line = points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const unit = points.find((point) => point.unit)?.unit || '';

  return <figure className="lab-trend-chart">
    <figcaption><strong>{testName}</strong><span>{points.length} results{unit ? ` · ${unit}` : ''}</span></figcaption>
    <p className="coverage-note">{points[0].displayValue} ({shortDate(points[0].dateTime)}){points.length > 1 ? ` → ${points.at(-1).displayValue} (${shortDate(points.at(-1).dateTime)})` : ''}{unit ? ` ${unit}` : ''}</p>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${testName} results across ${points.length} dated measurements`}>
      {[0, 1, 2].map((step) => {
        const value = max - ((max - min) * step) / 2;
        const lineY = y(value);
        return <g key={step}>
          <line x1={left} x2={width - right} y1={lineY} y2={lineY} className="chart-grid" />
          <text x={left - 7} y={lineY + 4} textAnchor="end" className="chart-axis-label">{Number(value.toFixed(1))}</text>
        </g>;
      })}
      {points.length > 1 && <polyline points={line} className="lab-chart-line" />}
      {points.map((point, index) => <g key={`${point.dateTime}-${point.episodeId}-${index}`}>
        <circle cx={x(index)} cy={y(point.value)} r="4" className="lab-chart-point">
          <title>{`${point.displayValue}${point.unit ? ` ${point.unit}` : ''} · ${point.dateTime || 'Date not recorded'} · episode ${point.episodeId || 'not recorded'}${point.referenceRange ? ` · reference ${point.referenceRange}` : ''}${point.flag ? ` · ${point.flag}` : ''}`}</title>
        </circle>
        {labelled.has(index) && <text x={x(index)} y={height - 14} textAnchor={points.length === 1 ? 'middle' : index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="chart-date-label">{shortDate(point.dateTime)}</text>}
      </g>)}
    </svg>
  </figure>;
}
