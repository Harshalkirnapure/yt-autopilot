export const STORAGE = {
  video: 'ytap.videoId',
  settings: 'ytap.settings',
};

export const DEFAULT_SCRIPT_LENGTH = 700;

export const VOICES = [
  { id: 'en-IN-NeerjaNeural', label: 'Neerja — Indian English (female)' },
  { id: 'en-IN-PrabhatNeural', label: 'Prabhat — Indian English (male)' },
  { id: 'en-US-JennyNeural', label: 'Jenny — US English (female)' },
  { id: 'en-US-GuyNeural', label: 'Guy — US English (male)' },
  { id: 'en-US-AriaNeural', label: 'Aria — US English (female)' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia — UK English (female)' },
  { id: 'en-AU-NatashaNeural', label: 'Natasha — Australian English (female)' },
  { id: 'hi-IN-SwaraNeural', label: 'Swara — Hindi (female)' },
  { id: 'hi-IN-MadhurNeural', label: 'Madhur — Hindi (male)' },
];

export const PALETTES = {
  midnight: { from: '#070d18', to: '#16283f', accent: '#c8f751', text: '#ffffff', muted: '#93a9c2' },
  sunset: { from: '#1b0a1e', to: '#4a1730', accent: '#ff9a3d', text: '#fff6ec', muted: '#e9bfa8' },
  ocean: { from: '#04141f', to: '#0d4a5c', accent: '#43e5cf', text: '#eafffb', muted: '#9fd3cc' },
  paper: { from: '#f7f3e8', to: '#e2d9c6', accent: '#141414', text: '#121212', muted: '#5f5a4f' },
};

export const PRIVACY_OPTIONS = [
  { value: 'private', label: 'Private (recommended)' },
  { value: 'unlisted', label: 'Unlisted' },
];

export const DEFAULT_CHECKLIST = [
  'Verify facts and claims in the script.',
  'Listen to the full voiceover before approving.',
  'Confirm the privacy setting is private or unlisted.',
];
