import { useRef } from 'react';
import styles from '../pages/AuthPages.module.css';

/**
 * The password rules and the six-box code entry.
 *
 * These lived in SignupPage, which is not reachable any more — accounts are
 * given out by an administrator. Forgot-password still needs both, and an
 * archived page is a strange thing to import from, so they live here on their
 * own. The stylesheet stays AuthPages.module.css: these are auth controls and
 * they should look like the rest of that flow.
 */

export const PW_RULES = [
  { id: 'len',   label: '8 characters',   test: pw => pw.length >= 8 },
  { id: 'upper', label: 'an uppercase',   test: pw => /[A-Z]/.test(pw) },
  { id: 'lower', label: 'a lowercase',    test: pw => /[a-z]/.test(pw) },
  { id: 'digit', label: 'a digit',        test: pw => /[0-9]/.test(pw) },
  { id: 'spec',  label: 'a special char', test: pw => /[^A-Za-z0-9]/.test(pw) },
];
export const STRENGTH_COLORS = ['#b42318', '#b42318', '#b54708', '#b54708', '#067647', '#067647'];

export function CodeGrid({ value, onChange, disabled }) {
  const refs = useRef([]);
  const digits = value.padEnd(6, ' ').split('').slice(0, 6);

  const setDigit = (i, ch) => {
    const cleaned = String(ch).replace(/\D/g, '');
    // OS one-time-code autofill (or typing/pasting several digits) drops the
    // whole code into one cell — spread it across the grid instead of dropping it.
    if (cleaned.length > 1) {
      onChange(cleaned.slice(0, 6));
      refs.current[Math.min(cleaned.length, 6) - 1]?.focus();
      return;
    }
    const next = value.padEnd(6, ' ').split('');
    next[i] = cleaned || ' ';
    onChange(next.join('').replace(/\s/g, ''));
    if (cleaned && i < 5) refs.current[i + 1]?.focus();
  };

  const handleKey = (i, e) => {
    if (e.key === 'Backspace' && !digits[i].trim() && i > 0) {
      refs.current[i - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      refs.current[i - 1]?.focus(); e.preventDefault();
    } else if (e.key === 'ArrowRight' && i < 5) {
      refs.current[i + 1]?.focus(); e.preventDefault();
    }
  };

  const handlePaste = (e) => {
    const pasted = (e.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    onChange(pasted);
    refs.current[Math.min(pasted.length, 5)]?.focus();
  };

  return (
    <div className={styles.codeGrid} onPaste={handlePaste}>
      {[0,1,2,3,4,5].map(i => (
        <input
          key={i}
          ref={el => refs.current[i] = el}
          className={`${styles.codeCell} ${digits[i].trim() ? styles.codeCellFilled : ''}`}
          type="text" inputMode="numeric" maxLength="6"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          value={digits[i].trim()}
          disabled={disabled}
          onChange={e => setDigit(i, e.target.value)}
          onKeyDown={e => handleKey(i, e)}
          onFocus={e => e.target.select()}
          aria-label={`Digit ${i + 1}`}
        />
      ))}
    </div>
  );
}
