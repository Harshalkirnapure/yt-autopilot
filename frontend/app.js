'use strict';

const STORAGE = {
  video: 'ytap.videoId',
  job: 'ytap.jobId',
  settings: 'ytap.settings',
};

const VOICES = [
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

const PALETTES = {
  midnight: { from: '#070d18', to: '#16283f', accent: '#c8f751', text: '#ffffff', muted: '#93a9c2' },
  sunset: { from: '#1b0a1e', to: '#4a1730', accent: '#ff9a3d', text: '#fff6ec', muted: '#e9bfa8' },
  ocean: { from: '#04141f', to: '#0d4a5c', accent: '#43e5cf', text: '#eafffb', muted: '#9fd3cc' },
  paper: { from: '#f7f3e8', to: '#e2d9c6', accent: '#141414', text: '#121212', muted: '#5f5a4f' },
};

const state = {
  videoId: localStorage.getItem(STORAGE.video),
  jobId: localStorage.getItem(STORAGE.job),
  settings: loadStoredSettings(),
  currentTopic: null,
  seo: null,
  selectedTitle: '',
  uploaded: false,
  approvedAt: null,
  youtubeStatus: null,
  health: null,
  pollTimer: null,
  lastJobStatus: null,
  approver: null,
  approvedBy: null,
};

const $ = (id) => document.getElementById(id);

function loadStoredSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE.settings) || '{}') || {};
  } catch {
    return {};
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    if (response.status === 401) showAuthGate();
    throw new Error((data && data.error) || `Request failed (${response.status}).`);
  }
  return data;
}

/* -------------------------------------------------------------------------- */
/* Sign-in gate                                                               */
/* -------------------------------------------------------------------------- */

async function ensureSession() {
  try {
    const session = await api('/api/session');
    if (session.authenticated) {
      state.approver = session.approver;
      return true;
    }
  } catch {
    /* fall through to the gate */
  }
  showAuthGate();
  return false;
}

function showAuthGate() {
  $('auth-gate').hidden = false;
  $('auth-error').textContent = '';
  setTimeout(() => $('auth-token').focus(), 60);
}

function hideAuthGate() {
  $('auth-gate').hidden = true;
}

async function submitLogin(event) {
  event.preventDefault();
  const token = $('auth-token').value.trim();
  const name = $('auth-name').value.trim();
  if (!token) {
    $('auth-error').textContent = 'Enter the API token.';
    return;
  }

  $('auth-error').textContent = 'Checking the token…';
  try {
    const session = await api('/api/login', {
      method: 'POST',
      body: { token, ...(name ? { name } : {}) },
    });
    state.approver = session.approver;
    $('auth-token').value = '';
    hideAuthGate();
    await loadWorkspace();
    toast(`Signed in as ${session.approver}.`, 'success');
  } catch (error) {
    $('auth-error').textContent = error.message;
  }
}

async function signOut() {
  await api('/api/logout', { method: 'POST' }).catch(() => undefined);
  showAuthGate();
}

function bindAuthEvents() {
  $('auth-form').addEventListener('submit', (event) => void submitLogin(event));
  $('btn-logout').addEventListener('click', () => void signOut());
}

function toast(message, type = 'info') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('toasts').appendChild(element);
  setTimeout(() => element.classList.add('out'), 4200);
  setTimeout(() => element.remove(), 4800);
}

async function withBusy(button, label, task) {
  const originalLabel = button.textContent;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } finally {
    button.disabled = wasDisabled;
    button.textContent = originalLabel;
  }
}

