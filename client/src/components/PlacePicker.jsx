import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import AssetImg from './AssetImg.jsx';
import useModalA11y from '../hooks/useModalA11y.js';
import styles from './PlacePicker.module.css';

/* Which box in the rack a switch is.
 *
 * The camera found rectangles on a photo and gave them names it made up
 * ("Switch U11"); the switch knows exactly what it is and has no idea where it
 * sits. Joining the two is a human judgement, and it used to be asked as a
 * native <select> of invented names — the one control on the screen that could
 * not show the thing it was naming.
 *
 * So: a line that states the current answer, and a sheet that offers two ways
 * to change it. The list is for someone reading positions off the rack; the
 * photo is for someone standing in front of it, who recognises the box faster
 * than any label. Both write the same value.
 */

const label = (d) => `${d.position ? `U${d.position} · ` : ''}${d.name || d.cvClass || 'Device'}`;
const sub = (d) => [d.make && d.make !== 'Unknown' ? d.make : null, d.model, d.portCount ? `${d.portCount} ports` : null]
  .filter(Boolean).join(' · ');

export default function PlacePicker({
  devices = [], image = null, value = '', suggestion = null, takenBy = {}, name = 'this switch', onChange,
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('list');   // 'list' | 'photo'
  const [nat, setNat] = useState(null);       // the photo's own pixel size

  const panelRef = useModalA11y(() => setOpen(false), { active: open });
  const chosen = useMemo(() => devices.find((d) => d.uid === value) || null, [devices, value]);
  const boxed = useMemo(() => devices.filter((d) => Array.isArray(d.box) && d.box.length === 4), [devices]);

  // A photo with no rectangles on it is a picture, not a picker.
  const canPhoto = Boolean(image) && boxed.length > 0;
  useEffect(() => { if (!canPhoto && mode === 'photo') setMode('list'); }, [canPhoto, mode]);

  const pick = (uid) => { onChange(uid); setOpen(false); };

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)}>
        <span className={styles.triggerLabel}>In the rack</span>
        <span className={chosen ? styles.triggerValue : styles.triggerEmpty}>
          {chosen ? label(chosen) : 'Not placed yet'}
        </span>
        {chosen && sub(chosen) && <span className={styles.triggerSub}>{sub(chosen)}</span>}
        <span className={styles.triggerAction} aria-hidden="true">Change</span>
      </button>

      {!chosen && suggestion?.why && (
        <p className={styles.suggest}>The camera suggests one: {suggestion.why}</p>
      )}

      {open && createPortal(
        <div className={styles.scrim} onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div ref={panelRef} className={styles.sheet} role="dialog" aria-modal="true" aria-label={`Where is ${name}`}>
            <div className={styles.sheetHead}>
              <h3>Where is {name}?</h3>
              <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close">✕</button>
            </div>

            {canPhoto && (
              <div className={styles.modes} role="tablist">
                <button type="button" role="tab" aria-selected={mode === 'list'}
                  className={mode === 'list' ? styles.modeOn : styles.mode}
                  onClick={() => setMode('list')}>List</button>
                <button type="button" role="tab" aria-selected={mode === 'photo'}
                  className={mode === 'photo' ? styles.modeOn : styles.mode}
                  onClick={() => setMode('photo')}>On the photo</button>
              </div>
            )}

            <div className={styles.body}>
              {mode === 'photo' ? (
                <div className={styles.photo}>
                  <AssetImg path={image} alt="The rack" className={styles.photoImg}
                    onLoad={(e) => setNat({ w: e.target.naturalWidth, h: e.target.naturalHeight })} />
                  {nat && (
                    <svg className={styles.boxes} viewBox={`0 0 ${nat.w} ${nat.h}`} preserveAspectRatio="xMidYMid meet">
                      {boxed.map((d) => {
                        const [x1, y1, x2, y2] = d.box;
                        const mine = d.uid === value;
                        const other = !mine && takenBy[d.uid];
                        return (
                          <g key={d.uid} className={styles.boxG} onClick={() => pick(d.uid)}>
                            <rect
                              x={x1} y={y1} width={Math.max(1, x2 - x1)} height={Math.max(1, y2 - y1)} rx="4"
                              className={`${styles.box} ${mine ? styles.boxOn : ''} ${other ? styles.boxTaken : ''}`}
                            />
                            {d.position != null && (
                              <text
                                x={x1 + 10} y={y1 + 30}
                                className={`${styles.boxLabel} ${mine ? styles.boxLabelOn : ''}`}
                              >
                                U{d.position}
                              </text>
                            )}
                            <title>{label(d)}{other ? ` — already ${other}` : ''}</title>
                          </g>
                        );
                      })}
                    </svg>
                  )}
                </div>
              ) : (
                <ul className={styles.list}>
                  {devices.map((d) => {
                    const other = d.uid !== value && takenBy[d.uid];
                    return (
                      <li key={d.uid}>
                        <button type="button"
                          className={`${styles.item} ${d.uid === value ? styles.itemOn : ''}`}
                          onClick={() => pick(d.uid)}>
                          <span className={styles.itemName}>{label(d)}</span>
                          <span className={styles.itemSub}>
                            {sub(d) || 'nothing else read off it'}
                            {other ? ` · already ${other}` : ''}
                          </span>
                          {d.uid === value
                            ? <span className={styles.tick} aria-hidden="true">✓</span>
                            : suggestion?.deviceUid === d.uid && <span className={styles.tag}>Suggested</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <button type="button" className={styles.none} onClick={() => pick('')}>
              Not in this rack
            </button>
          </div>
        </div>,
        // Onto the body: the sheet has to cover the tab bar, which is fixed
        // and outside this page's stacking context.
        document.body,
      )}
    </div>
  );
}
