// Media source loading: images, videos, webcam, drag & drop, paste, demo scene.

export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({
      type: 'image',
      el: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      name: file.name.replace(/\.[^.]+$/, ''),
      url,
    });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

export function loadVideoFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => {
      resolve({
        type: 'video',
        el: video,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
        name: file.name.replace(/\.[^.]+$/, ''),
        url,
      });
    };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load video')); };
    video.src = url;
  });
}

export async function openWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  // videoWidth can still be 0 right after play() — wait for metadata
  if (!video.videoWidth) {
    await new Promise((resolve) => {
      let t = null;
      const poll = setInterval(() => { if (video.videoWidth) settle(); }, 50);
      const settle = () => { clearInterval(poll); clearTimeout(t); resolve(); };
      t = setTimeout(settle, 3000);
    });
  }
  return {
    type: 'webcam',
    el: video,
    width: video.videoWidth,
    height: video.videoHeight,
    name: 'webcam',
    stream,
  };
}

export function loadFile(file) {
  if (file.type.startsWith('video/')) return loadVideoFile(file);
  if (file.type.startsWith('image/')) return loadImageFile(file);
  return Promise.reject(new Error(`Unsupported file type: ${file.type || 'unknown'}`));
}

// Wire drag & drop + clipboard paste. onFile receives a File.
export function bindDropAndPaste(target, onFile) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  target.addEventListener('dragover', (e) => { stop(e); target.classList.add('dragging'); });
  target.addEventListener('dragleave', (e) => { stop(e); target.classList.remove('dragging'); });
  target.addEventListener('drop', (e) => {
    stop(e);
    target.classList.remove('dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) onFile(file);
  });
}

// Procedural demo scene so the app never opens empty.
export function demoImage(w = 1200, h = 800) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.75);
  sky.addColorStop(0, '#0d1b3d');
  sky.addColorStop(0.5, '#93379c');
  sky.addColorStop(0.85, '#ff8c42');
  sky.addColorStop(1, '#ffd166');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // sun
  const sun = ctx.createRadialGradient(w * 0.5, h * 0.62, 10, w * 0.5, h * 0.62, h * 0.28);
  sun.addColorStop(0, '#fff3b0');
  sun.addColorStop(0.35, '#ffd166');
  sun.addColorStop(1, 'rgba(255,140,66,0)');
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.62, h * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffe9a0';
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.62, h * 0.11, 0, Math.PI * 2);
  ctx.fill();

  // mountains
  const ridge = (baseY, amp, color, seedStep) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 8) {
      const y = baseY + Math.sin(x * seedStep) * amp + Math.sin(x * seedStep * 2.7 + 2) * amp * 0.4;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  };
  ridge(h * 0.62, 46, '#3d1d54', 0.008);
  ridge(h * 0.72, 34, '#251038', 0.012);

  // water
  const sea = ctx.createLinearGradient(0, h * 0.75, 0, h);
  sea.addColorStop(0, '#1b2a5e');
  sea.addColorStop(1, '#0a0f24');
  ctx.fillStyle = sea;
  ctx.fillRect(0, h * 0.75, w, h * 0.25);
  ctx.fillStyle = 'rgba(255, 209, 102, 0.5)';
  for (let i = 0; i < 26; i++) {
    const y = h * 0.76 + i * (h * 0.22 / 26);
    const wdt = (h * 0.24 - i * 6) * (0.7 + 0.3 * Math.sin(i * 1.7));
    ctx.fillRect(w * 0.5 - wdt / 2, y, Math.max(8, wdt), 2.5);
  }

  // gradient bar for dither inspection
  const bar = ctx.createLinearGradient(0, 0, w, 0);
  bar.addColorStop(0, '#000');
  bar.addColorStop(1, '#fff');
  ctx.fillStyle = bar;
  ctx.fillRect(0, 0, w, 26);

  return { type: 'image', el: c, width: w, height: h, name: 'demo', isDemo: true };
}
