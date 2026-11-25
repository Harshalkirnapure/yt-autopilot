import { useEffect, useRef } from 'react';
import { useStudio } from '../studio/StudioContext.jsx';
import { PALETTES } from '../constants.js';
import { drawThumbnail } from '../lib/thumbnail.js';
import { Card } from './Card.jsx';

export function ThumbnailCard() {
  const { thumb, updateThumb, thumbSavedUrl, saveThumbnail, busy, run } = useStudio();
  const canvasRef = useRef(null);

  useEffect(() => {
    if (canvasRef.current) drawThumbnail(canvasRef.current, thumb);
  }, [thumb]);

  const download = () => {
    const link = document.createElement('a');
    link.download = `thumbnail-${Date.now()}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

  const onPaletteChange = (paletteName) => {
    const palette = PALETTES[paletteName];
    updateThumb({ palette: paletteName, ...(palette ? { accent: palette.accent } : {}) });
  };

  return (
    <Card
      step="07"
      title="Thumbnail"
      actions={
        <>
          <button className="btn ghost" type="button" onClick={download}>
            Download PNG
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => run('thumb', () => saveThumbnail(canvasRef.current.toDataURL('image/png')))}
            disabled={Boolean(busy.thumb)}
          >
            {busy.thumb ? 'Saving…' : 'Save to draft'}
          </button>
        </>
      }
    >
      <div className="thumb-grid">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} width="1280" height="720" />
        </div>
        <div className="thumb-controls">
          <label className="field">
            <span>Headline</span>
            <input
              type="text"
              maxLength={80}
              placeholder="Your video title"
              value={thumb.title}
              onChange={(event) => updateThumb({ title: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Sub-line</span>
            <input
              type="text"
              maxLength={70}
              placeholder="Short supporting line"
              value={thumb.subtitle}
              onChange={(event) => updateThumb({ subtitle: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Badge</span>
            <input
              type="text"
              maxLength={28}
              placeholder="NICHE"
              value={thumb.badge}
              onChange={(event) => updateThumb({ badge: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Palette</span>
            <select value={thumb.palette} onChange={(event) => onPaletteChange(event.target.value)}>
              <option value="midnight">Midnight lime</option>
              <option value="sunset">Sunset amber</option>
              <option value="ocean">Ocean teal</option>
              <option value="paper">Paper ink</option>
            </select>
          </label>
          <label className="field">
            <span>Accent colour</span>
            <input
              type="color"
              value={thumb.accent}
              onChange={(event) => updateThumb({ accent: event.target.value })}
            />
          </label>
          <p className="meta">{thumbSavedUrl ? `Saved thumbnail: ${thumbSavedUrl}` : 'Not saved to the draft yet.'}</p>
        </div>
      </div>
    </Card>
  );
}
