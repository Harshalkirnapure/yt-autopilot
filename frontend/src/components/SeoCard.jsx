import { useStudio } from '../studio/StudioContext.jsx';
import { Card } from './Card.jsx';

export function SeoCard() {
  const {
    titleOptions,
    selectedTitle,
    seoForm,
    updateSeoForm,
    checklist,
    selectTitle,
    generateSeo,
    saveSeo,
    busy,
    run,
  } = useStudio();

  return (
    <Card
      step="06"
      title="SEO metadata"
      actions={
        <>
          <button
            className="btn"
            type="button"
            onClick={() => run('seo', generateSeo)}
            disabled={Boolean(busy.seo)}
          >
            {busy.seo ? 'Generating…' : 'Generate metadata'}
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => run('saveSeo', saveSeo)}
            disabled={Boolean(busy.saveSeo)}
          >
            {busy.saveSeo ? 'Saving…' : 'Save metadata'}
          </button>
        </>
      }
    >
      <div className="subhead">Title options</div>
      <div className="title-options">
        {titleOptions.length === 0 ? (
          <p className="empty">Generate metadata to see title options.</p>
        ) : (
          titleOptions.map((title, index) => (
            <button
              key={`${title}-${index}`}
              type="button"
              className={`title-option${title === selectedTitle ? ' active' : ''}`}
              onClick={() => selectTitle(title)}
            >
              {title}
            </button>
          ))
        )}
      </div>

      <label className="field">
        <span>Description</span>
        <textarea
          rows={7}
          placeholder="Description with hashtags…"
          value={seoForm.description}
          onChange={(event) => updateSeoForm({ description: event.target.value })}
        />
      </label>

      <label className="field">
        <span>Tags (comma separated)</span>
        <input
          type="text"
          placeholder="personal finance, budgeting, savings"
          value={seoForm.tags}
          onChange={(event) => updateSeoForm({ tags: event.target.value })}
        />
      </label>

      <div className="subhead">Pre-publish checklist</div>
      <ul className="checklist">
        {checklist.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </Card>
  );
}
