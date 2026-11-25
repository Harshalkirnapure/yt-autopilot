import { useId } from 'react';

/** Card shell shared by the studio steps and the sidebar. The heading id is generated here, so the
 *  region and its title can never drift apart. */
export function Card({ step, title, headHint, actions, hint, className = '', children }) {
  const headingId = useId();

  return (
    <section className={`card${className ? ` ${className}` : ''}`} aria-labelledby={headingId}>
      <div className="card-head">
        <div>
          {step ? <span className="step">{step}</span> : null}
          <h2 id={headingId}>{title}</h2>
        </div>
        {headHint ? <p className="hint">{headHint}</p> : null}
        {actions ? <div className="head-actions">{actions}</div> : null}
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}
