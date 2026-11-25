import { useStudio } from '../studio/StudioContext.jsx';
import { shortId } from '../lib/format.js';
import { Card } from './Card.jsx';

export function RenderCard() {
  const { job, jobMode, percent, video, startRender, busy, run } = useStudio();

  const stageLabel = job ? job.stage || job.status || 'Working…' : 'Idle';
  const jobLabel = job
    ? `Job ${shortId(job.id)} · ${job.status}${jobMode ? ` · ${jobMode}` : ''}`
    : 'No render job yet.';

  return (
    <Card
      step="05"
      title="Render 1080p MP4"
      hint="Pexels clips are deduplicated, cut to the script sections, captioned and muxed with the MP3."
      actions={
        <button
          className="btn"
          type="button"
          onClick={() => run('render', startRender)}
          disabled={Boolean(busy.render)}
        >
          {busy.render ? 'Queueing…' : 'Start render'}
        </button>
      }
    >
      <div className="progress-head">
        <span>{stageLabel}</span>
        <span>{percent}%</span>
      </div>
      <div className="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
        <div className="progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <div className="render-foot">
        <span className="meta">{jobLabel}</span>
        {video?.video_url ? (
          <a className="link" href={video.video_url} target="_blank" rel="noreferrer">
            Open rendered MP4
          </a>
        ) : null}
      </div>
    </Card>
  );
}
