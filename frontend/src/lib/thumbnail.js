import { PALETTES } from '../constants.js';

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

/** Paints the 1280×720 thumbnail preview from the current designer fields. */
export function drawThumbnail(canvas, spec) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const base = PALETTES[spec.palette] || PALETTES.midnight;
  const accent = spec.accent || base.accent;

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, base.from);
  gradient.addColorStop(1, base.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Accent glow
  ctx.save();
  const glow = ctx.createRadialGradient(width * 0.85, height * 0.14, 20, width * 0.85, height * 0.14, 430);
  glow.addColorStop(0, accent);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // Diagonal rule lines
  ctx.save();
  ctx.strokeStyle = base.muted;
  ctx.globalAlpha = 0.14;
  ctx.lineWidth = 2;
  for (let x = -height; x < width; x += 96) {
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x + height, 0);
    ctx.stroke();
  }
  ctx.restore();

  // Accent bar + badge
  ctx.fillStyle = accent;
  ctx.fillRect(72, 92, 12, 118);
  ctx.font = '700 30px Arial, sans-serif';
  ctx.fillText((spec.badge || 'NEW VIDEO').toUpperCase().slice(0, 32), 104, 132);

  // Headline with auto-fit sizing
  const headline = (spec.title || 'Your video title').toUpperCase();
  let size = 112;
  let lines = [];
  do {
    ctx.font = `900 ${size}px "Arial Black", Arial`;
    lines = wrapCanvasText(ctx, headline, width - 180, 3);
    const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
    if (lines.length <= 3 && widest <= width - 170) break;
    size -= 6;
  } while (size > 52);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = base.text;
  let cursorY = 322;
  lines.forEach((line) => {
    ctx.fillText(line, 78, cursorY);
    cursorY += size * 1.06;
  });
  ctx.restore();

  // Sub-line
  const subtitle = (spec.subtitle || '').trim();
  if (subtitle) {
    ctx.font = '500 34px Arial, sans-serif';
    ctx.fillStyle = base.muted;
    ctx.fillText(subtitle.slice(0, 70), 80, 646);
  }

  // Footer
  ctx.font = '600 22px Arial, sans-serif';
  ctx.fillStyle = base.muted;
  ctx.textAlign = 'right';
  ctx.fillText('YT AUTOPILOT', width - 72, 682);
  ctx.textAlign = 'left';
}