function setChip(id, text, tone) {
  const chip = $(id);
  chip.textContent = text;
  chip.className = `chip${tone ? ` ${tone}` : ''}`;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

function populateVoices() {
  $('voice').innerHTML = VOICES.map(
    (voice) => `<option value="${escapeHtml(voice.id)}">${escapeHtml(voice.label)}</option>`,
  ).join('');
}

function ensureVoiceOption(voiceId) {
  if (!voiceId) return;
  const select = $('voice');
  if ([...select.options].some((option) => option.value === voiceId)) return;
  const option = document.createElement('option');
  option.value = voiceId;
  option.textContent = `${voiceId} (server default)`;
  select.appendChild(option);
}

function applySettingsToForm() {
  const settings = state.settings || {};
  if (settings.niche) $('niche').value = settings.niche;
  if (settings.audience) $('audience').value = settings.audience;
  if (settings.language) $('language').value = settings.language;
  if (settings.length) $('length').value = settings.length;
  if (settings.voice) $('voice').value = settings.voice;
}

function readSettings() {
  state.settings = {
    niche: $('niche').value.trim(),
    audience: $('audience').value.trim(),
    language: $('language').value.trim(),
    length: Number($('length').value) || 700,
    voice: $('voice').value,
  };
  localStorage.setItem(STORAGE.settings, JSON.stringify(state.settings));
  return state.settings;
}

function ensureSettings() {
  const settings = readSettings();
  if (!settings.niche || !settings.audience || !settings.language) {
    throw new Error('Fill in niche, audience and language in Channel setup first.');
  }
  return settings;
}

/* -------------------------------------------------------------------------- */
/* Video workspace                                                            */
/* -------------------------------------------------------------------------- */

function setVideoId(id) {
  state.videoId = id;
  if (id) localStorage.setItem(STORAGE.video, id);
  else localStorage.removeItem(STORAGE.video);
  $('summary-id').textContent = id ? id.slice(0, 8) : '—';
}

async function ensureVideo(topic) {
  if (state.videoId) return state.videoId;
  const settings = ensureSettings();
  const { video } = await api('/api/videos', {
    method: 'POST',
    body: {
      topic: topic || (state.currentTopic && state.currentTopic.title) || 'Untitled video',
      niche: settings.niche,
      audience: settings.audience,
      language: settings.language,
    },
  });
  applyVideo(video);
  return video.id;
}

function assetBadges(video) {
  const items = [
    ['Script', Boolean(video.script)],
    ['Audio', Boolean(video.audio_path)],
    ['Video', Boolean(video.video_path)],
    ['Thumb', Boolean(video.thumbnail_path)],
    ['SEO', Boolean(video.seo_title)],
    ['YT', Boolean(video.youtube_video_id)],
  ];
  return items.map(([label, on]) => `<span class="badge${on ? ' on' : ''}">${label}</span>`).join('');
}

function setVideoLink(url) {
  const link = $('video-link');
  link.href = url;
  link.hidden = false;
}

function applyVideo(video, options = {}) {
  if (!video) return;

  setVideoId(video.id);
  if (!state.currentTopic || state.currentTopic.title !== video.topic) {
    state.currentTopic = { title: video.topic, angle: '', keywords: [] };
  }
  state.uploaded = Boolean(video.youtube_video_id);
  state.approvedAt = video.approved_at;
  state.approvedBy = video.approved_by || null;

  $('summary-topic').textContent = video.topic || '—';
  $('summary-status').textContent = [video.status, video.privacy_status].filter(Boolean).join(' · ');
  $('summary-files').innerHTML = assetBadges(video);

  if (video.script && !options.keepScript) {
    const current = $('script').value.trim();
    if (!current || current === state.script) $('script').value = video.script;
    state.script = video.script;
  }
  updateScriptCount();

  if (video.audio_url) {
    if ($('audio-player').getAttribute('src') !== video.audio_url) $('audio-player').src = video.audio_url;
    $('audio-player').hidden = false;
    $('audio-meta').textContent = `${video.audio_duration ? `${video.audio_duration.toFixed(1)}s` : 'Ready'} · MP3 on server`;
  }

  if (video.video_url) setVideoLink(video.video_url);

  if (video.thumbnail_url) {
    $('thumb-status').textContent = `Saved thumbnail: ${video.thumbnail_url}`;
  }

  if (video.seo_title) {
    state.selectedTitle = video.seo_title;
    const container = $('seo-titles');
    if (container.querySelector('.empty') || !container.querySelector('.title-option.active')) {
      container.innerHTML = `<button type="button" class="title-option active">${escapeHtml(video.seo_title)}</button>`;
    }
    if (document.activeElement !== $('seo-description')) $('seo-description').value = video.seo_description || '';
    if (document.activeElement !== $('seo-tags')) $('seo-tags').value = (video.seo_tags || []).join(', ');
    if (!$('thumb-title').value) {
      $('thumb-title').value = video.seo_title.toUpperCase();
      drawThumbnail();
    }
  }

  if (video.youtube_url) {
    $('upload-result').innerHTML = `<a class="link" href="${escapeHtml(video.youtube_url)}" target="_blank" rel="noreferrer">${escapeHtml(video.youtube_url)}</a> · ${escapeHtml(video.privacy_status || 'uploaded')}`;
  }

  updateApprovalUi();
}

function renderLogs(logs) {
  const list = $('log-list');
  if (!logs || logs.length === 0) {
    list.innerHTML = '<li class="empty">No activity yet.</li>';
    return;
  }

  list.innerHTML = logs
    .map((log) => {
      const status = String(log.status || 'info').toLowerCase();
      const tone = ['success', 'failed', 'warning'].includes(status) ? status : '';
      const time = new Date(log.created_at).toLocaleTimeString();
      return `<li class="${tone}"><time>${escapeHtml(time)} · ${escapeHtml(log.step || '')}</time>${escapeHtml(log.message || '')}</li>`;
    })
    .join('');
}

async function refreshVideo({ silent = false } = {}) {
  if (!state.videoId) return;
  try {
    const data = await api(`/api/videos/${state.videoId}`);
    applyVideo(data.video);
    renderLogs(data.logs);
    renderRecentJob(data.jobs);
  } catch (error) {
    if (!silent) toast(error.message, 'error');
    if (/not found/i.test(error.message)) setVideoId(null);
  }
}

async function loadRecent() {
  const { videos } = await api('/api/videos?limit=6');
  const container = $('recent-list');
  if (!videos.length) {
    container.innerHTML = '<p class="empty">Nothing saved yet.</p>';
    return;
  }

  container.innerHTML = '';
  videos.forEach((video) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<strong>${escapeHtml(video.topic.slice(0, 66))}</strong><br><span>${escapeHtml(video.status)} · ${escapeHtml(new Date(video.created_at).toLocaleString())}</span>`;
    button.addEventListener('click', () => {
      void loadVideo(video.id);
    });
    container.appendChild(button);
  });
}

async function loadVideo(id) {
  setVideoId(id);
  $('script').value = '';
  state.script = '';
  await refreshVideo();
  await loadRecent();
}

/* -------------------------------------------------------------------------- */
/* Health and YouTube                                                         */
/* -------------------------------------------------------------------------- */

function renderHealth(health) {
  state.health = health;

  setChip('chip-db', health.store === 'postgres' ? 'Postgres' : 'Memory DB', health.store === 'postgres' ? 'ok' : 'warn');
  setChip(
    'chip-ffmpeg',
    health.ffmpeg.available ? 'FFmpeg ready' : 'FFmpeg missing',
    health.ffmpeg.available ? 'ok' : 'bad',
  );
  setChip(
    'chip-quota',
    `Uploads ${health.quota.used}/${health.quota.limit}`,
    health.quota.remaining > 0 ? 'ok' : 'bad',
  );
  setChip(
    'chip-scheduler',
    health.scheduler.armed ? `Cron ${health.scheduler.schedule}` : 'Cron off',
    health.scheduler.armed ? 'ok' : 'warn',
  );

  // The newest pipeline_runs row: whether today's run happened, and why it did not. A skip is the
  // schedule working as intended, so only a failure is shown as bad.
  const run = health.pipeline;
  const runTone = !run ? 'warn' : run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'bad' : 'warn';
  setChip('chip-pipeline', run ? `Last run ${run.status}` : 'No run yet', runTone);
  $('chip-pipeline').title = run
    ? [
        `Trigger: ${run.trigger}`,
        `Started: ${new Date(run.startedAt).toLocaleString()}`,
        run.finishedAt ? `Finished: ${new Date(run.finishedAt).toLocaleString()}` : 'Not finished',
        run.reason ? `Reason: ${run.reason}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : 'No pipeline run has been recorded yet.';

  const missing = [];
  if (!health.features.gemini) missing.push('GEMINI_API_KEY');
  if (!health.features.pexels) missing.push('PEXELS_API_KEY');
  if (!health.features.youtube) missing.push('YT_CLIENT_ID + YT_CLIENT_SECRET');
  if (health.store === 'memory') missing.push('DATABASE_URL (storage is temporary)');
  if (!health.ffmpeg.available) missing.push('FFmpeg binary');

  const banner = $('banner');
  if (missing.length) {
    banner.hidden = false;
    banner.textContent = `Setup needed: ${missing.join(' · ')}. Add these to backend/.env and restart the server.`;
  } else {
    banner.hidden = true;
  }

  ensureVoiceOption(health.defaults.voice);
  if (state.settings.voice) $('voice').value = state.settings.voice;
  else if (health.defaults.voice) $('voice').value = health.defaults.voice;
  if (!$('niche').value) $('niche').value = health.defaults.niche;
  if (!$('audience').value) $('audience').value = health.defaults.audience;
  if (!$('language').value) $('language').value = health.defaults.language;
  if (!$('length').value) $('length').value = health.defaults.scriptLength;
}

async function loadHealth() {
  try {
    renderHealth(await api('/api/health'));
  } catch (error) {
    setChip('chip-db', 'API unreachable', 'bad');
    toast(`Cannot reach the API: ${error.message}`, 'error');
  }
}

async function refreshYoutube() {
  const status = await api('/api/youtube/status');
  state.youtubeStatus = status;

  $('yt-status').textContent = !status.configured
    ? 'YouTube not configured'
    : status.connected
      ? `Connected${status.channelId ? ` · ${status.channelId.slice(0, 8)}` : ''}`
      : 'Channel not connected';
  $('btn-yt-connect').disabled = !status.configured;

  setChip(
    'chip-yt',
    !status.configured ? 'YouTube —' : status.connected ? 'YouTube connected' : 'YouTube offline',
    !status.configured ? 'warn' : status.connected ? 'ok' : 'warn',
  );
  setChip(
    'chip-quota',
    `Uploads ${status.quota.used}/${status.quota.limit}`,
    status.quota.remaining > 0 ? 'ok' : 'bad',
  );

  // Shown before approval so the reviewer knows what the upload declares to YouTube.
  $('disclosure-status').textContent = status.syntheticMediaDisclosure
    ? 'Synthetic-media disclosure: ON — this upload is flagged to YouTube as containing altered or synthetic media (AI narration, assembled footage).'
    : 'Warning: YT_DISCLOSE_SYNTHETIC_MEDIA is off — no altered/synthetic media disclosure is sent to YouTube.';

  updateApprovalUi();
}

function updateApprovalUi() {
  const auditPassed = Boolean(state.youtubeStatus && state.youtubeStatus.auditPassed);

  $('btn-approve').disabled = !state.uploaded;
  $('approval-status').textContent = !state.uploaded
    ? 'Upload the video before approving it.'
    : state.approvedAt
      ? `Approved ${new Date(state.approvedAt).toLocaleString()}${state.approvedBy ? ` by ${state.approvedBy}` : ''}.`
      : 'Uploaded and waiting for your approval.';

  $('btn-publish').disabled = !(state.uploaded && state.approvedAt && auditPassed);
  $('publish-note').textContent = !auditPassed
    ? 'Publishing is locked: YT_AUDIT_PASSED is false. Keep uploads private or unlisted until Google approves the compliance audit.'
    : !state.approvedAt
      ? 'Record human approval before publishing.'
      : 'Ready to publish on the connected channel.';
}

/* -------------------------------------------------------------------------- */
/* Topics and script                                                          */
/* -------------------------------------------------------------------------- */

async function generateTopics() {
  const settings = ensureSettings();
  const result = await api('/api/topics', {
    method: 'POST',
    body: { niche: settings.niche, audience: settings.audience, language: settings.language },
  });

  $('topic-source').textContent = result.source === 'gemini' ? 'AI generated' : 'Template fallback';
  const list = $('topic-list');
  list.innerHTML = '';

  if (!result.topics.length) {
    list.innerHTML = '<p class="empty">No topics were returned. Try a broader niche.</p>';
    return;
  }

  result.topics.forEach((topic) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topic';
    button.innerHTML = `<strong>${escapeHtml(topic.title)}</strong><span>${escapeHtml(topic.angle || '')}</span><em>${escapeHtml((topic.keywords || []).join(' · '))}</em>`;
    button.addEventListener('click', () => {
      list.querySelectorAll('.topic').forEach((element) => element.classList.remove('active'));
      button.classList.add('active');
      state.currentTopic = topic;
      $('thumb-title').value = topic.title.toUpperCase();
      if (!$('thumb-badge').value) $('thumb-badge').value = (settings.niche || 'NEW VIDEO').toUpperCase().slice(0, 26);
      drawThumbnail();
      toast('Topic selected. Generate the script to create the draft.', 'success');
    });
    list.appendChild(button);
  });
}

function updateScriptCount() {
  const words = $('script').value.trim().split(/\s+/).filter(Boolean).length;
  $('script-count').textContent = `${words} words`;
}

async function generateScript() {
  const settings = ensureSettings();
  if (!state.currentTopic) throw new Error('Pick a topic first.');

  const videoId = await ensureVideo(state.currentTopic.title);
  const result = await api('/api/script', {
    method: 'POST',
    body: {
      topic: state.currentTopic.title,
      niche: settings.niche,
      audience: settings.audience,
      language: settings.language,
      length: settings.length,
      videoId,
    },
  });

  $('script').value = result.script;
  state.script = result.script;
  updateScriptCount();
  await refreshVideo({ silent: true });
  toast(`Script ready (${result.wordCount} words). Edit it before generating audio.`, 'success');
}

async function saveScript() {
  const script = $('script').value.trim();
  if (!script) throw new Error('The script is empty.');
  if (!state.videoId) throw new Error('Generate a script first.');
  await api(`/api/videos/${state.videoId}`, { method: 'PATCH', body: { script } });
  state.script = script;
  await refreshVideo({ silent: true });
  toast('Script edits saved.', 'success');
}

/* -------------------------------------------------------------------------- */
/* Voiceover                                                                  */
/* -------------------------------------------------------------------------- */

async function generateVoiceover() {
  const settings = ensureSettings();
  const script = $('script').value.trim();
  if (script.length < 50) throw new Error('Add a script before generating the voiceover.');

  const videoId = await ensureVideo((state.currentTopic && state.currentTopic.title) || 'Voiceover draft');
  const result = await api('/api/tts', {
    method: 'POST',
    body: {
      script,
      voice: settings.voice,
      videoId,
      niche: settings.niche,
      audience: settings.audience,
      language: settings.language,
    },
  });

  $('audio-player').src = `${result.audioUrl}?v=${Date.now()}`;
  $('audio-player').hidden = false;
  $('audio-meta').textContent = `${result.provider} · ${result.voice} · ${
    result.durationSeconds ? `${result.durationSeconds.toFixed(1)}s` : 'duration unknown'
  }`;

  await refreshVideo({ silent: true });
  toast('MP3 voiceover ready.', 'success');
}

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

function setProgress(percent, stage) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  $('render-bar').style.width = `${value}%`;
  $('render-percent').textContent = `${value}%`;
  $('render-progress').setAttribute('aria-valuenow', String(value));
  $('render-stage').textContent = stage || 'Working…';
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling(jobId, mode) {
  stopPolling();
  state.jobId = jobId;
  state.lastJobStatus = null;
  localStorage.setItem(STORAGE.job, jobId);
  $('render-job').textContent = `Job ${jobId.slice(0, 8)}${mode ? ` · ${mode}` : ''}`;
  setProgress(0, 'queued');

  const tick = async () => {
    try {
      const data = await api(`/api/status/${jobId}`);
      const job = data.job;
      setProgress(job.progress, job.stage || job.status);
      $('render-job').textContent = `Job ${job.id.slice(0, 8)} · ${job.status}${mode ? ` · ${mode}` : ''}`;

      if (job.status === 'completed' && state.lastJobStatus !== 'completed') {
        state.lastJobStatus = 'completed';
        stopPolling();
        if (data.video && data.video.video_url) setVideoLink(data.video.video_url);
        toast('Render finished. Review the MP4 before uploading.', 'success');
        await refreshVideo({ silent: true });
      } else if (job.status === 'failed' && state.lastJobStatus !== 'failed') {
        state.lastJobStatus = 'failed';
        stopPolling();
        toast(job.error || 'Render failed. Check the activity log.', 'error');
        await refreshVideo({ silent: true });
      }
    } catch (error) {
      if (state.lastJobStatus !== 'poll-error') {
        state.lastJobStatus = 'poll-error';
        toast(error.message, 'error');
      }
    }
  };

  state.pollTimer = setInterval(tick, 2500);
  void tick();
}

function renderRecentJob(jobs) {
  if (!jobs || jobs.length === 0) return;
  const job = jobs[0];
  setProgress(job.progress, job.stage || job.status);
  $('render-job').textContent = `Job ${job.id.slice(0, 8)} · ${job.status}`;

  if ((job.status === 'queued' || job.status === 'active') && !state.pollTimer) {
    startPolling(job.id, job.status === 'queued' ? 'queue' : undefined);
  }
}

async function startRender() {
  if (!state.videoId) throw new Error('Generate the voiceover first.');
  const result = await api('/api/render', { method: 'POST', body: { videoId: state.videoId } });
  startPolling(result.jobId, result.mode);
  toast(`Render job started (${result.mode}).`, 'success');
}

/* -------------------------------------------------------------------------- */
/* SEO                                                                        */
/* -------------------------------------------------------------------------- */

function renderSeo(metadata) {
  state.seo = metadata;
  const container = $('seo-titles');
  container.innerHTML = '';
  state.selectedTitle = metadata.title_options[0] || '';

  metadata.title_options.forEach((title, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `title-option${index === 0 ? ' active' : ''}`;
    button.textContent = title;
    button.addEventListener('click', () => {
      container.querySelectorAll('.title-option').forEach((element) => element.classList.remove('active'));
      button.classList.add('active');
      state.selectedTitle = title;
      $('thumb-title').value = title.toUpperCase();
      drawThumbnail();
    });
    container.appendChild(button);
  });

  $('seo-description').value = metadata.description;
  $('seo-tags').value = metadata.tags.join(', ');
  $('seo-checklist').innerHTML = metadata.upload_checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

  if (state.selectedTitle) {
    $('thumb-title').value = state.selectedTitle.toUpperCase();
    drawThumbnail();
  }
}

async function generateSeo() {
  const settings = ensureSettings();
  if (!state.currentTopic) throw new Error('Pick a topic first.');

  const videoId = await ensureVideo(state.currentTopic.title);
  const metadata = await api('/api/seo', {
    method: 'POST',
    body: {
      topic: state.currentTopic.title,
      niche: settings.niche,
      audience: settings.audience,
      language: settings.language,
      videoId,
    },
  });

  await refreshVideo({ silent: true });
  renderSeo(metadata);
  toast('SEO metadata ready.', 'success');
}

async function saveSeo() {
  if (!state.videoId) throw new Error('No draft to save.');

  const seoTitle = state.selectedTitle || '';
  const seoDescription = $('seo-description').value.trim();
  const seoTags = $('seo-tags').value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 15);

  if (!seoTitle) throw new Error('Select or generate a title first.');

  await api(`/api/videos/${state.videoId}`, {
    method: 'PATCH',
    body: { seoTitle, seoDescription, seoTags },
  });
  await refreshVideo({ silent: true });
  toast('Metadata saved to the draft.', 'success');
}

