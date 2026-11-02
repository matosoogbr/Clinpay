// Gráficos em SVG (pizza/rosca, barras e linha), sem bibliotecas externas
import { esc } from './core.js';

// Cores da marca primeiro, depois cores de apoio distinguíveis nos dois temas
export const PALETTE = ['#1565D8', '#12A4DC', '#7C5CDB', '#17A673', '#F0A93B', '#E35D6A', '#5B8DB8', '#C27BE0', '#8A9AB0', '#2E7D6B'];

/**
 * Gráfico de rosca (pizza) com legenda.
 * items: [{ label, value, color? }]; fmt: formata o valor na legenda.
 */
export function donut(items, { size = 180, fmt = (v) => String(v), center = '', centerSub = '', empty = 'Sem dados no período.' } = {}) {
  const data = items.filter((d) => d.value > 0);
  const total = data.reduce((s, d) => s + d.value, 0);
  if (!total) return `<p class="muted small">${esc(empty)}</p>`;
  const r = size / 2 - 8; const c = size / 2; const w = Math.max(18, size * 0.17);
  let a0 = -Math.PI / 2;
  const arcs = data.map((d, i) => {
    const color = d.color || PALETTE[i % PALETTE.length];
    const frac = d.value / total;
    if (frac >= 0.9999) return `<circle cx="${c}" cy="${c}" r="${r - w / 2}" fill="none" stroke="${color}" stroke-width="${w}"><title>${esc(d.label)}: ${esc(fmt(d.value))}</title></circle>`;
    const a1 = a0 + frac * Math.PI * 2;
    const rr = r - w / 2;
    const p = (a) => `${(c + rr * Math.cos(a)).toFixed(2)} ${(c + rr * Math.sin(a)).toFixed(2)}`;
    const path = `<path d="M ${p(a0)} A ${rr} ${rr} 0 ${frac > 0.5 ? 1 : 0} 1 ${p(a1)}" fill="none" stroke="${color}" stroke-width="${w}"><title>${esc(d.label)}: ${esc(fmt(d.value))} (${Math.round(frac * 100)}%)</title></path>`;
    a0 = a1;
    return path;
  }).join('');
  const legend = data.map((d, i) => `<li><span class="lab"><span class="sw" style="background:${d.color || PALETTE[i % PALETTE.length]}"></span>${esc(d.label)}</span>
    <span><strong>${esc(fmt(d.value))}</strong> <span class="muted small">${Math.round((d.value / total) * 100)}%</span></span></li>`).join('');
  return `<div class="chart-wrap"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Gráfico de pizza">${arcs}
    ${center ? `<text x="${c}" y="${c - 2}" text-anchor="middle" font-size="${size * 0.1}" font-weight="750" fill="currentColor">${esc(center)}</text>` : ''}
    ${centerSub ? `<text x="${c}" y="${c + size * 0.09}" text-anchor="middle" font-size="${size * 0.065}" fill="currentColor" opacity=".65">${esc(centerSub)}</text>` : ''}
    </svg><ul class="legend">${legend}</ul></div>`;
}

/** Barras verticais. items: [{ label, value }]. Rótulos em HTML para não distorcer o texto. */
export function bars(items, { height = 200, fmt = (v) => String(v), empty = 'Sem dados no período.' } = {}) {
  if (!items.length || !items.some((d) => d.value > 0)) return `<p class="muted small">${esc(empty)}</p>`;
  const max = Math.max(...items.map((d) => d.value)) || 1;
  const n = items.length; const W = 1000; const slot = W / n; const bw = Math.max(2, slot * 0.7);
  const every = Math.ceil(n / 14);
  const rects = items.map((d, i) => {
    const h = Math.round((d.value / max) * (height - 6));
    return `<rect x="${(i * slot + (slot - bw) / 2).toFixed(1)}" y="${height - h}" width="${bw.toFixed(1)}" height="${h}" rx="2" fill="url(#gradBar)"><title>${esc(d.label)}: ${esc(fmt(d.value))}</title></rect>`;
  }).join('');
  return `<div class="barchart"><div class="small muted" style="margin-bottom:4px">Máximo: ${esc(fmt(max))}</div>
    <svg viewBox="0 0 ${W} ${height}" height="${height}" preserveAspectRatio="none" role="img" aria-label="Gráfico de barras">
    <defs><linearGradient id="gradBar" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#1565D8"/><stop offset="1" stop-color="#12A4DC"/></linearGradient></defs>
    <line x1="0" x2="${W}" y1="${height - 0.5}" y2="${height - 0.5}" stroke="currentColor" opacity=".2"/>${rects}</svg>
    <div class="bar-x">${items.map((d, i) => `<span>${i % every === 0 ? esc(d.label) : ''}</span>`).join('')}</div></div>`;
}

/** Barras horizontais com rótulo (ranking). items: [{ label, value }] */
export function hbars(items, { fmt = (v) => String(v), empty = 'Sem dados no período.' } = {}) {
  if (!items.length) return `<p class="muted small">${esc(empty)}</p>`;
  const max = Math.max(...items.map((d) => d.value)) || 1;
  return items.map((d, i) => `<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between" class="small"><span>${esc(d.label)}</span><strong>${esc(fmt(d.value))}</strong></div>
    <div class="progress" style="height:8px"><i style="width:${Math.max((d.value / max) * 100, 2)}%;background:${PALETTE[i % PALETTE.length]}"></i></div></div>`).join('');
}
