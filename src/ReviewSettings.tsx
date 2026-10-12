import { useEffect, useState } from 'react';
import { QuickLabelsTab } from '@plannotator/ui/components/settings/QuickLabelsTab';
import { Modal, ErrorMessage } from './ui';

export default function ReviewSettings({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const failed = () =>
      setError(
        'Browser storage is unavailable. Label changes apply for this session but will not survive reload.',
      );
    window.addEventListener('pw-label-storage-error', failed);
    return () => window.removeEventListener('pw-label-storage-error', failed);
  }, []);
  return (
    <Modal title="Custom labels" onClose={onClose}>
      <p className="muted small">
        Personal presets, saved automatically for your account in this browser.
        Changing a preset does not change feedback already posted. Instruction
        tips are included in exported feedback.
      </p>
      <ErrorMessage message={error} />
      <div className="custom-label-settings">
        <QuickLabelsTab />
      </div>
    </Modal>
  );
}