/* -------------------------------------------------------------------------- */
/* Thumbnail designer                                                         */
/* -------------------------------------------------------------------------- */

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

function drawThumbnail() {
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  const base = PALETTES[$('thumb-palette').value] || PALETTES.midnight;
  const accent = $('thumb-accent').value || base.accent;

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, base.from);
  gradient.addColorStop(1, base.to);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Accent glow
  ctx.save();
  const glow = ctx.createRadialGradient(width * 0.85, height * 0.14, 20, width * 0.85, height * 0.14, 430);
  glow.addColorStop(0, accent);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // Diagonal rule lines
  ctx.save();
  ctx.strokeStyle = base.muted;
  ctx.globalAlpha = 0.14;
  ctx.lineWidth = 2;
  for (let x = -height; x < width; x += 96) {
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x + height, 0);
    ctx.stroke();
  }
  ctx.restore();

  // Accent bar + badge
  ctx.fillStyle = accent;
  ctx.fillRect(72, 92, 12, 118);
  ctx.font = '700 30px Arial, sans-serif';
  ctx.fillText(($('thumb-badge').value || 'NEW VIDEO').toUpperCase().slice(0, 32), 104, 132);

  // Headline with auto-fit sizing
  const headline = ($('thumb-title').value || 'Your video title').toUpperCase();
  let size = 112;
  let lines = [];
  do {
    ctx.font = `900 ${size}px "Arial Black", Arial`;
    lines = wrapCanvasText(ctx, headline, width - 180, 3);
    const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
    if (lines.length <= 3 && widest <= width - 170) break;
    size -= 6;
  } while (size > 52);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = base.text;
  let cursorY = 322;
  lines.forEach((line) => {
    ctx.fillText(line, 78, cursorY);
    cursorY += size * 1.06;
  });
  ctx.restore();

  // Sub-line
  const subtitle = $('thumb-subtitle').value.trim();
  if (subtitle) {
    ctx.font = '500 34px Arial, sans-serif';
    ctx.fillStyle = base.muted;
    ctx.fillText(subtitle.slice(0, 70), 80, 646);
  }

  // Footer
  ctx.font = '600 22px Arial, sans-serif';
  ctx.fillStyle = base.muted;
  ctx.textAlign = 'right';
  ctx.fillText('YT AUTOPILOT', width - 72, 682);
  ctx.textAlign = 'left';
}

