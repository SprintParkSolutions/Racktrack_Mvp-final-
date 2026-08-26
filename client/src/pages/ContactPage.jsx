import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { apiUrl, authFetch } from '../utils/api';
import { useAuth } from '../AuthContext';
import Icon from '../components/Icon.jsx';
import styles from './ContactPage.module.css';

const SUPPORT_EMAIL = 'support@racktrack.ai';

// Mirrors the limits the server enforces on /api/support/contact. Checking here
// too is not redundant: a technician on site should be told a 40 MB burst photo
// is too big before it is uploaded over a phone connection, not after.
const MAX_FILES       = 5;
const MAX_FILE_BYTES  = 5  * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const ACCEPT = 'image/*,application/pdf,text/plain,text/csv,application/json';
const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'image/heic', 'image/heif',
  'application/pdf', 'text/plain', 'text/csv', 'application/json',
]);

const prettyBytes = (n) =>
  n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

// Stated plainly, and each one is either true of the product or checkable.
// Deliberately not "10,000+ teams" or a 99.9% figure nobody audits — invented
// numbers are the fastest way for an infrastructure buyer to stop believing
// the rest of the page.
const SIGNALS = [
  { icon: 'group',  label: 'Real human support' },
  { icon: 'clock',  label: 'Replies within a few hours' },
  { icon: 'shield', label: 'Secure & confidential' },
  { icon: 'rack',   label: 'Built for infrastructure teams' },
];

