import { KEY_GROUPS } from './deckKeys.ts';
import { Modal } from './Modal.tsx';

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="단축키" onClose={onClose} wide>
      <div className="shortcut-help">
        <p className="shortcut-note">이동·작업 단축키는 입력란 밖에서 사용합니다. 크기 조절과 고정 창 토글(Ctrl ;)은 입력란 안에서도 사용할 수 있습니다. 대문자는 Shift와 함께, gg·gr·DD는 차례로 누르세요. <kbd>?</kbd> 또는 <kbd>Esc</kbd>로 닫습니다.</p>
        <div className="shortcut-groups">
          {KEY_GROUPS.map(({ title, keys }) => (
            <section className="shortcut-group" key={title}>
              <h3>{title}</h3>
              <dl className="keys">
                {keys.map(([key, action, note]) => (
                  <div key={key}>
                    <dt>{key.split(' / ').map((part, i) => <span key={part}>{i > 0 && <span className="key-separator"> / </span>}<kbd>{part}</kbd></span>)}</dt>
                    <dd>{action}{note && <small>{note}</small>}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
