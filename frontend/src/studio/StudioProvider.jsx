import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from '../api.js';
import { DEFAULT_CHECKLIST, DEFAULT_SCRIPT_LENGTH, PALETTES, STORAGE, VOICES } from '../constants.js';
import { assetBadges, captionInfo, wordCount } from '../lib/format.js';
import { StudioContext } from './StudioContext.jsx';

function loadStoredSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE.settings) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const EMPTY_THUMB = {
  title: '',
  subtitle: '',
  badge: '',
  palette: 'midnight',
  accent: PALETTES.midnight.accent,
};

export function StudioProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [authRequired, setAuthRequired] = useState(false);
  const [apiDown, setApiDown] = useState(false);

  const [settings, setSettings] = useState(loadStoredSettings);
  const [health, setHealth] = useState(null);
  const [youtube, setYoutube] = useState(null);

  const [video, setVideo] = useState(null);
  const [videoId, setVideoId] = useState(() => localStorage.getItem(STORAGE.video));
  const [logs, setLogs] = useState([]);
  const [recent, setRecent] = useState([]);

  const [topics, setTopics] = useState([]);
  const [topicSource, setTopicSource] = useState('Not generated');
  const [currentTopic, setCurrentTopic] = useState(null);
  const [script, setScript] = useState('');
  const [audio, setAudio] = useState(null);

  const [job, setJob] = useState(null);
  const [jobMode, setJobMode] = useState(null);

  const [titleOptions, setTitleOptions] = useState([]);
  const [selectedTitle, setSelectedTitle] = useState('');
  const [seoForm, setSeoForm] = useState({ description: '', tags: '' });
  const [checklist, setChecklist] = useState(DEFAULT_CHECKLIST);

  const [thumb, setThumb] = useState(EMPTY_THUMB);
  const [thumbSavedUrl, setThumbSavedUrl] = useState('');
  const [uploadResult, setUploadResult] = useState(null);
  const [busy, setBusy] = useState({});

  const videoIdRef = useRef(videoId);
  const settingsRef = useRef(settings);
  const currentTopicRef = useRef(currentTopic);
  const serverScriptRef = useRef('');
  const pollRef = useRef(null);
  const lastStatusRef = useRef(null);
  const refreshVideoRef = useRef(null);
  const bootedRef = useRef(false);

  // videoIdRef / currentTopicRef need no sync effect: selectVideoId, applyVideo and selectTopic are
  // their only writers and update the ref alongside the state.
  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem(STORAGE.settings, JSON.stringify(settings));
  }, [settings]);

  /* ------------------------------------------------------------------ toasts */

  const toast = useCallback((message, type = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, message, type, leaving: false }]);
    setTimeout(() => {
      setToasts((prev) => prev.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
    }, 4200);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 4800);
  }, []);

  /** Runs a button action, showing its busy label and surfacing any error as a toast. */
  const run = useCallback(
    async (action, task) => {
      setBusy((prev) => ({ ...prev, [action]: true }));
      try {
        await task();
      } catch (error) {
        toast(error?.message || String(error), 'error');
      } finally {
        setBusy((prev) => ({ ...prev, [action]: false }));
      }
    },
    [toast],
  );

  /* ------------------------------------------------------------- video state */

  const selectVideoId = useCallback((id) => {
    videoIdRef.current = id ?? null;
    setVideoId(id ?? null);
    if (id) localStorage.setItem(STORAGE.video, id);
    else localStorage.removeItem(STORAGE.video);
  }, []);

  const applyVideo = useCallback(
    (next) => {
      if (!next) return;
      selectVideoId(next.id);
      setVideo(next);

      if (!currentTopicRef.current || currentTopicRef.current.title !== next.topic) {
        const topic = { title: next.topic, angle: '', keywords: [] };
        currentTopicRef.current = topic;
        setCurrentTopic(topic);
      }

      // A server value only replaces the editor when it is untouched, so typing is never clobbered.
      if (next.script) {
        setScript((prev) => (!prev.trim() || prev === serverScriptRef.current ? next.script : prev));
        serverScriptRef.current = next.script;
      }

      if (next.audio_url) {
        setAudio({
          url: next.audio_url,
          meta: `${next.audio_duration ? `${next.audio_duration.toFixed(1)}s` : 'Ready'} · MP3 on server`,
        });
      }

      if (next.thumbnail_url) setThumbSavedUrl(next.thumbnail_url);

      if (next.seo_title) {
        setTitleOptions((prev) => (prev.length ? prev : [next.seo_title]));
        setSelectedTitle((prev) => prev || next.seo_title);
        setSeoForm((prev) => ({
          description: prev.description === '' ? next.seo_description || '' : prev.description,
          tags: prev.tags === '' ? (next.seo_tags || []).join(', ') : prev.tags,
        }));
        setThumb((prev) => (prev.title ? prev : { ...prev, title: next.seo_title.toUpperCase() }));
      }
    },
    [selectVideoId],
  );

  /* ---------------------------------------------------------- health/youtube */

  const loadHealth = useCallback(async () => {
    try {
      const data = await api('/api/health');
      setApiDown(false);
      setHealth(data);
      setSettings((prev) => ({
        niche: prev.niche || data.defaults.niche,
        audience: prev.audience || data.defaults.audience,
        language: prev.language || data.defaults.language,
        length: prev.length || data.defaults.scriptLength,
        voice: prev.voice || data.defaults.voice,
      }));
    } catch (error) {
      setHealth(null);
      setApiDown(true);
      toast(`Cannot reach the API: ${error.message}`, 'error');
    }
  }, [toast]);

  const refreshYoutube = useCallback(async () => {
    const status = await api('/api/youtube/status');
    setYoutube(status);
    return status;
  }, []);

  const loadRecent = useCallback(async () => {
    const data = await api('/api/videos?limit=6');
    setRecent(data.videos || []);
  }, []);

  /* ------------------------------------------------------------- render job */

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (id, mode) => {
      stopPolling();
      setJobMode(mode || null);
      lastStatusRef.current = null;
      setJob({ id, status: 'queued', progress: 0, stage: 'queued' });

      const tick = async () => {
        try {
          const data = await api(`/api/status/${id}`);
          const next = data.job;
          setJob(next);

          if (next.status === 'completed' && lastStatusRef.current !== 'completed') {
            lastStatusRef.current = 'completed';
            stopPolling();
            toast('Render finished. Review the MP4 before uploading.', 'success');
            await refreshVideoRef.current?.({ silent: true });
          } else if (next.status === 'failed' && lastStatusRef.current !== 'failed') {
            lastStatusRef.current = 'failed';
            stopPolling();
            toast(next.error || 'Render failed. Check the activity log.', 'error');
            await refreshVideoRef.current?.({ silent: true });
          }
        } catch (error) {
          if (lastStatusRef.current !== 'poll-error') {
            lastStatusRef.current = 'poll-error';
            toast(error.message, 'error');
          }
        }
      };

      pollRef.current = setInterval(() => void tick(), 2500);
      void tick();
    },
    [stopPolling, toast],
  );

  const refreshVideo = useCallback(
    async ({ silent = false } = {}) => {
      const id = videoIdRef.current;
      if (!id) return;
      try {
        const data = await api(`/api/videos/${id}`);
        applyVideo(data.video);
        setLogs(data.logs || []);

        // A render that was still running when the page reloaded resumes its polling from the newest
        // job of this draft, so no job id has to be remembered separately.
        const latest = (data.jobs || [])[0];
        if (!latest || pollRef.current) return;
        if (latest.status === 'queued' || latest.status === 'active') {
          startPolling(latest.id, latest.status === 'queued' ? 'queue' : null);
        } else {
          setJob(latest);
        }
      } catch (error) {
        if (!silent) toast(error.message, 'error');
        if (/not found/i.test(error.message)) {
          selectVideoId(null);
          setVideo(null);
        }
      }
    },
    [applyVideo, selectVideoId, startPolling, toast],
  );

  useEffect(() => {
    refreshVideoRef.current = refreshVideo;
  }, [refreshVideo]);

  /* ------------------------------------------------------------- workspace */

  const loadVideo = useCallback(
    async (id) => {
      selectVideoId(id);
      setScript('');
      serverScriptRef.current = '';
      setTitleOptions([]);
      setSelectedTitle('');
      setSeoForm({ description: '', tags: '' });
      setChecklist(DEFAULT_CHECKLIST);
      setUploadResult(null);
      setThumbSavedUrl('');
      setAudio(null);
      await refreshVideo();
      await loadRecent().catch(() => undefined);
    },
    [selectVideoId, refreshVideo, loadRecent],
  );

  const loadWorkspace = useCallback(async () => {
    await loadHealth();
    await refreshYoutube().catch(() => undefined);
    await loadRecent().catch(() => undefined);

    // refreshVideo restores the draft and resumes polling for a render that is still running.
    if (videoIdRef.current) await refreshVideo({ silent: true }).catch(() => undefined);
  }, [loadHealth, refreshYoutube, loadRecent, refreshVideo]);

  /* -------------------------------------------------------------- settings */

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  /** Throws when the channel setup is incomplete, so the caller's button reports it as a toast. */
  const ensureSettings = useCallback(() => {
    const current = settingsRef.current || {};
    const niche = (current.niche || '').trim();
    const audience = (current.audience || '').trim();
    const language = (current.language || '').trim();
    if (!niche || !audience || !language) {
      throw new Error('Fill in niche, audience and language in Channel setup first.');
    }
    return {
      niche,
      audience,
      language,
      length: Number(current.length) || DEFAULT_SCRIPT_LENGTH,
      voice: current.voice || '',
    };
  }, []);

  const ensureVideo = useCallback(
    async (topic) => {
      if (videoIdRef.current) return videoIdRef.current;
      const current = ensureSettings();
      const data = await api('/api/videos', {
        method: 'POST',
        body: {
          topic: topic || currentTopicRef.current?.title || 'Untitled video',
          niche: current.niche,
          audience: current.audience,
          language: current.language,
        },
      });
      applyVideo(data.video);
      return data.video.id;
    },
    [applyVideo, ensureSettings],
  );

  /* ---------------------------------------------------------------- actions */

  const generateTopics = useCallback(async () => {
    const current = ensureSettings();
    const result = await api('/api/topics', {
      method: 'POST',
      body: { niche: current.niche, audience: current.audience, language: current.language },
    });
    setTopics(result.topics || []);
    setTopicSource(result.source === 'gemini' ? 'AI generated' : 'Template fallback');
  }, [ensureSettings]);

  const selectTopic = useCallback(
    (topic) => {
      currentTopicRef.current = topic;
      setCurrentTopic(topic);
      setThumb((prev) => ({
        ...prev,
        title: topic.title.toUpperCase(),
        badge: prev.badge || (settingsRef.current.niche || 'NEW VIDEO').toUpperCase().slice(0, 26),
      }));
      toast('Topic selected. Generate the script to create the draft.', 'success');
    },
    [toast],
  );

  const generateScript = useCallback(async () => {
    const current = ensureSettings();
    const topic = currentTopicRef.current;
    if (!topic) throw new Error('Pick a topic first.');

    const id = await ensureVideo(topic.title);
    const result = await api('/api/script', {
      method: 'POST',
      body: {
        topic: topic.title,
        niche: current.niche,
        audience: current.audience,
        language: current.language,
        length: current.length,
        videoId: id,
      },
    });

    setScript(result.script);
    serverScriptRef.current = result.script;
    await refreshVideoRef.current?.({ silent: true });
    toast(`Script ready (${result.wordCount} words). Edit it before generating audio.`, 'success');
  }, [ensureSettings, ensureVideo, toast]);

  const saveScript = useCallback(
    async (text) => {
      const trimmed = String(text || '').trim();
      if (!trimmed) throw new Error('The script is empty.');
      if (!videoIdRef.current) throw new Error('Generate a script first.');

      await api(`/api/videos/${videoIdRef.current}`, { method: 'PATCH', body: { script: trimmed } });
      serverScriptRef.current = trimmed;
      await refreshVideoRef.current?.({ silent: true });
      toast('Script edits saved.', 'success');
    },
    [toast],
  );

  const generateVoiceover = useCallback(
    async (text) => {
      const current = ensureSettings();
      const scriptText = String(text || '').trim();
      if (scriptText.length < 50) throw new Error('Add a script before generating the voiceover.');

      const id = await ensureVideo(currentTopicRef.current?.title || 'Voiceover draft');
      const result = await api('/api/tts', {
        method: 'POST',
        body: {
          script: scriptText,
          voice: current.voice,
          videoId: id,
          niche: current.niche,
          audience: current.audience,
          language: current.language,
        },
      });

      setAudio({
        url: `${result.audioUrl}?v=${Date.now()}`,
        meta: `${result.provider} · ${result.voice} · ${
          result.durationSeconds ? `${result.durationSeconds.toFixed(1)}s` : 'duration unknown'
        }`,
      });

      await refreshVideoRef.current?.({ silent: true });
      toast('MP3 voiceover ready.', 'success');
    },
    [ensureSettings, ensureVideo, toast],
  );

  const startRender = useCallback(async () => {
    if (!videoIdRef.current) throw new Error('Generate the voiceover first.');
    const result = await api('/api/render', { method: 'POST', body: { videoId: videoIdRef.current } });
    startPolling(result.jobId, result.mode);
    toast(`Render job started (${result.mode}).`, 'success');
  }, [startPolling, toast]);

  const generateSeo = useCallback(async () => {
    const current = ensureSettings();
    const topic = currentTopicRef.current;
    if (!topic) throw new Error('Pick a topic first.');

    const id = await ensureVideo(topic.title);
    const metadata = await api('/api/seo', {
      method: 'POST',
      body: {
        topic: topic.title,
        niche: current.niche,
        audience: current.audience,
        language: current.language,
        videoId: id,
      },
    });

    await refreshVideoRef.current?.({ silent: true });

    const options = metadata.title_options || [];
    setTitleOptions(options);
    setSelectedTitle(options[0] || '');
    setSeoForm({
      description: metadata.description || '',
      tags: (metadata.tags || []).join(', '),
    });
    setChecklist(metadata.upload_checklist || DEFAULT_CHECKLIST);
    if (options[0]) setThumb((prev) => ({ ...prev, title: options[0].toUpperCase() }));

    toast('SEO metadata ready.', 'success');
  }, [ensureSettings, ensureVideo, toast]);

  const selectTitle = useCallback((title) => {
    setSelectedTitle(title);
    setThumb((prev) => ({ ...prev, title: title.toUpperCase() }));
  }, []);

  const saveSeo = useCallback(async () => {
    if (!videoIdRef.current) throw new Error('No draft to save.');

    const seoTitle = selectedTitle || '';
    if (!seoTitle) throw new Error('Select or generate a title first.');

    const seoTags = seoForm.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 15);

    await api(`/api/videos/${videoIdRef.current}`, {
      method: 'PATCH',
      body: { seoTitle, seoDescription: seoForm.description.trim(), seoTags },
    });
    await refreshVideoRef.current?.({ silent: true });
    toast('Metadata saved to the draft.', 'success');
  }, [selectedTitle, seoForm, toast]);

  const updateSeoForm = useCallback((patch) => {
    setSeoForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const updateThumb = useCallback((patch) => {
    setThumb((prev) => ({ ...prev, ...patch }));
  }, []);

  const saveThumbnail = useCallback(
    async (image) => {
      if (!videoIdRef.current) throw new Error('Create a draft first (generate the script or voiceover).');
      const result = await api('/api/thumbnail', {
        method: 'POST',
        body: { videoId: videoIdRef.current, image },
      });
      setThumbSavedUrl(result.thumbnailUrl);
      await refreshVideoRef.current?.({ silent: true });
      toast('Thumbnail saved to the draft.', 'success');
    },
    [toast],
  );

  const uploadVideo = useCallback(
    async ({ privacyStatus, confirmed }) => {
      if (!videoIdRef.current) throw new Error('Nothing to upload yet.');
      if (!confirmed) throw new Error('Tick the review checkbox before uploading.');

      const result = await api('/api/upload', {
        method: 'POST',
        body: { videoId: videoIdRef.current, privacyStatus, confirm: true },
      });

      // The caption outcome has its own line and is refreshed just below, so it is not repeated here.
      setUploadResult({
        url: result.url,
        privacyStatus: result.privacyStatus,
        thumbnailApplied: Boolean(result.thumbnailApplied),
      });

      if (result.captionsUploaded) {
        toast(`Uploaded as ${result.privacyStatus}. Approval is still required to publish.`, 'success');
      } else {
        toast(`Uploaded, but the caption track failed: ${result.captionError || 'unknown error'}`, 'error');
      }

      await refreshYoutube().catch(() => undefined);
      await refreshVideo({ silent: true });
    },
    [refreshVideo, refreshYoutube, toast],
  );

  const approveVideo = useCallback(
    async ({ confirmed }) => {
      if (!videoIdRef.current) throw new Error('Nothing to approve yet.');
      if (!confirmed) throw new Error('Tick the approval checkbox first.');

      await api(`/api/videos/${videoIdRef.current}/approve`, {
        method: 'POST',
        body: { approved: true },
      });
      await refreshVideo({ silent: true });
      toast('Approval recorded.', 'success');
    },
    [refreshVideo, toast],
  );

  const publishVideo = useCallback(async () => {
    if (!videoIdRef.current) throw new Error('No uploaded video.');
    await api(`/api/youtube/publish/${videoIdRef.current}`, {
      method: 'POST',
      body: { confirm: true, privacyStatus: 'public' },
    });
    await refreshVideo({ silent: true });
    toast('Video published.', 'success');
  }, [refreshVideo, toast]);

  const connectChannel = useCallback(async () => {
    const { url } = await api('/api/youtube/auth');
    window.location.href = url;
  }, []);

  const refreshAll = useCallback(async () => {
    await loadHealth();
    await refreshYoutube().catch(() => undefined);
    await refreshVideo();
    await loadRecent().catch(() => undefined);
    toast('Workspace refreshed.', 'success');
  }, [loadHealth, refreshYoutube, refreshVideo, loadRecent, toast]);

  /* --------------------------------------------------------------- session */

  const handleOAuthResult = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('youtube');
    if (!result) return;

    if (result === 'connected') toast('YouTube channel connected.', 'success');
    else toast(`YouTube connection failed: ${params.get('reason') || 'unknown error'}`, 'error');

    window.history.replaceState({}, '', window.location.pathname);
  }, [toast]);

  const signIn = useCallback(
    async ({ token, name }) => {
      const result = await api('/api/login', {
        method: 'POST',
        body: { token, ...(name ? { name } : {}) },
      });
      setAuthRequired(false);
      await loadWorkspace();
      toast(`Signed in as ${result.approver}.`, 'success');
    },
    [loadWorkspace, toast],
  );

  const signOut = useCallback(async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => undefined);
    setAuthRequired(true);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthRequired(true));

    if (bootedRef.current) return;
    bootedRef.current = true;

    void (async () => {
      handleOAuthResult();
      try {
        const current = await api('/api/session');
        if (!current?.authenticated) {
          setAuthRequired(true);
          return;
        }
        setAuthRequired(false);
        await loadWorkspace();
      } catch {
        setAuthRequired(true);
      }
    })();

    return stopPolling;
  }, [handleOAuthResult, loadWorkspace, stopPolling]);

  /* --------------------------------------------------------------- derived */

  const voiceOptions = useMemo(() => {
    const list = [...VOICES];
    const serverDefault = health?.defaults?.voice;
    if (serverDefault && !list.some((voice) => voice.id === serverDefault)) {
      list.push({ id: serverDefault, label: `${serverDefault} (server default)` });
    }
    return list;
  }, [health]);

  const missingConfig = useMemo(() => {
    if (!health) return [];
    const missing = [];
    if (!health.features.gemini) missing.push('GEMINI_API_KEY');
    if (!health.features.pexels) missing.push('PEXELS_API_KEY');
    if (!health.features.youtube) missing.push('YT_CLIENT_ID + YT_CLIENT_SECRET');
    if (health.store === 'memory') missing.push('DATABASE_URL (storage is temporary)');
    if (!health.ffmpeg.available) missing.push('FFmpeg binary');
    return missing;
  }, [health]);

  const chips = useMemo(() => {
    const list = [];

    if (apiDown) list.push({ id: 'db', text: 'API unreachable', tone: 'bad' });
    else
      list.push({
        id: 'db',
        text: health ? (health.store === 'postgres' ? 'Postgres' : 'Memory DB') : 'Database…',
        tone: health ? (health.store === 'postgres' ? 'ok' : 'warn') : '',
      });

    list.push({
      id: 'ffmpeg',
      text: health ? (health.ffmpeg.available ? 'FFmpeg ready' : 'FFmpeg missing') : 'FFmpeg…',
      tone: health ? (health.ffmpeg.available ? 'ok' : 'bad') : '',
    });

    list.push({
      id: 'yt',
      text: youtube
        ? !youtube.configured
          ? 'YouTube —'
          : youtube.connected
            ? 'YouTube connected'
            : 'YouTube offline'
        : 'YouTube…',
      tone: youtube ? (!youtube.configured ? 'warn' : youtube.connected ? 'ok' : 'warn') : '',
    });

    // The upload quota comes from /api/youtube/status once it is loaded, else from /api/health.
    const quota = youtube?.quota || health?.quota;
    list.push({
      id: 'quota',
      text: quota ? `Uploads ${quota.used}/${quota.limit}` : 'Uploads —',
      tone: quota ? (quota.remaining > 0 ? 'ok' : 'bad') : '',
    });

    list.push({
      id: 'scheduler',
      text: health
        ? health.scheduler.armed
          ? `Cron ${health.scheduler.schedule}`
          : 'Cron off'
        : 'Cron —',
      tone: health ? (health.scheduler.armed ? 'ok' : 'warn') : '',
    });

    // The newest pipeline_runs row: whether today's run happened, and why it did not. A skip is the
    // schedule working as intended, so only a failure is shown as bad. `silent` is decided by the
    // server from the newest completed run: red even when the last row says "skipped", because a
    // channel that stopped producing is the failure worth seeing.
    const run = health?.pipeline;
    const runTone = !run
      ? 'warn'
      : run.silent
        ? 'bad'
        : run.status === 'completed'
          ? 'ok'
          : run.status === 'failed'
            ? 'bad'
            : 'warn';

    list.push({
      id: 'pipeline',
      text: run ? `Last run ${run.status}` : 'No run yet',
      tone: runTone,
      title: run
        ? [
            run.silent ? `Silent: nothing produced in the last ${run.silenceHours} h.` : '',
            `Trigger: ${run.trigger}`,
            `Started: ${new Date(run.startedAt).toLocaleString()}`,
            run.finishedAt ? `Finished: ${new Date(run.finishedAt).toLocaleString()}` : 'Not finished',
            run.reason ? `Reason: ${run.reason}` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : 'No pipeline run has been recorded yet.',
    });

    return list;
  }, [apiDown, health, youtube]);

  const uploaded = Boolean(video?.youtube_video_id);
  const auditPassed = Boolean(youtube?.auditPassed);
  const approvedAt = video?.approved_at || null;
  const caption = captionInfo(video);
  const percent = job ? Math.max(0, Math.min(100, Number(job.progress) || 0)) : 0;

  const uploadLink =
    uploadResult ||
    (video?.youtube_url ? { url: video.youtube_url, privacyStatus: video.privacy_status, thumbnailApplied: false } : null);

  const approvalText = !uploaded
    ? 'Upload the video before approving it.'
    : approvedAt
      ? `Approved ${new Date(approvedAt).toLocaleString()}${video?.approved_by ? ` by ${video.approved_by}` : ''}.`
      : 'Uploaded and waiting for your approval.';

  const publishNote = !auditPassed
    ? 'Publishing is locked: YT_AUDIT_PASSED is false. Keep uploads private or unlisted until Google approves the compliance audit.'
    : !approvedAt
      ? 'Record human approval before publishing.'
      : 'Ready to publish on the connected channel.';

  const ytStatusLabel = !youtube
    ? 'YouTube…'
    : !youtube.configured
      ? 'YouTube not configured'
      : youtube.connected
        ? `Connected${youtube.channelId ? ` · ${youtube.channelId.slice(0, 8)}` : ''}`
        : 'Channel not connected';

  // Shown before approval so the reviewer knows what the upload declares to YouTube.
  const disclosure = !youtube
    ? 'Synthetic-media disclosure: checking…'
    : youtube.syntheticMediaDisclosure
      ? 'Synthetic-media disclosure: ON — this upload is flagged to YouTube as containing altered or synthetic media (AI narration, assembled footage).'
      : 'Warning: YT_DISCLOSE_SYNTHETIC_MEDIA is off — no altered/synthetic media disclosure is sent to YouTube.';

  const value = {
    // state
    authRequired,
    settings,
    youtube,
    video,
    videoId,
    logs,
    recent,
    topics,
    topicSource,
    currentTopic,
    script,
    audio,
    job,
    jobMode,
    titleOptions,
    selectedTitle,
    seoForm,
    checklist,
    thumb,
    thumbSavedUrl,
    uploadLink,
    busy,
    toasts,

    // derived
    chips,
    voiceOptions,
    missingConfig,
    wordTotal: wordCount(script),
    badges: assetBadges(video),
    uploaded,
    auditPassed,
    approvedAt,
    caption,
    percent,
    approvalText,
    publishNote,
    ytStatusLabel,
    disclosure,

    // actions
    run,
    signIn,
    signOut,
    updateSettings,
    setScript,
    updateSeoForm,
    updateThumb,
    selectTitle,
    selectTopic,
    loadVideo,
    refreshAll,
    generateTopics,
    generateScript,
    saveScript,
    generateVoiceover,
    startRender,
    generateSeo,
    saveSeo,
    saveThumbnail,
    uploadVideo,
    approveVideo,
    publishVideo,
    connectChannel,
  };

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
