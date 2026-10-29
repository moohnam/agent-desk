import { KEYS } from './deckKeys.ts';
import { Modal } from './Modal.tsx';

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="단축키" onClose={onClose}>
      <dl className="keys">
        {KEYS.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
      </dl>
    </Modal>
  );
}
