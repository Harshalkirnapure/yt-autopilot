import { useStudio } from '../studio/StudioContext.jsx';
import { clockTime, dateTime, shortId } from '../lib/format.js';
import { Card } from './Card.jsx';

function logTone(status) {
  const value = String(status || 'info').toLowerCase();
  return ['success', 'failed', 'warning'].includes(value) ? value : '';
}

export function SidePanel() {
  const { video, videoId, recent, logs, badges, loadVideo, refreshAll, busy, run } = useStudio();

  return (
    <Card
      title="This run"
      className="sticky"
      actions={
        <button
          className="btn ghost small"
          type="button"
          onClick={() => run('refresh', refreshAll)}
          disabled={Boolean(busy.refresh)}
        >
          {busy.refresh ? 'Refreshing…' : 'Refresh'}
        </button>
      }
    >
      <dl className="summary">
        <div>
          <dt>Topic</dt>
          <dd>{video?.topic || 'No draft yet'}</dd>
        </div>
        <div>
          <dt>Video id</dt>
          <dd>{videoId ? shortId(videoId) : '—'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{[video?.status, video?.privacy_status].filter(Boolean).join(' · ') || '—'}</dd>
        </div>
        <div>
          <dt>Assets</dt>
          <dd className="badges">
            {badges.length ? (
              badges.map((badge) => (
                <span key={badge.label} className={`badge${badge.on ? ' on' : ''}`}>
                  {badge.label}
                </span>
              ))
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>

      <div className="divider" />
      <div className="subhead">Recent drafts</div>
      <div className="recent">
        {recent.length === 0 ? (
          <p className="empty">Nothing saved yet.</p>
        ) : (
          recent.map((draft) => (
            <button key={draft.id} type="button" onClick={() => void loadVideo(draft.id)}>
              <strong>{String(draft.topic || '').slice(0, 66)}</strong>
              <br />
              <span>
                {draft.status} · {dateTime(draft.created_at)}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="divider" />
      <div className="subhead">Activity log</div>
      <ul className="logs">
        {logs.length === 0 ? (
          <li className="empty">No activity yet.</li>
        ) : (
          logs.map((log, index) => (
            <li key={`${log.created_at}-${index}`} className={logTone(log.status)}>
              <time>
                {clockTime(log.created_at)} · {log.step || ''}
              </time>
              {log.message || ''}
            </li>
          ))
        )}
      </ul>
    </Card>
  );
}
