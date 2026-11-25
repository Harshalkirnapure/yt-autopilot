import { useStudio } from '../studio/StudioContext.jsx';
import { Card } from './Card.jsx';

export function VoiceoverCard() {
  const { audio, script, generateVoiceover, busy, run } = useStudio();

  return (
    <Card
      step="04"
      title="Voiceover (MP3)"
      hint="Server-side TTS only — browser SpeechSynthesis cannot be captured into a video file."
      actions={
        <button
          className="btn"
          type="button"
          onClick={() => run('tts', () => generateVoiceover(script))}
          disabled={Boolean(busy.tts)}
        >
          {busy.tts ? 'Synthesising…' : 'Generate MP3'}
        </button>
      }
    >
      <audio controls hidden={!audio} src={audio?.url} />
      <p className="meta">{audio?.meta || 'No audio yet.'}</p>
    </Card>
  );
}
