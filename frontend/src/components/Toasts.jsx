import { useStudio } from '../studio/StudioContext.jsx';

export function Toasts() {
  const { toasts } = useStudio();

  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.type}${toast.leaving ? ' out' : ''}`}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}
