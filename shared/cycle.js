/*
 * Assura Elevate: the monthly data cycle for one client.
 * For a month M the Assura team sends the workbook, the client's accountant returns it,
 * the team checks and uploads it (the dashboard updates), and then reviews the month's
 * explanations before the client reads them. Each step has a target day in month M+1;
 * a step past its target is overdue and shows as a reminder. Browser (window.AECycle) and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AECycle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Target day of the following month for each step. Change here to change the firm's calendar.
  const TARGET_DAY = { send: 3, receive: 10, upload: 12, review: 15 };
  const DAY = 86400000;

  // The month being worked on: the last complete calendar month, in Indian time.
  function workingPeriod(now) {
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
    return d.toISOString().slice(0, 7);
  }
  const today = (now) => new Date(now.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);
  const next = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); };
  const target = (period, step) => `${next(period)}-${String(TARGET_DAY[step]).padStart(2, '0')}`;
  const days = (fromIso, now) => Math.floor((now - Date.parse(fromIso)) / DAY);

  /**
   * period: 'YYYY-MM'. now: Date.
   * workbooks: copies issued for this client and month [{ ref, method, sent_to, issued_at, received_at, received_version }].
 *   received_at is set when the team marks the returned copy as received, or when it is uploaded.
   * upload: the live version of the month, or null ({ version, created_at }).
   * review: { drafts: number of suggested explanations, reviewed: number reviewed } or null when the month has no data.
   * Returns { period, steps: [{ key, label, state, target, detail, since }], done, pending, overdue, next }.
   * state: 'done' | 'overdue' | 'due' (target not passed yet) | 'later' (an earlier step is still open).
   */
  function status({ period, now, workbooks, upload, review }) {
    const day = today(now);
    const open = (key) => (day > target(period, key) ? 'overdue' : 'due');
    const sent = (workbooks || []).slice().sort((a, b) => String(a.issued_at).localeCompare(String(b.issued_at)));
    const firstSent = sent[0]; const returned = sent.find((w) => w.received_at || w.received_version);
    const steps = [];
    steps.push(firstSent
      ? { key: 'send', label: 'Workbook sent to the accountant', state: 'done', at: firstSent.issued_at, detail: firstSent.method === 'email' ? `Emailed${firstSent.sent_to ? ' to ' + firstSent.sent_to : ''}` : 'Downloaded and shared' }
      : { key: 'send', label: upload ? 'Data came in without a portal workbook' : 'Send the workbook to the accountant', state: upload ? 'done' : open('send'), detail: null });
    steps.push(upload || returned
      ? { key: 'receive', label: 'Data received from the accountant', state: 'done', at: (returned && returned.received_at) || (upload && upload.created_at) || null }
      : { key: 'receive', label: 'Receive the completed workbook', state: firstSent ? open('receive') : 'later', since: firstSent ? days(firstSent.issued_at, now) : null,
        detail: firstSent ? `Waiting ${Math.max(0, days(firstSent.issued_at, now))} day${days(firstSent.issued_at, now) === 1 ? '' : 's'} since it was sent` : null });
    steps.push(upload
      ? { key: 'upload', label: 'Checked and added to the dashboard', state: 'done', at: upload.created_at, detail: `Version ${upload.version}` }
      : { key: 'upload', label: 'Check and add the data to the dashboard', state: returned ? open('upload') : 'later' });
    if (!upload) steps.push({ key: 'review', label: 'Review the explanations for the client', state: 'later' });
    else if (!review || !review.drafts || review.reviewed >= review.drafts) steps.push({ key: 'review', label: 'Explanations reviewed for the client', state: 'done', detail: review && review.drafts ? `${review.reviewed} reviewed` : 'Nothing material to explain' });
    else steps.push({ key: 'review', label: 'Review the explanations for the client', state: open('review'), detail: `${review.drafts - review.reviewed} of ${review.drafts} still to review` });
    steps.forEach((s) => { s.target = target(period, s.key); });
    const pending = steps.filter((s) => s.state !== 'done');
    return {
      period, steps,
      done: !pending.length,
      pending: pending.filter((s) => s.state !== 'later').length,
      overdue: pending.filter((s) => s.state === 'overdue').length,
      next: pending.find((s) => s.state !== 'later') || null,
    };
  }

  // What a client sees: where their month stands, without names or internal steps.
  function forClient(st) {
    const s = Object.fromEntries(st.steps.map((x) => [x.key, x]));
    if (s.upload.state === 'done') return null; // the dashboard already shows the month
    const on = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    if (s.send.state === 'done') {
      const after = s.receive.state === 'done' ? ' It has been received and is being checked.'
        : s.receive.state === 'overdue' ? ` It has not been returned yet; it was due back by ${on(s.receive.target + 'T00:00:00+05:30')}. Your dashboard updates once it is returned and checked.`
        : ' Your dashboard updates once it is returned and checked.';
      return { period: st.period, text: `The data workbook for this month was sent to your accountant${s.send.at ? ' on ' + on(s.send.at) : ''}.${after}`, waiting: s.receive.state !== 'done', overdue: s.receive.state === 'overdue' };
    }
    return { period: st.period, text: 'Your Assura Elevate team will send this month\'s data workbook to your accountant shortly.', waiting: false, overdue: false };
  }

  return { status, forClient, workingPeriod, today, target, TARGET_DAY };
});