async function saveThumbnail() {
  if (!state.videoId) throw new Error('Create a draft first (generate the script or voiceover).');
  const image = $('canvas').toDataURL('image/png');
  const result = await api('/api/thumbnail', {
    method: 'POST',
    body: { videoId: state.videoId, image },
  });
  $('thumb-status').textContent = `Saved thumbnail: ${result.thumbnailUrl}`;
  await refreshVideo({ silent: true });
  toast('Thumbnail saved to the draft.', 'success');
}

function downloadThumbnail() {
  const link = document.createElement('a');
  link.download = `thumbnail-${Date.now()}.png`;
  link.href = $('canvas').toDataURL('image/png');
  link.click();
}

/* -------------------------------------------------------------------------- */
/* Upload, approval and publish                                               */
/* -------------------------------------------------------------------------- */

async function uploadVideo() {
  if (!state.videoId) throw new Error('Nothing to upload yet.');
  if (!$('confirm-review').checked) throw new Error('Tick the review checkbox before uploading.');

  const result = await api('/api/upload', {
    method: 'POST',
    body: { videoId: state.videoId, privacyStatus: $('privacy').value, confirm: true },
  });

  $('upload-result').innerHTML = `<a class="link" href="${escapeHtml(result.url)}" target="_blank" rel="noreferrer">${escapeHtml(result.url)}</a> · ${escapeHtml(result.privacyStatus)}${result.thumbnailApplied ? ' · thumbnail set' : ''}`;
  toast(`Uploaded as ${result.privacyStatus}. Approval is still required to publish.`, 'success');

  await refreshYoutube();
  await refreshVideo({ silent: true });
}

