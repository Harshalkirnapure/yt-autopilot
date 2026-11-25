import { useStudio } from '../studio/StudioContext.jsx';
import { Card } from './Card.jsx';

export function SetupCard() {
  const { settings, updateSettings, voiceOptions } = useStudio();

  return (
    <Card
      step="01"
      title="Channel setup"
      headHint="Prompts are built from these values — nothing is hardcoded."
    >
      <div className="fields">
        <label className="field">
          <span>Niche</span>
          <input
            type="text"
            placeholder="e.g. personal finance for freelancers"
            autoComplete="off"
            value={settings.niche ?? ''}
            onChange={(event) => updateSettings({ niche: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Audience</span>
          <input
            type="text"
            placeholder="e.g. first-time investors in India"
            autoComplete="off"
            value={settings.audience ?? ''}
            onChange={(event) => updateSettings({ audience: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Language / tone</span>
          <input
            type="text"
            placeholder="e.g. English (India), friendly and direct"
            autoComplete="off"
            value={settings.language ?? ''}
            onChange={(event) => updateSettings({ language: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Script length (words)</span>
          <input
            type="number"
            min="150"
            max="3000"
            step="50"
            placeholder="700"
            value={settings.length ?? ''}
            onChange={(event) => updateSettings({ length: event.target.value })}
          />
        </label>
        <label className="field wide">
          <span>Voiceover voice</span>
          <select value={settings.voice ?? ''} onChange={(event) => updateSettings({ voice: event.target.value })}>
            {voiceOptions.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Card>
  );
}
