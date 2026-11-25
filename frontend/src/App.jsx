import { useStudio } from './studio/StudioContext.jsx';
import { TopBar } from './components/TopBar.jsx';
import { SetupCard } from './components/SetupCard.jsx';
import { TopicsCard } from './components/TopicsCard.jsx';
import { ScriptCard } from './components/ScriptCard.jsx';
import { VoiceoverCard } from './components/VoiceoverCard.jsx';
import { RenderCard } from './components/RenderCard.jsx';
import { SeoCard } from './components/SeoCard.jsx';
import { ThumbnailCard } from './components/ThumbnailCard.jsx';
import { UploadCard } from './components/UploadCard.jsx';
import { SidePanel } from './components/SidePanel.jsx';
import { SignInGate } from './components/SignInGate.jsx';
import { Toasts } from './components/Toasts.jsx';

export default function App() {
  const { missingConfig } = useStudio();

  return (
    <>
      <div className="app">
        <TopBar />

        {missingConfig.length > 0 ? (
          <div className="banner" role="status">
            {`Setup needed: ${missingConfig.join(' · ')}. Add these to backend/.env and restart the server.`}
          </div>
        ) : null}

        <div className="layout">
          <main className="column">
            <SetupCard />
            <TopicsCard />
            <ScriptCard />
            <VoiceoverCard />
            <RenderCard />
            <SeoCard />
            <ThumbnailCard />
            <UploadCard />
          </main>
          <aside className="column side">
            <SidePanel />
          </aside>
        </div>

        <footer className="footer">
          <span>Only CC0 / Pexels / AI-generated assets. No third-party YouTube downloads.</span>
          <span>FFmpeg muxes the MP3 voiceover — never browser-captured audio.</span>
        </footer>
      </div>

      <SignInGate />
      <Toasts />
    </>
  );
}
