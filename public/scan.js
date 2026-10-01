// In-browser QR scanner for /scan. Uses jsQR so it also works on iOS Safari (no BarcodeDetector there).
(function () {
  var GATE_KEY = 'inf_gate';
  var gate = document.getElementById('gate');
  var video = document.getElementById('video');
  var canvas = document.getElementById('canvas');
  var statusEl = document.getElementById('scan-status');
  var startBtn = document.getElementById('start');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  var stream = null;
  var done = false;

  try {
    gate.value = localStorage.getItem(GATE_KEY) || '';
  } catch (e) {
    // storage unavailable (private mode); the gate just isn't remembered
  }
  gate.addEventListener('change', function () {
    try {
      localStorage.setItem(GATE_KEY, gate.value.trim());
    } catch (e) {
      // storage unavailable (private mode); the gate just isn't remembered
    }
  });

  function tokenFrom(text) {
    var m = String(text).match(/\/p\/([\w-]{16,200})(?:[/?#]|$)/);
    return m ? m[1] : null;
  }

  function stop() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
  }

  function tick() {
    if (done || !stream) return;
    if (video.readyState >= 2) {
      var scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        var token = tokenFrom(code.data);
        if (token) {
          done = true;
          statusEl.textContent = 'Pass found, opening…';
          stop();
          window.location.href = '/p/' + token;
          return;
        }
        statusEl.textContent = 'That QR is not an Infinito pass';
      }
    }
    requestAnimationFrame(tick);
  }

  function start() {
    startBtn.hidden = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      statusEl.textContent = 'This browser cannot use the camera here (needs HTTPS). Use the phone camera app or paste the link below.';
      return;
    }
    statusEl.textContent = 'Starting camera…';
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (s) {
        stream = s;
        video.srcObject = s;
        return video.play();
      })
      .then(function () {
        statusEl.textContent = 'Point the camera at the QR';
        requestAnimationFrame(tick);
      })
      .catch(function (err) {
        stop();
        statusEl.textContent = 'Camera unavailable (' + err.name + '). Allow camera access and tap Start, or paste the link below.';
        startBtn.hidden = false;
      });
  }

  startBtn.addEventListener('click', start);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else if (!done && !stream) start();
  });
  start();
})();
