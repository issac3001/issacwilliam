/* Assura Elevate website: enquiry form and phone menu. No tracking, no third-party scripts. */
(function () {
  'use strict';
  // The phone menu closes after a section is chosen.
  document.querySelectorAll('.menu-panel a').forEach((a) => a.addEventListener('click', () => a.closest('details').removeAttribute('open')));

  // The enquiry goes to the firm's mailbox through the visitor's own email app.
  const form = document.getElementById('enquiry');
  if (!form) return;
  const to = (document.querySelector('[data-contact-email]') || {}).textContent || '';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = [
      `Name: ${f.name}`, `Role: ${f.role || '-'}`, `Company: ${f.company}`, `Annual turnover: ${f.turnover}`,
      `Email: ${f.email}`, `Phone: ${f.phone || '-'}`, '', f.message || '',
    ].join('\n');
    location.href = `mailto:${to.trim()}?subject=${encodeURIComponent(`Enquiry from ${f.company}`)}&body=${encodeURIComponent(body)}`;
    document.getElementById('q-note').textContent = `If your email app did not open, write to ${to.trim()}.`;
  });
})();
