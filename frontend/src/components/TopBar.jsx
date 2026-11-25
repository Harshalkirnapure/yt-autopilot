import { useStudio } from '../studio/StudioContext.jsx';

export function TopBar() {
  const { chips, run, signOut, busy } = useStudio();

  return (
    <header className="topbar">
      <div className="brand">
        <span className="mark" aria-hidden="true">
          ▶
        </span>
        <div>
          <h1>YT AutoPilot</h1>
          <p>AI topic → script → MP3 voiceover → stock clips → FFmpeg render → private upload</p>
        </div>
      </div>
      <div className="chips" aria-label="System status">
        {chips.map((chip) => (
          <span key={chip.id} className={`chip${chip.tone ? ` ${chip.tone}` : ''}`} title={chip.title}>
            {chip.text}
          </span>
        ))}
      </div>
      <button
        className="btn ghost small"
        type="button"
        onClick={() => run('signOut', signOut)}
        disabled={Boolean(busy.signOut)}
      >
        Sign out
      </button>
    </header>
  );
}