export default function ContactPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  const fromDot = location.state?.context || '';
  const [subject, setSubject] = useState(location.state?.subject || '');
  const [message, setMessage] = useState(
    fromDot ? `I couldn't get an answer to: "${fromDot}"\n\n` : '',
  );
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState(null);
  const [files, setFiles] = useState([]);       // [{ file, url? }]
  const [fileError, setFileError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);

  // Object URLs for the thumbnails are a manual allocation: without the revoke
  // the blobs stay alive for the life of the tab. Removal revokes its own URL,
  // so this only has to catch what is still on screen when the page unmounts —
  // hence the ref. Depending on `files` would revoke the URLs of the surviving
  // items every time the list changed, blanking the previews.
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => {
    filesRef.current.forEach((f) => { if (f.url) URL.revokeObjectURL(f.url); });
  }, []);

  const email = user?.email || 'your account email';
  const canSend = message.trim().length >= 4 && status !== 'sending';
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);

  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    subject || 'Support request',
  )}&body=${encodeURIComponent(message)}`;

  const addFiles = (picked) => {
    const incoming = Array.from(picked || []);
    if (!incoming.length) return;
    setFileError(null);

    const accepted = [];
    const rejected = [];
    let running = totalBytes;

    for (const file of incoming) {
      if (files.length + accepted.length >= MAX_FILES) {
        rejected.push(`${file.name} — at most ${MAX_FILES} files`);
        continue;
      }
      // Some Android pickers hand back an empty type for a file they cannot
      // classify; fall back to the extension rather than rejecting a valid
      // screenshot outright.
      const type = (file.type || '').toLowerCase();
      const looksAllowed = type
        ? ALLOWED_TYPES.has(type)
        : /\.(png|jpe?g|webp|gif|heic|heif|pdf|txt|csv|json|log)$/i.test(file.name);
      if (!looksAllowed) {
        rejected.push(`${file.name} — must be an image, PDF, or text file`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        rejected.push(`${file.name} — ${prettyBytes(file.size)}, over the ${prettyBytes(MAX_FILE_BYTES)} limit`);
        continue;
      }
      if (running + file.size > MAX_TOTAL_BYTES) {
        rejected.push(`${file.name} — would exceed the ${prettyBytes(MAX_TOTAL_BYTES)} total`);
        continue;
      }
      running += file.size;
      accepted.push({ file, url: type.startsWith('image/') ? URL.createObjectURL(file) : null });
    }

    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
    if (rejected.length) setFileError(rejected.join(' · '));
    // Clearing the input lets the same file be re-picked after it was removed;
    // otherwise the change event never fires for an identical selection.
    if (fileInput.current) fileInput.current.value = '';
  };

  const removeFile = (idx) => {
    setFiles((prev) => {
      const gone = prev[idx];
      if (gone?.url) URL.revokeObjectURL(gone.url);
      return prev.filter((_, i) => i !== idx);
    });
    setFileError(null);
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer?.files);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!canSend) return;
    setStatus('sending');
    setError(null);
    try {
      // Multipart only when there is something to attach. A plain message stays
      // on the JSON path it has always used. Deliberately no Content-Type header
      // for the multipart case: the browser has to set it itself so the boundary
      // matches, and supplying one produces a body the server cannot parse.
      const hasFiles = files.length > 0;
      let body;
      const headers = {};
      if (hasFiles) {
        body = new FormData();
        body.append('subject', subject.trim());
        body.append('message', message.trim());
        body.append('context', fromDot);
        files.forEach(({ file }) => body.append('attachments', file, file.name));
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ subject: subject.trim(), message: message.trim(), context: fromDot });
      }

      const res = await authFetch(apiUrl('/api/support/contact'), { method: 'POST', headers, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Couldn't send (HTTP ${res.status}).`);
      setStatus('sent');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const Intro = (
    <section className={styles.intro}>
      <div className={styles.introInner}>
        <div className={styles.introText}>
          <button className={styles.back} onClick={() => navigate(-1)}>
            <Icon name="arrow_back" /> Back
          </button>
          <div className={styles.eyebrow}>Support</div>
          <h1 className={styles.h1}>We&rsquo;re here to help.</h1>
          <p className={styles.lede}>
            Tell us what you&rsquo;re running into. Our team will review the details and get
            back to you as soon as possible.
          </p>
          <ul className={styles.signals}>
            {SIGNALS.map((s) => (
              <li key={s.label} className={styles.signal}>
                <Icon name={s.icon} className={styles.signalIcon} />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
        {/* An <img>, not a CSS background: index.css strips background-image
            from a broad substring allow-list, and a photograph here is content
            for the page rather than decoration for a box. */}
        <div className={styles.media} aria-hidden="true">
          <img src="/hero-rack.jpg" alt="" className={styles.mediaImg} loading="lazy" />
        </div>
      </div>
    </section>
  );

  if (status === 'sent') {
    return (
      <div className={styles.page}>
        {Intro}
        <div className={styles.wrap}>
          <div className={styles.done}>
            <span className={styles.doneMark} aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            </span>
            <div>
              <h2 className={styles.doneH}>Message sent</h2>
              <p className={styles.doneP}>
                Thanks - our team has received your message and will get back to you
                shortly at <strong>{email}</strong>.
              </p>
              <button className={styles.secondary} onClick={() => navigate(-1)}>
                Back to what I was doing
              </button>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {Intro}

      <div className={styles.wrap}>
        <div className={styles.cols}>
          {/* ── Form ── */}
          <form className={styles.form} onSubmit={submit} noValidate>
            <h2 className={styles.formH}>Send us a message</h2>
            <p className={styles.formP}>
              Include as much detail as you can. Screenshots and error messages help us
              resolve issues faster.
            </p>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="ct-subject">
                Subject <span className={styles.optional}>Optional</span>
              </label>
              <input
                id="ct-subject"
                className={styles.input}
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Scan won't upload"
                maxLength={140}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="ct-message">Message</label>
              <textarea
                id="ct-message"
                className={`${styles.input} ${styles.textarea}`}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What happened? What were you doing when it happened? Include any error message or relevant details."
                maxLength={5000}
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="contact-attachments">
                Attachments <span className={styles.optional}>Optional</span>
              </label>

              <input
                id="contact-attachments"
                ref={fileInput}
                type="file"
                className={styles.fileInput}
                accept={ACCEPT}
                multiple
                onChange={(e) => addFiles(e.target.files)}
              />

              {/* Drop target and picker in one. A button rather than a label so
                  the keyboard path is the same as the pointer path. */}
              <button
                type="button"
                className={`${styles.drop} ${dragging ? styles.dropOver : ''}`}
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                disabled={files.length >= MAX_FILES}
              >
                <Icon name="paperclip" className={styles.dropIcon} />
                <span className={styles.dropText}>
                  <span className={styles.dropLead}>
                    {files.length >= MAX_FILES
                      ? `Maximum of ${MAX_FILES} files attached`
                      : 'Attach screenshots, logs, or other files'}
                  </span>
                  <span className={styles.dropMeta}>
                    Up to {MAX_FILES} files · {prettyBytes(MAX_FILE_BYTES)} each
                  </span>
                </span>
              </button>

              {files.length > 0 && (
                <ul className={styles.fileList}>
                  {files.map((f, i) => (
                    <li key={`${f.file.name}-${i}`} className={styles.fileRow}>
                      {f.url
                        ? <img src={f.url} alt="" className={styles.thumb} />
                        : <span className={styles.thumbDoc} aria-hidden="true"><Icon name="book" /></span>}
                      <span className={styles.fileMeta}>
                        <span className={styles.fileName}>{f.file.name}</span>
                        <span className={styles.fileSize}>{prettyBytes(f.file.size)}</span>
                      </span>
                      <button
                        type="button"
                        className={styles.fileRemove}
                        onClick={() => removeFile(i)}
                        aria-label={`Remove ${f.file.name}`}
                      >
                        <Icon name="close" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {files.length > 0 && (
                <div className={styles.fileTotal}>
                  {files.length} of {MAX_FILES} · {prettyBytes(totalBytes)} of {prettyBytes(MAX_TOTAL_BYTES)}
                </div>
              )}

              {fileError && <p className={styles.fileWarn}>{fileError}</p>}
            </div>

            {status === 'error' && (
              <div className={styles.errorBox} role="alert">
                <strong className={styles.errorH}>We couldn&rsquo;t send your message.</strong>
                <span className={styles.errorP}>
                  {error} Please try again, or email{' '}
                  <a href={mailto} className={styles.link}>{SUPPORT_EMAIL}</a>.
                </span>
              </div>
            )}

            <div className={styles.actions}>
              <button type="submit" className={styles.send} disabled={!canSend}>
                {status === 'sending' ? 'Sending…' : 'Send message →'}
              </button>
              {!canSend && status !== 'sending' && (
                <span className={styles.hint}>Add a message to send.</span>
              )}
            </div>
          </form>

          {/* ── Rail ── */}
          <aside className={styles.rail}>
            <section className={styles.block}>
              <h2 className={styles.blockH}>Other ways to reach us</h2>
              <div className={styles.options}>
                {/* /help is the DOT assistant — see the route table in
                    DesktopShell, which titles it "Ask DOT". A separate
                    "Documentation" row was specified for this rail, but this
                    build has no docs route and no external docs URL, and DOT
                    answers from the same verified documentation. A third row
                    pointing at /help would be the same destination wearing a
                    different name; add it here when a docs URL exists. */}
                <button type="button" className={styles.option} onClick={() => navigate('/help')}>
                  <Icon name="chat" className={styles.optionIcon} />
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>Ask DOT</span>
                    <span className={styles.optionSub}>
                      Get a quick answer from our support assistant, drawn from verified documentation
                    </span>
                  </span>
                  <Icon name="chevron_right" className={styles.optionGo} />
                </button>

                <a className={styles.option} href={mailto}>
                  <Icon name="mail" className={styles.optionIcon} />
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>Email support</span>
                    <span className={styles.optionSub}>{SUPPORT_EMAIL}</span>
                    <span className={styles.optionSub}>Replies within a few hours</span>
                  </span>
                  <Icon name="chevron_right" className={styles.optionGo} />
                </a>
              </div>
            </section>

            <section className={styles.block}>
              <h2 className={styles.blockH}>What happens next?</h2>
              <ol className={styles.steps}>
                <li className={styles.step}>
                  <span className={styles.stepNum}>1</span>
                  <span className={styles.stepText}>
                    <span className={styles.stepName}>We receive your message</span>
                    <span className={styles.stepSub}>We review the details you&rsquo;ve shared.</span>
                  </span>
                </li>
                <li className={styles.step}>
                  <span className={styles.stepNum}>2</span>
                  <span className={styles.stepText}>
                    <span className={styles.stepName}>We investigate</span>
                    <span className={styles.stepSub}>We gather the information needed to understand the issue.</span>
                  </span>
                </li>
                <li className={styles.step}>
                  <span className={styles.stepNum}>3</span>
                  <span className={styles.stepText}>
                    <span className={styles.stepName}>We get back to you</span>
                    <span className={styles.stepSub}>We&rsquo;ll reply with next steps or a resolution.</span>
                  </span>
                </li>
              </ol>
            </section>
          </aside>
        </div>
      </div>

      <Footer />
    </div>
  );
}

// Privacy / Terms / Security belong here, but this build has no route for any
// of them and no marketing-site URL to point at — every candidate path 404s.
// Dead links on the page a customer reaches when they already distrust
// something cost more than the missing row does, so the footer carries the
// notice only. Fill these in and the nav below renders itself:
//
//   const LEGAL = [
//     { label: 'Privacy',  href: 'https://racktrack.ai/privacy'  },
//     { label: 'Terms',    href: 'https://racktrack.ai/terms'    },
//     { label: 'Security', href: 'https://racktrack.ai/security' },
//   ];
const LEGAL = [];

function Footer() {
  return (
    <footer className={styles.foot}>
      <div className={styles.footInner}>
        <span className={styles.footCopy}>© 2026 RackTrack. All rights reserved.</span>
        {LEGAL.length > 0 && (
          <nav className={styles.footLinks}>
            {LEGAL.map((l, i) => (
              <span key={l.label} className={styles.footLink}>
                {i > 0 && <span aria-hidden="true">·</span>}
                <a href={l.href}>{l.label}</a>
              </span>
            ))}
          </nav>
        )}
      </div>
    </footer>
  );
}
