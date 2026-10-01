// Pass page: send the gate chosen on /scan with the entry, and block double taps on MARK ENTERED.
(function () {
  var gate = '';
  try {
    gate = localStorage.getItem('inf_gate') || '';
  } catch (e) {}
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
})();
