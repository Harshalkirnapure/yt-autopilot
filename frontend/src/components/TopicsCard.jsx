import { useStudio } from '../studio/StudioContext.jsx';
import { Card } from './Card.jsx';

export function TopicsCard() {
  const { topics, topicSource, currentTopic, generateTopics, selectTopic, busy, run } = useStudio();
  const generated = topicSource !== 'Not generated';

  return (
    <Card
      step="02"
      title="Topic research"
      hint="Previously used topics and footage are excluded automatically."
      actions={
        <>
          <span className="pill">{topicSource}</span>
          <button
            className="btn primary"
            type="button"
            onClick={() => run('topics', generateTopics)}
            disabled={Boolean(busy.topics)}
          >
            {busy.topics ? 'Generating…' : 'Generate 6 topics'}
          </button>
        </>
      }
    >
      <div className="topic-list">
        {topics.length === 0 ? (
          <p className="empty">
            {generated
              ? 'No topics were returned. Try a broader niche.'
              : 'No topics yet. Generate a set, then pick one to start a draft.'}
          </p>
        ) : (
          topics.map((topic, index) => (
            <button
              key={`${topic.title}-${index}`}
              type="button"
              className={`topic${currentTopic?.title === topic.title ? ' active' : ''}`}
              onClick={() => selectTopic(topic)}
            >
              <strong>{topic.title}</strong>
              <span>{topic.angle || ''}</span>
              <em>{(topic.keywords || []).join(' · ')}</em>
            </button>
          ))
        )}
      </div>
    </Card>
  );
}
