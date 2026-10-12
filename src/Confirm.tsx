import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Modal } from './ui';
const Confirmation = createContext<(message: string) => Promise<boolean>>(
  async () => false,
);
export const useConfirm = () => useContext(Confirmation);
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef<((value: boolean) => void) | null>(null);
  useEffect(() => () => pending.current?.(false), []);
  function finish(value: boolean) {
    pending.current?.(value);
    pending.current = null;
    setMessage(null);
  }
  return (
    <Confirmation.Provider
      value={(message) =>
        new Promise((resolve) => {
          pending.current?.(false);
          pending.current = resolve;
          setMessage(message);
        })
      }
    >
      {children}
      {message && (
        <Modal title="Confirm action" onClose={() => finish(false)}>
          <p>{message}</p>
          <div className="modal-actions">
            <button className="button" onClick={() => finish(false)}>
              Cancel
            </button>
            <button className="button primary" onClick={() => finish(true)}>
              Confirm
            </button>
          </div>
        </Modal>
      )}
    </Confirmation.Provider>
  );
}
