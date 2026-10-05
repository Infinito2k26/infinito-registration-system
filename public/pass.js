// Pass page: send the gate chosen on /scan with the entry, and block double taps on MARK ENTERED.
(function () {
  var gate = '';
  try {
    gate = localStorage.getItem('inf_gate') || '';
  } catch (e) {
    // storage unavailable (private mode); the gate just isn't remembered
  }
  document.querySelectorAll('.gate-field').forEach(function (input) {
    input.value = gate;
  });
  document.querySelectorAll('form.enter-form').forEach(function (form) {
    form.addEventListener('submit', function () {
      var button = form.querySelector('button');
      if (button) {
        button.disabled = true;
        button.textContent = 'Marking…';
      }
    });
  });
  // Document previews: a file that is not an image (e.g. a PDF) is left to its "View ..." link.
  document.querySelectorAll('.doc-preview img').forEach(function (img) {
    function hide() {
      img.parentNode.hidden = true;
    }
    // Already failed before this script ran (a lazy image not yet requested has no currentSrc).
    if (img.complete && img.currentSrc && img.naturalWidth === 0) hide();
    else img.addEventListener('error', hide);
  });
})();