async function approveVideo() {
  if (!state.videoId) throw new Error('Nothing to approve yet.');
  if (!$('confirm-approve').checked) throw new Error('Tick the approval checkbox first.');

  const result = await api(`/api/videos/${state.videoId}/approve`, {
    method: 'POST',
    body: { approved: true },
  });
  state.approvedAt = result.video.approved_at;
  state.approvedBy = result.video.approved_by || null;
  updateApprovalUi();
  await refreshVideo({ silent: true });
  toast('Approval recorded.', 'success');
}

async function publishVideo() {
  if (!state.videoId) throw new Error('No uploaded video.');
  await api(`/api/youtube/publish/${state.videoId}`, {
    method: 'POST',
    body: { confirm: true, privacyStatus: 'public' },
  });
  await refreshVideo({ silent: true });
  toast('Video published.', 'success');
}

/* -------------------------------------------------------------------------- */
/* Events and bootstrap                                                       */
/* -------------------------------------------------------------------------- */

function bind(id, event, handler, busyLabel) {
  const element = $(id);
  element.addEventListener(event, async () => {
    try {
      if (busyLabel) await withBusy(element, busyLabel, handler);
      else await handler();
    } catch (error) {
      toast(error.message || String(error), 'error');
    }
  });
}

function bindEvents() {
  bind('btn-topics', 'click', generateTopics, 'Generating…');
  bind('btn-script', 'click', generateScript, 'Writing…');
  bind('btn-save-script', 'click', saveScript, 'Saving…');
  bind('btn-tts', 'click', generateVoiceover, 'Synthesising…');
  bind('btn-render', 'click', startRender, 'Queueing…');
  bind('btn-seo', 'click', generateSeo, 'Generating…');
  bind('btn-save-seo', 'click', saveSeo, 'Saving…');
  bind('btn-thumb-save', 'click', saveThumbnail, 'Saving…');
  bind('btn-thumb-download', 'click', async () => downloadThumbnail());
  bind('btn-upload', 'click', uploadVideo, 'Uploading…');
  bind('btn-approve', 'click', approveVideo, 'Recording…');
  bind('btn-publish', 'click', publishVideo, 'Publishing…');

  bind('btn-yt-connect', 'click', async () => {
    const { url } = await api('/api/youtube/auth');
    window.location.href = url;
  });

  bind('btn-refresh', 'click', async () => {
    await loadHealth();
    await refreshYoutube().catch(() => undefined);
    await refreshVideo();
    await loadRecent().catch(() => undefined);
    toast('Workspace refreshed.', 'success');
  });

  $('script').addEventListener('input', () => {
    updateScriptCount();
  });

  ['niche', 'audience', 'language', 'length', 'voice'].forEach((id) => {
    $(id).addEventListener('change', () => {
      readSettings();
    });
  });

  ['thumb-title', 'thumb-subtitle', 'thumb-badge', 'thumb-accent'].forEach((id) => {
    $(id).addEventListener('input', drawThumbnail);
  });

  $('thumb-palette').addEventListener('change', () => {
    const palette = PALETTES[$('thumb-palette').value];
    if (palette) $('thumb-accent').value = palette.accent;
    drawThumbnail();
  });

  window.addEventListener('beforeunload', stopPolling);
}

function handleOAuthResult() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get('youtube');
  if (!result) return;

  if (result === 'connected') toast('YouTube channel connected.', 'success');
  else toast(`YouTube connection failed: ${params.get('reason') || 'unknown error'}`, 'error');

  window.history.replaceState({}, '', window.location.pathname);
}

async function init() {
  populateVoices();
  applySettingsToForm();
  bindEvents();
  bindAuthEvents();
  drawThumbnail();
  handleOAuthResult();

  if (!(await ensureSession())) return;
  await loadWorkspace();
}

async function loadWorkspace() {
  await loadHealth();
  await refreshYoutube().catch(() => undefined);
  await loadRecent().catch(() => undefined);

  if (state.videoId) {
    await refreshVideo({ silent: true }).catch(() => undefined);
    if (state.jobId) {
      try {
        const data = await api(`/api/status/${state.jobId}`);
        renderRecentJob([data.job]);
      } catch {
        localStorage.removeItem(STORAGE.job);
      }
    }
  } else {
    setVideoId(null);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
