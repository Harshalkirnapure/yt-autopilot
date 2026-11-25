import { useStudio } from '../studio/StudioContext.jsx';
import { Card } from './Card.jsx';

export function ScriptCard() {
  const { script, setScript, wordTotal, generateScript, saveScript, busy, run } = useStudio();

  return (
    <Card
      step="03"
      title="Script"
      actions={
        <>
          <span className="pill">{wordTotal} words</span>
          <button
            className="btn"
            type="button"
            onClick={() => run('script', generateScript)}
            disabled={Boolean(busy.script)}
          >
            {busy.script ? 'Writing…' : 'Generate script'}
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => run('saveScript', () => saveScript(script))}
            disabled={Boolean(busy.saveScript)}
          >
            {busy.saveScript ? 'Saving…' : 'Save edits'}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="sr-only">Script</span>
        <textarea
          rows={16}
          placeholder="Generate a script, then edit it here before creating the voiceover."
          value={script}
          onChange={(event) => setScript(event.target.value)}
        />
      </label>
      <p className="hint">Edits are saved to the render and the TTS engine exactly as written here.</p>
    </Card>
  );
}
