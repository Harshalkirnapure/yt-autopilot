import { useState } from 'react';
import { useStudio } from '../studio/StudioContext.jsx';
import { PRIVACY_OPTIONS } from '../constants.js';
import { Card } from './Card.jsx';

export function UploadCard() {
  const {
    youtube,
    ytStatusLabel,
    disclosure,
    caption,
    uploadLink,
    uploaded,
    auditPassed,
    approvedAt,
    approvalText,
    publishNote,
    uploadVideo,
    approveVideo,
    publishVideo,
    connectChannel,
    busy,
    run,
  } = useStudio();

  const [privacy, setPrivacy] = useState('private');
  const [reviewed, setReviewed] = useState(false);
  const [approveChecked, setApproveChecked] = useState(false);

  return (
    <Card
      step="08"
      title="Upload & approve"
      hint="Uploads are always private or unlisted first. Publishing is a separate, human-approved step and stays locked until Google's compliance audit is passed."
      actions={
        <>
          <span className="pill">{ytStatusLabel}</span>
          <button
            className="btn ghost"
            type="button"
            onClick={() => run('connect', connectChannel)}
            disabled={!youtube?.configured || Boolean(busy.connect)}
          >
            Connect channel
          </button>
        </>
      }
    >
      <div className="fields upload-fields">
        <label className="field">
          <span>Privacy on upload</span>
          <select value={privacy} onChange={(event) => setPrivacy(event.target.value)}>
            {PRIVACY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="meta">{disclosure}</p>

      <label className="check">
        <input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />
        <span>
          I reviewed the script, audio, captions, thumbnail, privacy setting and the synthetic-media
          disclosure.
        </span>
      </label>

      <button
        className="btn primary"
        type="button"
        onClick={() => run('upload', () => uploadVideo({ privacyStatus: privacy, confirmed: reviewed }))}
        disabled={Boolean(busy.upload)}
      >
        {busy.upload ? 'Uploading…' : 'Upload to YouTube'}
      </button>

      <p className="meta">
        {uploadLink ? (
          <>
            <a className="link" href={uploadLink.url} target="_blank" rel="noreferrer">
              {uploadLink.url}
            </a>
            {` · ${uploadLink.privacyStatus || 'uploaded'}`}
            {uploadLink.thumbnailApplied ? ' · thumbnail set' : ''}
          </>
        ) : null}
      </p>

      <p className={`meta${caption.warn ? ' warn' : ''}`}>{caption.text}</p>

      <div className="divider" />
      <div className="subhead">Human-in-the-loop approval</div>

      <label className="check">
        <input
          type="checkbox"
          checked={approveChecked}
          onChange={(event) => setApproveChecked(event.target.checked)}
        />
        <span>I approve this video for publication on the connected channel.</span>
      </label>

      <button
        className="btn"
        type="button"
        onClick={() => run('approve', () => approveVideo({ confirmed: approveChecked }))}
        disabled={!uploaded || Boolean(busy.approve)}
      >
        {busy.approve ? 'Recording…' : 'Record approval'}
      </button>

      <p className="meta">{approvalText}</p>

      <button
        className="btn ghost"
        type="button"
        onClick={() => run('publish', publishVideo)}
        disabled={!(uploaded && approvedAt && auditPassed) || Boolean(busy.publish)}
      >
        {busy.publish ? 'Publishing…' : 'Publish (requires audit)'}
      </button>
      <p className="hint">{publishNote}</p>
    </Card>
  );
}
